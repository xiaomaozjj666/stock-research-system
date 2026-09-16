/**
 * 股票列表 / 搜索 / 横向对比。
 */
import { Router } from 'express';
import {
  searchLimiter,
  compareLimiter,
  metaLimiter,
  circuitBreakerGuard,
  respondIfQueueTimeout,
} from '../middleware.js';
import { getSupportedStocks, searchStocks } from '../services/dataService.js';
import { runAnalysis } from '../services/analysisPipeline.js';
import { isQueueTimeoutError } from '../utils/limitGate.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';

const router = Router();

// 获取支持的股票列表
// 列表由多个面板/下拉共用（证券主数据全表，可能触发上游抓取），故用 metaLimiter(30/min)：
// 页面挂载即请求的只读元数据不该与分析类 10/min 配额互抢。
router.get('/api/stocks', metaLimiter, async (_req, res) => {
  try {
    const stocks = await getSupportedStocks();
    res.json(stocks);
  } catch (error) {
    logger.warn('获取股票列表失败，返回兜底数据', { err: error });
    res.json([{ code: '600519', name: '贵州茅台', industry: '白酒' }]);
  }
});

// 关键词长度上限：兜底模糊匹配会对全表 5000+ 只股票逐只做最长公共子串 DP
// （O(|q|·|name|)），超长关键词会长时间阻塞事件循环（实测 1500 汉字约 0.5s），
// 故在路由层直接拒绝，避免单个请求拖慢所有并发请求。
const MAX_KEYWORD_LENGTH = 32;

// 搜索股票
router.get('/api/stocks/search', searchLimiter, async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword || typeof keyword !== 'string') {
      return res.status(400).json({ error: '请提供搜索关键词' });
    }
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return res.status(400).json({ error: `搜索关键词过长（上限 ${MAX_KEYWORD_LENGTH} 个字符）` });
    }
    const results = await searchStocks(keyword);
    res.json(results);
  } catch (error) {
    // 只记关键词长度、不记关键词本身：搜索词是用户输入（可能是人名），
    // 与请求日志/span 的脱敏口径一致（见 utils/logSanitize.ts）。
    // 注意 keyword 是 try 块内的 const，catch 里取不到，故从 req.query 重取并做类型收敛
    const rawKeyword = req.query.keyword;
    logger.warn('股票搜索失败，返回空结果', {
      keywordLength: typeof rawKeyword === 'string' ? rawKeyword.length : undefined,
      err: error,
    });
    res.json([]);
  }
});

/** 对比中单只标的的失败项：code 回填请求代码（不依赖错误信息），error 为可读中文 */
interface CompareFailure {
  code: string;
  error: string;
  /** 机器可读失败原因（如 DATA_UNAVAILABLE / LLM_QUEUE_TIMEOUT），供前端按需区分；可缺省 */
  errorCode?: string;
}

/**
 * 携带「错误种类 + 哪只股票 + 可读原因」的失败包装。
 * allSettled 的 reason 只是一个裸错误对象，而本路由既要回填股票代码、又不能把原始
 * message 透给客户端，故在捕获点就地封装。
 */
class CompareFailureError extends Error {
  /** 机器可读错误码（对外 failures[].code）；排队超时时与 QueueTimeoutError.code 同值 */
  code: string;
  readonly reason: string;
  /** 失败标的的股票代码（内部用：日志与"哪只失败"定位，不随 failures 回传） */
  readonly stockCode: string;
  /**
   * 是否需要整批按 429 退避。
   * LLM 闸门排队超时是**系统级繁忙**（闸门被别的请求占满），不是这只股票的数据问题：
   * 此刻整批都在排队，回 200 + failures 会让客户端以为"这只股票有问题"、立刻重试，
   * 反而把闸门压得更死。故这类失败仍走既有 429 + Retry-After 语义。
   */
  readonly queueTimeout: boolean;
  /** 排队超时的建议退避时长（毫秒），供 429 的 Retry-After 使用 */
  retryAfterMs?: number;

  constructor(code: string, reason: string, queueTimeout: boolean, stockCode: string) {
    super(reason);
    this.name = 'CompareFailureError';
    this.code = code;
    this.reason = reason;
    this.queueTimeout = queueTimeout;
    this.stockCode = stockCode;
  }
}

/**
 * 把原错误上的「机器可读错误码 + retryAfterMs」复制到失败包装上。
 *
 * 为什么必须复制：`respondIfQueueTimeout` 用 `isQueueTimeoutError` 判断（先 instanceof、
 * 再按 `code === 'LLM_QUEUE_TIMEOUT'` 鸭子类型），并用 `error.retryAfterMs` 写
 * Retry-After。包装对象若丢掉这两个字段，排队超时会被当成普通失败回 200，
 * "系统繁忙请退避"的 429 契约就静默消失了（实测踩到过）。
 */
function copyQueueTimeoutFields(from: unknown, to: CompareFailureError): void {
  const src = from as { code?: unknown; retryAfterMs?: unknown; retryAfterSeconds?: unknown };
  to.code = typeof src?.code === 'string' ? src.code : 'LLM_QUEUE_TIMEOUT';
  if (typeof src?.retryAfterMs === 'number') to.retryAfterMs = src.retryAfterMs;
  else if (typeof src?.retryAfterSeconds === 'number') {
    to.retryAfterMs = Math.max(1, Math.ceil(src.retryAfterSeconds)) * 1000;
  } else {
    to.retryAfterMs = 60_000; // 两个字段都缺时的保守兜底：提示 60 秒后退避
  }
}

/**
 * 把单只标的的失败翻译成「可读中文 + 稳定错误码」。
 *
 * 为什么不复用 500 分支那套 detail：`e.message` 会带上游 URL、文件路径、内部标识
 * （如 dataService 的 `无法获取股票数据: 000858，<上游原文>`），而失败原因要逐只回传、
 * 前端会直接渲染，等于把 detail 泄漏面从「1 条」放大到「每只 1 条」。因此这里只做
 * 「已知类型 → 固定中文」，未知错误一律归到稳定兜底文案：定位问题看服务端日志
 * （失败原因已按 route/stockCode/err 记入 logger.warn），不回传原始 message。
 */
function toReadableFailure(error: unknown): { code: string; error: string; queueTimeout: boolean } {
  if (isQueueTimeoutError(error)) {
    // 系统繁忙，可稍后退避重试：仍按 429 处理（见 CompareFailureError.queueTimeout）
    return {
      code: 'LLM_QUEUE_TIMEOUT',
      error: 'LLM 繁忙排队超时，请稍后重试',
      queueTimeout: true,
    };
  }
  if (error instanceof Error) {
    if (error.message === 'SSE_CLIENT_DISCONNECTED') {
      // 单只分析的 SSE 订阅者断开：批量场景下极罕见（对比走 POST 无订阅者）
      return { code: 'STREAM_DISCONNECTED', error: '分析连接中断，请重试', queueTimeout: false };
    }
    if (/无法获取股票数据|数据不足|行情|停牌/.test(error.message)) {
      return {
        code: 'DATA_UNAVAILABLE',
        error: '行情或财务数据不可用（可能已停牌或数据源异常）',
        queueTimeout: false,
      };
    }
  }
  return { code: 'ANALYSIS_FAILED', error: '该股分析未完成，请稍后重试', queueTimeout: false };
}

// 股票对比接口
router.post('/api/compare', compareLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const { stockCodes } = req.body;
    if (!Array.isArray(stockCodes) || stockCodes.length < 2 || stockCodes.length > 3) {
      return res.status(400).json({ error: '请选择2-3只股票进行对比' });
    }
    for (const code of stockCodes) {
      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: `无效的股票代码：${code}` });
      }
    }
    // 逐只容错并行分析（每只 1~3 分钟）：改用 allSettled，任一标的失败只把它自己
    // 记入 failures，其余标的的结果照常返回。此前用 Promise.all，一只失败即整批 500，
    // 另外两只已经跑完的分钟级结果被直接丢弃，用户只能整批重试——这是本次 P0 修复点。
    //
    // 注意：map 回调里同步 throw（runAnalysis 若改为同步校验）会绕过 allSettled，
    // 故统一包成 Promise.resolve().then(...)，让同步抛错也变成 rejected 结果。
    const settled = await Promise.allSettled(
      stockCodes.map((code: string) =>
        Promise.resolve()
          .then(() => runAnalysis(code))
          .catch((error: unknown) => {
            // 失败原因只在服务端留档：响应里只给可读中文（见 toReadableFailure）
            logger.warn('对比：单只分析失败，按部分成功继续', {
              route: '/api/compare',
              stockCode: code,
              err: error,
            });
            const readable = toReadableFailure(error);
            const failure = new CompareFailureError(
              readable.code,
              readable.error,
              readable.queueTimeout,
              code,
            );
            // 排队超时要把原错误上的「机器可读错误码 + retryAfterMs」一并带到失败对象上：
            // 路由末尾要靠它们决定 429 与 Retry-After（否则 429 语义会丢失）
            if (readable.queueTimeout) copyQueueTimeoutFields(error, failure);
            throw failure;
          }),
      ),
    );

    const stocks: unknown[] = [];
    const failures: CompareFailure[] = [];
    /** 首个排队超时的原始错误：429 分支要用它的 retryAfterMs 写 Retry-After */
    let queueTimeoutReason: unknown;
    settled.forEach((item, index) => {
      const code = stockCodes[index] as string;
      if (item.status === 'fulfilled') {
        // 顺序与请求一致，但只含成功项（失败的靠 failures 单独回传）
        stocks.push(item.value.stock_pool[0]);
        return;
      }
      const err = item.reason as { code?: unknown; reason?: unknown; queueTimeout?: unknown };
      if (err?.queueTimeout === true && queueTimeoutReason === undefined) {
        queueTimeoutReason = item.reason;
      }
      // code 必须是**请求里的股票代码**（前端要按它定位是哪只失败）；
      // 机器可读原因另放 errorCode —— 曾把错误码当 code 回传，导致前端拿不到"哪只失败"
      const errorCode = typeof err?.code === 'string' ? err.code : undefined;
      failures.push({
        code,
        error: typeof err?.reason === 'string' ? err.reason : '该股分析未完成，请稍后重试',
        ...(errorCode ? { errorCode } : {}),
      });
    });

    // 系统级繁忙（LLM 闸门排队超时）：回既有 429 + Retry-After，不按"部分成功"返回。
    // 理由：闸门超时是**系统繁忙**而非"这只股票有问题"，回 200 会让客户端立刻重试，
    // 把已满的闸门压得更死；429 才是"稍后退避整批重试"的正确信号。
    // 代价（有意接受）：这里不再回传已完成标的的结果，用户按 Retry-After 重试整批——
    // 但排队超时意味着请求根本没进闸门、本来就没跑出结果，且 429 语义优先于省一次重试。
    if (queueTimeoutReason !== undefined) {
      // 沿用 respondIfQueueTimeout 构造响应：保证 429 的响应体/头与其它路由完全一致
      // （不另造一套 429 格式；非闸门错误返回 false，继续走下面的部分成功返回）
      if (respondIfQueueTimeout(res, queueTimeoutReason, '/api/compare')) return;
    }

    // 向后兼容：全部成功时不出现 failures 字段，响应与改动前逐字一致（老客户端零改动）。
    // 全部失败时仍返回 200 + stocks: []，不改成 502/500 —— 理由：
    //   1) 请求本身完全合法，失败只发生在逐只分析阶段（与 /api/stocks、/api/stocks/search
    //      的"上游失败降级、不回错误码"同一风格）；
    //   2) 每只的失败原因必须逐只回传，502/500 只能给一条整体 error，前端就丢了"哪只为什么失败"；
    //   3) 前端据此走统一分支：stocks 为空 → 既有整体报错路径（不渲染空表格）；非空 → 部分成功视图。
    //      即前端只需看 failures 是否非空，无需按状态码分支。
    //   老客户端遇到全失败看到的是 200 + stocks: []（空结果），比 500 更易读、也不会崩。
    res.json(failures.length > 0 ? { stocks, failures } : { stocks });
  } catch (error: unknown) {
    logger.error('Compare error', {
      route: '/api/compare',
      stockCodes: req.body?.stockCodes,
      err: error,
    });
    // 走到这里只剩"路由自身异常"（逐只失败已被 allSettled 捕获）：429/500 是防御性兜底，
    // 且 500（error='对比分析失败'）仍是对外契约的一部分
    if (respondIfQueueTimeout(res, error, '/api/compare')) return;
    // detail 只在非生产环境回传：路由内 catch 不经过 index.ts 的通用错误中间件，
    // 若无条件回传，生产环境会把上游 URL / 内部路径随错误一起泄漏出去
    // （口径统一在 utils/errorDetail.ts，与其余路由共用同一实现）
    res.status(500).json({ error: '对比分析失败', detail: errorDetail(error) });
  }
});

export default router;

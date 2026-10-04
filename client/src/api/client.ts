import axios from 'axios';
// 端点级类型全部由契约生成（见 api/generated.ts，头部有「请勿手改」告警）。
// 这里的 import 不是可选的便利：泛型写错会在 tsc 立刻报错，而契约改动后忘记
// 重新生成会被 `npm run check:api-types`（CI 门禁）拦下——这正是本项目此前
// 「契约与前端各写一份、必然分叉」的解法。
import type {
  IntlKline as GeneratedIntlKline,
  GETApiStocksResponse as StockListResponse,
  GETApiStocksSearchResponse as StockSearchResponse,
  POSTApiPaperSettleResponse as PaperSettleResponse,
  GETApiAuditResponse as AuditQueryResponse,
  GETApiHistoryResponse as HistoryListResponse,
  GETApiIntlKlinesResponse as IntlKlinesResponse,
  GETApiDocumentsResponse as DocumentListResponse,
  GETApiModelsResponse as ModelRoutingResponse,
  GETApiCostResponse as CostResponse,
  POSTApiCostResetResponse as OkResponse,
  POSTApiChatHistoryClearResponse as ClearHistoryResponse,
  DELETEApiHistoryIdResponse as DeleteHistoryResponse,
} from './generated';
import type {
  AnalysisResult,
  AuditQueryFilter,
  CompareResponse,
  HistoryItem,
  HistorySummary,
  IntlFundamentalsResult,
  IntlMarket,
  PaperOrder,
  PaperOrderInput,
  PaperPortfolio,
  PaperStats,
  WatchlistMonitorResult,
} from '../types';
// 量化三类响应体由页面层定义（页面才是消费方），此处只引用不复制，
// 避免同一形状在两处各写一遍后悄悄分叉。
import type {
  CompositeAlphaBatchResult,
  CrossSectionResult,
  QuantResearchReport,
} from '../pages/quant/types';
import { getApiToken, notifyUnauthorized, withTokenQuery } from './auth';

const api = axios.create({
  baseURL: '/api',
  timeout: 120000,
});

/**
 * 自动附带访问令牌（仅在用户已解锁时）。
 *
 * 为什么用拦截器而不是逐个请求传参：REST 端点有 30+ 个，逐个加参数等于给
 * 「某处忘传令牌」留下永久的坑——而那种坑的表现是"某个页面莫名其妙 401"，
 * 极难定位。拦截器是唯一能保证**新增端点默认就带鉴权**的位置。
 */
api.interceptors.request.use((config) => {
  const token = getApiToken();
  if (token) {
    // 用 set() 而非展开合并：axios 的 headers 是 AxiosHeaders 类实例，
    // 展开成普通对象会丢掉 set/get/has 等方法（TS 与运行时都会出问题）。
    config.headers.set('x-api-token', token);
  }
  return config;
});

/**
 * 收到 401 就广播出去，驱动解锁条出现（见 api/auth.ts 的 notifyUnauthorized）。
 * 必须在这里而不是各页面：401 可能来自任意端点，拦截器是唯一的全局覆盖点。
 *
 * 返回 rejected 原样透传：拦截器只观察、不吞错误，各调用方的错误处理逻辑不变。
 */
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401) notifyUnauthorized();
    return Promise.reject(error);
  },
);

/**
 * 把 axios 的原始错误翻译成用户能理解、能行动的中文提示。
 * 后端未启动时 axios 只会抛 "Network Error"，对用户毫无意义。
 */
export function normalizeApiError(error: unknown, fallback = '请求失败'): Error {
  const e = error as {
    code?: string;
    message?: string;
    response?: { status?: number; data?: { error?: string; message?: string } };
  };

  if (e?.code === 'ERR_CANCELED') return new Error('请求已取消');
  if (e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '')) {
    return new Error('请求超时：分析耗时超过预期，请稍后重试或换一只标的');
  }
  if (e?.code === 'ERR_NETWORK' || !e?.response) {
    return new Error(
      '无法连接后端服务（localhost:3001）。请确认服务已启动，或运行「启动系统.bat」后重试',
    );
  }

  const status = e.response.status;
  const serverMsg = e.response.data?.error || e.response.data?.message;
  if (serverMsg) return new Error(serverMsg);
  if (status === 404) return new Error('接口不存在（404），请确认前后端版本一致');
  // 鉴权：只在服务端确实回 401 时提示"输令牌"。未启用鉴权时不存在这个状态码，
  // 所以本地开发不会看到这条提示。
  // 文案不写"右上角"这类方位词——解锁条的位置可能调整，写位置就等于给自己埋一个
  // 会过期的说明；只说"页面上的解锁条"，位置变了也不用改这句。
  if (status === 401) return new Error('需要访问令牌：请在页面上的解锁条中填入 API_AUTH_TOKEN');
  if (status === 429) return new Error('请求过于频繁，请稍后再试');
  if (status && status >= 500) return new Error(`后端服务异常（${status}），请查看服务端日志`);
  return new Error(fallback);
}

let currentController: AbortController | null = null;

export async function analyzeStock(stockCode: string): Promise<AnalysisResult> {
  // Cancel previous request if any
  if (currentController) currentController.abort();
  currentController = new AbortController();

  try {
    // 显式泛型：服务端 res.json(result) 直接下发 AnalysisResult，
    // 不写泛型时 response.data 是 any，本函数的返回值也就无人校验。
    const response = await api.post<AnalysisResult>(
      '/analyze',
      { stockCode },
      {
        signal: currentController.signal,
        timeout: 60000,
      },
    );
    return response.data;
  } catch (error: unknown) {
    if (axios.isCancel(error)) throw new Error('请求已取消');
    throw normalizeApiError(error, '分析请求失败');
  } finally {
    currentController = null;
  }
}

/**
 * /api/stocks 单项。类型来自生成的 GETApiStocksResponse（契约 → generated.ts），
 * 服务端 getSupportedStocks() 返回 { code, name, industry }。
 */
export type StockListItem = StockListResponse[number];

export async function getStockList(): Promise<StockListItem[]> {
  try {
    // 上游失败时服务端回兜底数组而非报错，故返回类型就是数组本身，不需要再包一层
    const response = await api.get<StockListResponse>('/stocks', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取股票列表失败');
  }
}

/** /api/stocks/search 单项。类型来自生成的 GETApiStocksSearchResponse。 */
export type StockSearchHit = StockSearchResponse[number];

export async function searchStocks(
  keyword: string,
  signal?: AbortSignal,
): Promise<StockSearchHit[]> {
  try {
    // 搜索失败时服务端回空数组（200），故调用方的 Array.isArray 兜底是防御性的
    const response = await api.get<StockSearchResponse>('/stocks/search', {
      params: { keyword },
      timeout: 15000,
      signal,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '搜索失败');
  }
}

export async function runQuantAnalysis(
  payload: {
    strategy: unknown;
    useNews?: boolean;
    newsItems?: {
      id: string;
      title: string;
      summary?: string;
      publishedAt: string;
      polarity?: number;
    }[];
  },
  signal?: AbortSignal,
): Promise<QuantResearchReport> {
  try {
    // 泛型指向页面自己的报告类型（pages/quant/types.ts），而不是在此复制一份：
    // 两处定义一旦分叉，泛型会立刻在调用点报错，这正是我们想要的检查。
    const response = await api.post<QuantResearchReport>('/quant/analyze', payload, { signal });
    return response.data;
  } catch (error: unknown) {
    // 用户主动取消：以专用类型上抛，调用方据此静默收尾而非当失败渲染
    if (axios.isCancel(error)) throw new AnalysisCancelledError('研究已取消');
    throw normalizeApiError(error, '量化分析失败');
  }
}

export async function runBatchCompositeAlpha(
  payload: {
    stockCodes: string[];
    startDate?: string;
    endDate?: string;
    horizons?: number[];
  },
  signal?: AbortSignal,
): Promise<CompositeAlphaBatchResult> {
  try {
    // 服务端在 result 之外还附带 run / preflight 两个复现快照字段，
    // 页面当前不消费，故泛型只声明被消费的子集（多余字段运行时仍在，不影响渲染）。
    const response = await api.post<CompositeAlphaBatchResult>(
      '/quant/factor/composite/batch',
      payload,
      {
        // 批量测算：每只都要拉 K 线 + 基准，放宽超时（上限 20 只）
        timeout: 180000,
        signal,
      },
    );
    return response.data;
  } catch (error: unknown) {
    // 用户主动取消：以专用类型上抛，调用方据此静默收尾而非当失败渲染
    if (axios.isCancel(error)) throw new AnalysisCancelledError('批量测算已取消');
    throw normalizeApiError(error, '批量组合 alpha 测算失败');
  }
}

/**
 * 行业板块列表（截面因子 universe 下拉用）。
 * 页面挂载时截面面板与因子实验室会各请求一次，而该端点有 30 req/min 限流；
 * 这里做 in-flight 去重 + 5 分钟结果缓存，避免同一份低频数据被重复请求。
 * 失败不缓存（否则一次上游抖动会让下拉在整个会话内永久不可用）。
 */
const BOARDS_TTL_MS = 5 * 60_000;
type UniverseBoards = { boards: { code: string; name: string }[] };
let boardsCache: { at: number; promise: Promise<UniverseBoards> } | null = null;

export function getUniverseBoards(): Promise<UniverseBoards> {
  const now = Date.now();
  if (!boardsCache || now - boardsCache.at > BOARDS_TTL_MS) {
    boardsCache = {
      at: now,
      promise: api
        .get<UniverseBoards>('/quant/universe/boards', { timeout: 20000 })
        .then((response) => response.data)
        .catch((error: unknown) => {
          boardsCache = null;
          throw normalizeApiError(error, '行业板块列表获取失败');
        }),
    };
  }
  return boardsCache.promise;
}

/** 截面因子评估：显式 codes 或行业板块（board+topN）自动拉宽截面 */
export async function runCrossSectionEvaluation(
  payload: {
    codes?: string[];
    board?: string;
    /** 指数历史成分宇宙（Baostock sidecar；含其后退市证券） */
    indexUniverse?: { index: 'hs300' | 'zz500' | 'sz50'; date?: string };
    topN?: number;
    horizons?: number[];
    includeFundamental?: boolean;
    /** 事件族（分红/回购/解禁 + PEAD），默认 true */
    includeEvents?: boolean;
    /** 两融因子族（融资余额变化率/拥挤度，PIT + T+1 披露），默认 true */
    includeMargin?: boolean;
    /** 可选：为全部因子附带组合回测（top-N 等权周期调仓，宇宙等权基准） */
    portfolio?: { holdDays?: number; topN?: number; costBps?: number };
  },
  signal?: AbortSignal,
): Promise<CrossSectionResult> {
  try {
    // 与批量测算同理：服务端额外回 run / preflight / ledger，此处只声明被消费的子集
    const response = await api.post<CrossSectionResult>('/quant/factor/cross-section', payload, {
      // 每只都要拉行情 + 财务 + 季度财报。基本面已走缓存、K 线为增量补尾，
      // 但数百只的全市场大面板冷启动仍可能耗时数分钟，故放宽到 10 分钟。
      timeout: 600000,
      signal,
    });
    return response.data;
  } catch (error: unknown) {
    // 用户主动取消：以专用类型上抛，调用方据此静默收尾而非当失败渲染
    if (axios.isCancel(error)) throw new AnalysisCancelledError('截面评估已取消');
    throw normalizeApiError(error, '截面因子评估失败');
  }
}

/**
 * 多股对比（2-3 只，单只 1~3 分钟）。
 * 返回 { stocks, failures? }：服务端逐只容错，某只失败不再让整批 500，
 * 成功的进 stocks、失败的在 failures（{ code, error }，error 为可读中文）。
 * failures 是可选的——旧后端全部成功时不返回该字段，调用方按 `failures ?? []` 处理。
 */
export async function compareStocks(
  codes: string[],
  signal?: AbortSignal,
): Promise<CompareResponse> {
  try {
    const response = await api.post<CompareResponse>(
      '/compare',
      { stockCodes: codes },
      {
        timeout: 180000, // 3 min timeout for multi-stock analysis
        signal,
      },
    );
    return response.data;
  } catch (error: unknown) {
    if (axios.isCancel(error)) throw new AnalysisCancelledError('对比分析已取消');
    throw normalizeApiError(error, '对比分析失败');
  }
}

// === 自选股 / 持仓监控 ===
export async function getWatchlist(): Promise<{ codes: string[] }> {
  try {
    const response = await api.get<{ codes: string[] }>('/watchlist', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取自选股失败');
  }
}

export async function addToWatchlist(code: string): Promise<{ codes: string[] }> {
  try {
    const response = await api.post<{ codes: string[] }>(
      '/watchlist',
      { code },
      { timeout: 15000 },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '添加自选股失败');
  }
}

export async function removeFromWatchlist(code: string): Promise<{ codes: string[] }> {
  try {
    const response = await api.delete<{ codes: string[] }>(`/watchlist/${code}`, {
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '移除自选股失败');
  }
}

/** 对自选股（或指定 codes）批量运行"含最新消息回测" */
export async function runWatchlistNewsBacktest(
  codes?: string[],
  signal?: AbortSignal,
): Promise<import('../types').WatchlistNewsBacktestReport> {
  try {
    const response = await api.post<import('../types').WatchlistNewsBacktestReport>(
      '/watchlist/news-backtest',
      { codes: codes ?? [] },
      { timeout: 180000, signal },
    );
    return response.data;
  } catch (error: unknown) {
    if (axios.isCancel(error)) throw new AnalysisCancelledError('批量回测已取消');
    throw normalizeApiError(error, '自选股批量回测失败');
  }
}

// === 对话式助手 ===
export interface ChatEvidence {
  id: string;
  source: string;
  text: string;
  stockCode?: string;
}

export interface ChatDebate {
  bull: string;
  bear: string;
  synthesis: string;
}

export interface RiskDebateResult {
  aggressive: string;
  neutral: string;
  conservative: string;
  synthesis: string;
}

export interface AgentPlan {
  action: 'direct' | 'tools' | 'debate';
  reason: string;
}

export interface CalculationError {
  claim: string;
  reconstructedFormula: string;
  recomputedValue: string;
  claimedValue: string;
  discrepancy: string;
}

export interface AnswerVerification {
  verified: boolean;
  unverified: string[];
  calculationErrors: CalculationError[];
  warning: string;
}

export interface ChatAgentResponse {
  answer: string;
  toolsUsed: string[];
  evidence: ChatEvidence[];
  debate?: ChatDebate;
  riskDebate?: RiskDebateResult;
  /** 路由规划结果（LLM 可用时返回） */
  plan?: AgentPlan;
  /** 幻觉防护校验结果 */
  verification?: AnswerVerification;
  /** true = LLM 未配置，规则降级 */
  degraded: boolean;
  model?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export async function chatWithAgent(
  payload: {
    message: string;
    history?: ChatTurn[];
    stockCode?: string;
    sessionId?: string;
  },
  signal?: AbortSignal,
): Promise<ChatAgentResponse> {
  try {
    const response = await api.post<ChatAgentResponse>('/chat', payload, {
      timeout: 120000,
      signal,
    });
    return response.data;
  } catch (error: unknown) {
    if (axios.isCancel(error)) throw new AnalysisCancelledError('已取消本次回答');
    throw normalizeApiError(error, '对话请求失败');
  }
}

// === 研究增强接口（文档库 / 模型路由 / 成本 / 记忆 / 自治监控） ===
export interface IngestInsight {
  summary: string;
  positives: string[];
  risks: string[];
  catalysts: string[];
  confidence: number;
  source: string;
}
export interface IngestResult {
  id: string;
  title: string;
  ingested: boolean;
  insight: IngestInsight;
}
export async function ingestDocument(payload: {
  title: string;
  text?: string;
  pdfBase64?: string;
  stockCode?: string;
}): Promise<IngestResult> {
  try {
    const response = await api.post<IngestResult>('/ingest', payload, { timeout: 120000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '文档入库失败');
  }
}
export async function listDocuments(): Promise<DocumentListResponse> {
  try {
    const response = await api.get<DocumentListResponse>('/documents', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '读取资料库失败');
  }
}

/** 多模型注册表与任务路由；类型来自生成的 GETApiModelsResponse。 */
export type ModelRoutingInfo = ModelRoutingResponse;
export async function getModels(): Promise<ModelRoutingInfo> {
  try {
    const response = await api.get<ModelRoutingInfo>('/models', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取模型信息失败');
  }
}

/** LLM 成本报表；类型来自生成的 GETApiCostResponse。 */
export type CostReport = CostResponse;
export async function getCostReport(): Promise<CostReport> {
  try {
    const response = await api.get<CostReport>('/cost', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取成本报告失败');
  }
}
export async function resetCostReport(): Promise<{ ok: boolean }> {
  try {
    const response = await api.post<OkResponse>('/cost/reset', {}, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '重置成本失败');
  }
}

export async function clearChatHistory(sessionId: string): Promise<{ ok: boolean }> {
  try {
    const response = await api.post<ClearHistoryResponse>(
      '/chat/history/clear',
      { sessionId },
      {
        timeout: 15000,
      },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '清空对话记忆失败');
  }
}

export interface AutonomousState {
  running: boolean;
  intervalMs?: number;
  lastRunAt?: string;
  lastAlertCount?: number;
  runCount?: number;
  errorCount?: number;
  lastError?: string;
}
export async function startAutonomous(
  intervalMs?: number,
): Promise<AutonomousState & { started: boolean }> {
  try {
    // 服务端 res.json({ started: true, ...withCoverage(state) })
    const response = await api.post<AutonomousState & { started: boolean }>(
      '/autonomous/start',
      { intervalMs },
      { timeout: 15000 },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '启动自动监控失败');
  }
}
export async function stopAutonomous(): Promise<{ stopped: boolean; lastAlerts: unknown[] }> {
  try {
    // 服务端 res.json({ stopped: true, lastAlerts })；lastAlerts 元素未在前端消费
    const response = await api.post<{ stopped: boolean; lastAlerts: unknown[] }>(
      '/autonomous/stop',
      {},
      { timeout: 15000 },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '停止自动监控失败');
  }
}
export async function getAutonomousStatus(): Promise<AutonomousState> {
  try {
    // 未在运行时服务端只回 { running: false }，其余字段缺省 —— 故泛型里除 running 外均可选
    const response = await api.get<AutonomousState>('/autonomous/status', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取监控状态失败');
  }
}

/**
 * 流式对话（SSE，事件式：最终以 {phase:'done', ...response} 推回）。
 * onEvent 在每次事件回调；返回的 cancel 可中断。
 */
export type ChatStreamEvent =
  | { phase: 'planning'; message: string }
  | { phase: 'retrieving'; message: string }
  | { phase: 'tool_calling'; message: string; tools?: string[] }
  | { phase: 'debating'; message: string }
  | { phase: 'verifying'; message: string }
  | { phase: 'done'; message: string; response: ChatAgentResponse }
  | { phase: 'error'; message: string };

export function chatWithAgentStream(
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
  options: { sessionId?: string } = {},
): { cancel: () => void } {
  // sessionId 参与会话记忆：否则后端把每次流式提问当独立会话，
  // "第二轮无需重复股票代码"在流式主路径不可用
  const params = new URLSearchParams({ message });
  if (options.sessionId) params.set('sessionId', options.sessionId);
  // SSE 只能走 query 传令牌：EventSource 不允许自定义请求头
  const es = new EventSource(withTokenQuery(`/api/chat/stream?${params.toString()}`));
  let settled = false;
  /** 首包看门狗：20 秒内没收到任何事件即判定服务不可用，避免静默挂起 */
  let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (!settled)
      finish({ phase: 'error', message: '后端无响应：20 秒内未收到任何进度，请确认服务是否正常' });
  }, 20000);
  const finish = (evt: ChatStreamEvent) => {
    if (settled) return;
    settled = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    es.close();
    onEvent(evt);
  };
  es.onmessage = (e) => {
    // 已收尾（done/error/cancel）后不再回调：close() 只能阻止后续事件到达，
    // 已排进任务队列的那一帧仍会执行——组件已卸载时回调会让调用方在废弃的会话上 setState
    if (settled) return;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    try {
      const data = JSON.parse(e.data) as ChatStreamEvent;
      if (data.phase === 'done' || data.phase === 'error') finish(data);
      else onEvent(data);
    } catch {
      /* 忽略偶发解析错误 */
    }
  };
  es.onerror = () => {
    if (!settled) finish({ phase: 'error', message: '连接中断，对话未完成，请重试' });
  };
  return {
    cancel: () => {
      if (watchdog) clearTimeout(watchdog);
      settled = true;
      es.close();
    },
  };
}

/** 流式分析阶段事件（与后端 AnalysisStage 对齐） */
export interface AnalysisStage {
  phase: 'data' | 'experts' | 'arbitration' | 'scoring' | 'strategy' | 'done' | 'error';
  message: string;
  totalScore?: number;
  rating?: string;
  result?: AnalysisResult;
}

export interface AnalyzeStreamOptions {
  /** 连接失败（尚未收到任何事件）时的自动重连次数上限，默认 3；设 0 关闭 */
  maxRetries?: number;
  /**
   * 是否从上次中断处续跑（断点续跑）。
   * 服务端无断点或断点已过期时自动全新开始，因此失败重试场景可放心恒传 true。
   */
  resume?: boolean;
}

/** 取消导致的 Promise 拒绝：调用方应静默处理（区别于真实失败） */
export class AnalysisCancelledError extends Error {
  constructor(message = '分析已取消') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

/**
 * 流式股票分析（SSE）
 * onStage 在每次阶段进度更新时回调；返回的 done Promise 在分析完成时 resolve 结果。
 * 调用方可通过 cancel() 主动中断（done 会以 AnalysisCancelledError 拒绝，await 方可收尾）。
 *
 * 连接健壮性（H-03）：尚未收到任何事件时连接失败，按指数退避自动重连
 * （1s → 2s → 4s，默认最多 3 次）；已收到事件后断开则直接报错。
 * 断开后的重试可传 resume: true，从服务端最后成功阶段续跑，不重复支付已完成阶段。
 */
export function analyzeStockStream(
  stockCode: string,
  onStage: (stage: AnalysisStage) => void,
  options: AnalyzeStreamOptions = {},
): { cancel: () => void; done: Promise<AnalysisResult> } {
  const maxRetries = options.maxRetries ?? 3;
  const url = withTokenQuery(
    `/api/analyze/stream?stockCode=${encodeURIComponent(stockCode)}${
      options.resume ? '&resume=1' : ''
    }`,
  );

  let resolveDone!: (r: AnalysisResult) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<AnalysisResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  /** 是否收到过任何一条服务端事件 —— 用于区分「连不上」和「中途断开」 */
  let received = false;
  let settled = false;
  let cancelled = false;
  let es: EventSource | null = null;
  let retryCount = 0;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  /** 首包看门狗：若 20s 内一条事件都没收到，判定为服务不可用 */
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (!received) finish(new Error('后端无响应：20 秒内未收到任何分析进度，请确认服务是否正常'));
    }, 20000);
  };

  function finish(err: Error | null, result?: AnalysisResult) {
    if (settled) return;
    settled = true;
    clearWatchdog();
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    es?.close();
    if (err) rejectDone(err);
    else resolveDone(result as AnalysisResult);
  }

  function connect() {
    if (settled || cancelled) return;
    es = new EventSource(url);
    armWatchdog();

    es.onmessage = (event) => {
      received = true;
      clearWatchdog();
      try {
        const data = JSON.parse(event.data) as AnalysisStage;
        if (data.phase === 'done' && data.result) {
          finish(null, data.result);
        } else if (data.phase === 'error') {
          finish(new Error(data.message || '分析过程出错'));
        } else {
          onStage(data);
        }
      } catch {
        // 忽略偶发解析错误
      }
    };

    es.onerror = () => {
      // EventSource 在正常结束时也会触发 error，已 settle 的场景直接忽略
      if (settled || cancelled) return;
      es?.close();
      clearWatchdog();
      // 已收到过事件后断开：分析无法续传，直接报错
      if (received) {
        finish(new Error('连接中断，分析未完成，请重试'));
        return;
      }
      // 从未收到事件：指数退避重连（1s/2s/4s…），耗尽后报连接失败（H-03）
      if (retryCount < maxRetries) {
        retryCount += 1;
        retryTimer = setTimeout(connect, 1000 * 2 ** (retryCount - 1));
        return;
      }
      finish(
        new Error(
          '无法连接后端服务（localhost:3001）。请确认服务已启动，或运行「启动系统.bat」后重试',
        ),
      );
    };
  }

  connect();

  return {
    cancel: () => {
      cancelled = true;
      clearWatchdog();
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      // settle done：让 `await done` 的调用方能收尾（此前永久挂起，靠调用方手动兜底掩盖）
      finish(new AnalysisCancelledError());
    },
    done,
  };
}

// === 模拟盘（paper trading）研究闭环 ===
export async function getPaperPortfolio(): Promise<PaperPortfolio> {
  try {
    const response = await api.get<PaperPortfolio>('/paper/portfolio', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '读取模拟盘账户失败');
  }
}

export async function placePaperOrder(body: PaperOrderInput): Promise<{ order: PaperOrder }> {
  try {
    const response = await api.post<{ order: PaperOrder }>('/paper/order', body, {
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '模拟下单失败');
  }
}

export async function settlePaperDay(body: {
  date: string;
  closePrices: Record<string, number>;
  prevClosePrices?: Record<string, number>;
}): Promise<PaperSettleResponse> {
  try {
    // 服务端 latestEquity 取 equity.at(-1)：当日无净值点时缺省，故契约里是可选
    const response = await api.post<PaperSettleResponse>('/paper/settle', body, {
      timeout: 30000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '日终结算失败');
  }
}

export async function getPaperStats(): Promise<PaperStats> {
  try {
    const response = await api.get<PaperStats>('/paper/stats', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '读取模拟盘统计失败');
  }
}

// === 合规审计查询（金融监管 8 号文）：可按类别/风险等级/时间/会话过滤 ===

/** 审计查询参数：在既有过滤条件上补分页（limit/offset 由服务端 /api/audit 处理） */
export interface AuditLogQuery extends AuditQueryFilter {
  /** 本页条数；不传 = 全部 */
  limit?: number;
  /** 偏移量，从 0 开始；不传 = 0 */
  offset?: number;
}

export async function getAuditLog(query?: AuditLogQuery): Promise<AuditQueryResponse> {
  try {
    // 分页已由服务端实现（server/src/routes/audit.ts）：支持 limit/offset，
    // 且 count 恒为**匹配总数**（不是本页条数），offset 越界返回空数组。
    // 因此这里**直接透传**分页参数——原先的客户端 slice 已删除：服务端也切片后
    // 再本地切一次会二次偏移，返回错误的页（旧注释即已注明「后端真加上 limit/offset
    // 时务必删掉这里的 slice」）。非法值（负数/NaN）不下发，交由服务端按"未分页"处理。
    const { limit, offset, ...filters } = query ?? {};
    const params: Record<string, unknown> = { ...filters };
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      params.limit = Math.floor(limit);
    }
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
      params.offset = Math.floor(offset);
    }
    const response = await api.get<AuditQueryResponse>('/audit', {
      params,
      timeout: 15000,
    });
    const data = response.data;
    // count / entries 在契约里是必填，但审计查询是只读降级路径，
    // 这里仍保留兜底：宁可少显示一条，也不要因缺字段让整页崩掉。
    const entries = data.entries ?? [];
    return {
      count: typeof data.count === 'number' ? data.count : entries.length,
      entries,
    };
  } catch (error: unknown) {
    throw normalizeApiError(error, '审计查询失败');
  }
}

// === 因子研究：自定义表达式 / 实验台账 / 上游预检 ===

/** 因子实验台账条目（因子 × 持有期） */
export interface FactorExperiment {
  id: string;
  createdAt: string;
  source: 'cross-section' | 'expression' | 'hypothesis';
  name: string;
  expression?: string;
  universe: { board?: string; codes?: string[]; requested: number; included: number };
  horizon: number;
  sampleSize: number;
  icMean: number;
  pValue: number;
  oosStable: boolean;
  kept: boolean;
  notes?: string;
}

export interface FactorExperimentSummary {
  total: number;
  kept: number;
  bySource: Record<string, number>;
  lastAt: string | null;
  /** 期望假阳性上界 = 采信数 × 5%（最坏情形：采信集全部为真原假设） */
  keptExpectedFalse?: number;
  /** 采信集中 OOS 稳定的占比（0-1） */
  keptOosShare?: number;
}

/** 查询实验台账 */
export async function getFactorExperiments(params?: {
  source?: string;
  kept?: boolean;
  limit?: number;
}): Promise<{ items: FactorExperiment[]; summary: FactorExperimentSummary }> {
  try {
    const response = await api.get<{ items: FactorExperiment[]; summary: FactorExperimentSummary }>(
      '/quant/factor/experiments',
      {
        params: params ?? {},
        timeout: 15000,
      },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '实验台账读取失败');
  }
}

/** 研究简报（初筛 + 台账聚合的定期快照） */
export interface ResearchDigest {
  id: string;
  createdAt: string;
  screener: {
    at: string | null;
    scanned: number | null;
    eligible: number | null;
    hitCount: number | null;
    topHits: { code: string; name: string; strategy: string; detail: string }[];
  };
  ledger: {
    total: number;
    kept: number;
    keptExpectedFalse: number;
    keptOosShare: number;
    bySource: Record<string, number>;
  };
  notes: string[];
}

export async function getResearchDigests(limit = 10): Promise<{ items: ResearchDigest[] }> {
  try {
    const response = await api.get<{ items: ResearchDigest[] }>('/quant/digests', {
      params: { limit },
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '研究简报读取失败');
  }
}

export async function runResearchDigestNow(): Promise<ResearchDigest> {
  try {
    const response = await api.post<ResearchDigest>('/quant/digests/run', {}, { timeout: 60000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '研究简报生成失败');
  }
}

/** 评估一条受限 DSL 因子表达式（不执行任意代码，越界由服务端拒绝） */
/** 因子组合回测结果（top-N 等权、周期调仓、A 股成本） */
export interface FactorPortfolioBacktest {
  equityCurve: { date: string; value: number }[];
  benchmarkCurve: { date: string; value: number }[];
  rebalances: {
    date: string;
    endDate: string;
    holdings: string[];
    turnover: number;
    grossReturn: number;
    costDrag: number;
    benchmarkReturn: number;
  }[];
  totalReturn: number;
  annualizedReturn: number;
  sharpe: number;
  maxDrawdown: number;
  winRate: number;
  avgTurnover: number;
  periods: number;
}

/** 单条受限 DSL 表达式的评估结果（从原内联返回类型提取，便于在泛型处引用） */
export interface FactorExpressionResult {
  stocksIncluded: string[];
  stocksSkipped: { code: string; reason: string }[];
  factor: {
    name: string;
    report: {
      sampleSize: number;
      byPeriod: {
        period: number;
        ic: { mean: number; pValue: number; n: number };
        oos: { stable: boolean };
        verdict: { effective: boolean; reasons: string[] };
      }[];
    };
  };
  portfolio?: FactorPortfolioBacktest | null;
  ledger: { recorded: number; total: number };
}

export async function runFactorExpression(
  payload: {
    expression: string;
    board?: string;
    codes?: string[];
    topN?: number;
    horizons?: number[];
    name?: string;
    source?: 'expression' | 'hypothesis';
    portfolio?: { holdDays?: number; topN?: number; costBps?: number };
  },
  signal?: AbortSignal,
): Promise<FactorExpressionResult> {
  try {
    // 服务端另回 run / preflight 等复现字段，此处只声明被消费的子集
    const response = await api.post<FactorExpressionResult>('/quant/factor/expression', payload, {
      // 数百只大面板冷启动可能数分钟，与截面评估同量级
      timeout: 600000,
      signal,
    });
    return response.data;
  } catch (error: unknown) {
    // 用户主动取消：与截面评估同语义上抛专用类型，调用方据此静默收尾而非当失败渲染
    if (axios.isCancel(error)) throw new AnalysisCancelledError('因子评估已取消');
    throw normalizeApiError(error, '因子表达式评估失败');
  }
}

/** 上游预检结果（从原内联返回类型提取，便于在泛型处引用） */
export interface QuantHealthResult {
  ok: boolean;
  checks: { key: string; ok: boolean; detail: string }[];
  degraded: string[];
  checkedAt: string;
}

/** 上游预检：行情源 / LLM / 本地缓存 */
export async function getQuantHealth(): Promise<QuantHealthResult> {
  try {
    // 服务端在 preflight 之外还并入 tushare / baostock 两个通道块，
    // 前端只读 preflight 本体，故泛型只声明这一层（多余字段运行时仍在）
    const response = await api.get<QuantHealthResult>('/quant/health', { timeout: 20000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '上游预检失败');
  }
}

// === 港美股财务估值（东财 datacenter RPT 网关） ===
export async function getIntlFundamentals(
  code: string,
  market?: IntlMarket,
): Promise<IntlFundamentalsResult> {
  try {
    const response = await api.get<IntlFundamentalsResult>('/intl/fundamentals', {
      params: { code, market },
      timeout: 30000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '港美股数据获取失败');
  }
}

/**
 * 港美股日 K 线（东财通道，secid 映射 116.x / 107.x）。
 * 类型来自生成的 IntlKline —— 比此前手写版多一个 isSimulated：
 * 上游取数失败时服务端会降级为**模拟 K 线**并置该标记，消费方据此如实提示用户，
 * 不能当成真实行情画图。原先手写类型漏了这个字段，等于丢掉了这个提示能力。
 */
export type IntlKline = GeneratedIntlKline;

export async function getIntlKlines(params: {
  code: string;
  market?: string;
  startDate?: string;
  endDate?: string;
}): Promise<IntlKlinesResponse> {
  try {
    // 类型来自生成的 GETApiIntlKlinesResponse：契约里已含服务端回显的
    // startDate / endDate，不再需要「只声明被消费字段」的手工裁剪。
    const response = await api.get<IntlKlinesResponse>('/intl/klines', {
      params,
      timeout: 30000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '港美股 K 线获取失败');
  }
}

/** 估值建模结果（两阶段 EPS 贴现 + 可比公司表） */
export interface ValuationModelResult {
  model: 'two_stage_eps_dcf';
  code: string;
  fairValue: number | null;
  currentPrice: number;
  upsidePct: number | null;
  dcf: {
    fairValue: number;
    explicitValue: number;
    terminalValue: number;
    discountedTerminalValue: number;
    cashFlows: { year: number; eps: number; discountFactor: number; presentValue: number }[];
    assumptions: Record<string, number>;
  } | null;
  sensitivity: {
    discountRates: number[];
    growthRates1: number[];
    matrix: number[][];
  } | null;
  comparables: {
    peers: { code: string; name: string; pe: number | null; pb: number | null }[];
    sampleSize: number;
    medianPe: number | null;
    medianPb: number | null;
    medianRoe: number | null;
    pePremiumPct: number | null;
    pbPremiumPct: number | null;
    impliedValueByMedianPe: number | null;
  };
  assumptions: {
    baseEps: number;
    growthRate1: number;
    growthRate1Source: 'input' | 'eps_cagr_3y';
    growthRate2: number;
    discountRate: number;
    explicitYears: number;
  };
  limitations: string[];
}

export async function runValuationModelApi(params: {
  code: string;
  assumptions?: {
    growthRate1?: number;
    growthRate2?: number;
    discountRate?: number;
    explicitYears?: number;
    baseEps?: number;
  };
}): Promise<ValuationModelResult> {
  try {
    const response = await api.post<ValuationModelResult>('/quant/valuation/model', params, {
      timeout: 60000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '估值建模失败');
  }
}

// === 研究历史记录（分析结果自动入库，前端列表/回看/删除） ===
/** 评分/评级时间线单点（与服务端 historyService 的 HistoryTimelinePoint 对齐） */
export interface HistoryTimelinePoint {
  /** YYYY-MM-DD */
  date: string;
  score: number;
  rating: string;
}

/**
 * 历史列表项 = 摘要 + 精简时间线（由旧到新，含当前这条）。
 * 该字段按需返回，仅用于回答"观点怎么变的"；不带时间线时字段缺失（旧数据），
 * 因此是可选的，前端渲染前必须判空。
 */
export type HistoryListItem = HistorySummary & { timeline?: HistoryTimelinePoint[] };

export async function fetchHistoryList(limit = 50): Promise<HistoryListItem[]> {
  try {
    // 泛型是**信封**而不是数组本身：服务端 res.json({ items: [...] })，
    // 少写这一层泛型的话 response.data.items 就是 any，列表元素全无类型
    const response = await api.get<HistoryListResponse>('/history', {
      params: { limit },
      timeout: 15000,
    });
    return response.data.items;
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史记录读取失败');
  }
}

export async function fetchHistoryDetail(id: string): Promise<HistoryItem> {
  try {
    const response = await api.get<HistoryItem>(`/history/${id}`, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史记录读取失败');
  }
}

export async function deleteHistoryItem(id: string): Promise<void> {
  try {
    await api.delete<DeleteHistoryResponse>(`/history/${id}`, { timeout: 15000 });
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史记录删除失败');
  }
}

// === 自选股异动监控：重跑批量新闻回测并检出预警 ===
export async function monitorWatchlist(signal?: AbortSignal): Promise<WatchlistMonitorResult> {
  try {
    const response = await api.post<WatchlistMonitorResult>(
      '/watchlist/monitor',
      {},
      {
        timeout: 120000,
        signal,
      },
    );
    return response.data;
  } catch (error: unknown) {
    if (axios.isCancel(error)) throw new AnalysisCancelledError('监控已取消');
    throw normalizeApiError(error, '自选股监控失败');
  }
}

/**
 * 最近一次异动监控快照（服务端落盘，刷新/复访可回看）。
 *
 * 从未监控过时服务端返回稳定空结构（generatedAt=null、alerts=[]），不会是 404。
 * 此前这里有个 `Omit<..., 'generatedAt'> & { generatedAt: string | null }` 的
 * 放宽类型，是为绕开「WatchlistMonitorResult.generatedAt 被声明成必填 string」
 * 而存在的——而那个声明本身是错的（契约里一直是 nullable）。根因已修，
 * 故此处直接用 WatchlistMonitorResult，不再维护第二份形状。
 */
export type WatchlistAlertsSnapshot = WatchlistMonitorResult;

export async function fetchWatchlistAlerts(): Promise<WatchlistAlertsSnapshot> {
  try {
    const response = await api.get<WatchlistAlertsSnapshot>('/watchlist/alerts', {
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '最近监控记录读取失败');
  }
}

/**
 * LLM 资源上限：进程级并发闸门 + 入站参数限幅
 * ----------------------------------------------------------------------------
 * 为什么需要（P1 隐患）：
 *  - **扇出无闸门**：一次 `/api/compare` 会并行跑 3 次完整分析，每次 8 位专家 ×
 *    最多 2 次尝试，单请求最坏约 48 个在途 LLM 调用；`llm/client.ts` 只有
 *    「单请求内重试」，没有任何全局并发上限 → 上游 429 雪崩、本地连接打满，
 *    而且每个 429 还会被重试逻辑放大成 2 倍的瞬时压力。
 *  - **参数无上限**：`/api/llm/ensemble` 曾把用户的 `temperature` / `maxTokens`
 *    原样透传上游，`maxTokens` 任意大可直接放大账单；`messages` 只校验"非空数组"。
 *
 * 本模块把两件事放在同一个文件里，因为它们同属「LLM 调用资源上限」这一件事
 * （并发上限 + 单次调用开销上限），且本次修复被限定只新增一个 utils 模块。
 *
 * 闸门语义（务必注意）：**限并发，不是串行化**。默认 4 路并行，8 位专家仍以
 * 4 路推进，只有超出部分排队；退化成 limit=1 会让一次对比分析从分钟级变成十分钟级。
 */
import logger from './logger.js';

// ============================================================================
// 一、并发闸门
// ============================================================================

/**
 * 默认并发上限 4（LLM_MAX_CONCURRENCY 可调，硬上界 32）。
 * 依据：
 *  - **不拖慢常见路径**：单次深度分析是 8 位专家并行，默认值必须 ≥ 8，
 *    否则最常见的"一个人跑一次分析"会被人为降速（4 路并行 ≈ 分析时长翻倍）。
 *  - **挡住病态扇出**：最坏路径（compare 3×8 专家、每专家最多 2 次尝试）会有
 *    24~48 个调用争抢配额，在途数被钉在 8，远离上游 429 阈值；此前无闸门时
 *    是几十并发直接打到上游，再叠加 client.ts 的 2 次退避重试形成雪崩。
 *  - **可调**：压测或扩容后可用 LLM_MAX_CONCURRENCY 提到 32（硬上界防止把
 *    "保护"配成"没有保护"，例如误配 1000）。
 */
export const DEFAULT_MAX_CONCURRENCY = 8;
/** 并发上限的硬上界：环境变量再大也不会超过它（配置失误时的兜底） */
export const MAX_CONCURRENCY_LIMIT = 32;

/**
 * 默认排队超时 30s（LLM_QUEUE_TIMEOUT_MS 可调）。
 * 依据：
 *  - 单次 LLM 请求自身的超时是 60s（client.ts 默认）。排队若再等 30s 以上，
 *    该 HTTP 请求早已超出前端等待预算，而客户端多半已断开——继续等待只是堆积，
 *    不如尽早以 429 + Retry-After 让调用方退避重试（fail fast）。
 *  - 排队时长只计「等配额」的时间：acquire 成功后才开始单请求超时计时，
 *    所以排队不会偷走调用自身的超时预算。
 *  - 不支持配 0 关闭：闸门必须有兜底超时，否则上游一慢，请求会永久排队。
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
/** 排队超时硬上界（10 分钟）：超过这个等待时间没有任何客户端还在等 */
export const MAX_QUEUE_TIMEOUT_MS = 600_000;

/**
 * 队列长度上限。等待者各自持有一个定时器与一个 abort 监听，
 * 无上限时「闸门满并发 + 大量灌入」会让内存随等待者数量线性增长；
 * 且这些请求本来也要等很久，不如直接以 429 让调用方退避重试。
 */
export const DEFAULT_MAX_QUEUE = 200;
export const MAX_QUEUE_LIMIT = 5_000;

/** 解析队列上限：非法值回退默认，超过硬上界则夹紧 */
export function resolveMaxQueue(raw: string | undefined = process.env.LLM_MAX_QUEUE): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_QUEUE;
  return Math.min(Math.floor(n), MAX_QUEUE_LIMIT);
}

/** 解析并发上限：非法值（NaN/空串/负数/0）回退默认，超过硬上界则夹紧 */
export function resolveMaxConcurrency(
  raw: string | undefined = process.env.LLM_MAX_CONCURRENCY,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONCURRENCY;
  return Math.min(Math.floor(n), MAX_CONCURRENCY_LIMIT);
}

/** 解析排队超时：非法值回退默认，超过硬上界则夹紧 */
export function resolveQueueTimeoutMs(
  raw: string | undefined = process.env.LLM_QUEUE_TIMEOUT_MS,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_QUEUE_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_QUEUE_TIMEOUT_MS);
}

/** 闸门错误码：路由层据此返回 429，而不是笼统的 500/502 */
export const QUEUE_TIMEOUT_CODE = 'LLM_QUEUE_TIMEOUT';

/**
 * 排队超时错误。带上三重可识别信息，便于不同层各自判断：
 *  - `code`：机器可读错误码（跨模块 instanceof 失效时依然可识别）；
 *  - `statusCode = 429`：index.ts 的统一错误中间件按此识别限流语义；
 *  - `retryAfterMs`：路由层据此写 `Retry-After` 头。
 */
export class QueueTimeoutError extends Error {
  readonly code = QUEUE_TIMEOUT_CODE;
  readonly statusCode = 429;
  readonly retryAfterMs: number;

  constructor(gate: string, waitedMs: number, retryAfterMs: number) {
    super(`LLM 并发闸门排队超时（${gate}）：等待 ${waitedMs}ms 仍未获得配额，请稍后重试`);
    this.name = 'QueueTimeoutError';
    this.retryAfterMs = retryAfterMs;
  }

  /** Retry-After 头使用的秒数（向上取整，至少 1 秒，避免写出 Retry-After: 0） */
  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.retryAfterMs / 1000));
  }
}

/**
 * 是否闸门排队超时错误。
 * 先看 instanceof，再看 code —— 测试里模块被 mock/重新加载时 instanceof 会失效，
 * 鸭子类型判断让错误码成为唯一事实来源（路由层不会因为模块实例不同而漏判）。
 */
export function isQueueTimeoutError(error: unknown): error is QueueTimeoutError {
  if (error instanceof QueueTimeoutError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === QUEUE_TIMEOUT_CODE
  );
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface LimitGateOptions {
  /** 并发上限；传函数则每次派发时解析（运行时可读环境变量，测试可注入假时钟） */
  maxConcurrency: number | (() => number);
  /** 排队超时毫秒；同样支持函数形式 */
  queueTimeoutMs: number | (() => number);
  /** 等待队列长度上限；不传则读 LLM_MAX_QUEUE（默认 200）。装满后新调用立即 429 */
  maxQueue?: number | (() => number);
  /** 闸门名，仅用于日志与错误文案 */
  name?: string;
  /** 可注入时钟与定时器：测试用假时钟即可断言排队超时，无需真的 sleep */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/** 闸门快照：日志之外的计数口径（供运维/测试读取） */
export interface LimitGateSnapshot {
  name: string;
  maxConcurrency: number;
  /** 当前在途（已获得配额、尚未释放）的调用数 */
  inFlight: number;
  /** 当前排队等待的调用数 */
  queued: number;
  /** 累计获得配额的调用数 */
  acquired: number;
  /** 累计发生过排队等待的调用数 */
  queueWaits: number;
  /** 累计排队超时（被拒绝）的调用数 */
  timeouts: number;
  /** 累计排队中被取消的调用数 */
  aborted: number;
  /** 累计排队等待时长（毫秒），除以 queueWaits 即平均排队时长 */
  totalQueueWaitMs: number;
}

interface Waiter {
  /** 已结清（已派发 / 已超时 / 已取消）：防止重复回调造成配额泄漏 */
  settled: boolean;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: TimerHandle;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * 进程级有界并发闸门（信号量）。
 * - `acquire()` 拿到 release 函数；**释放必须放在 finally**，否则一次异常就永久
 *   占用一个配额（调用越多越容易把闸门钉死）；
 * - 排队超时 / 排队中取消都会把 waiter 从队列摘除，不会出现"空转的僵尸 waiter"
 *   在后续 release 时被误派发；
 * - release 幂等：重复调用不会凭空多放行一个配额。
 */
export class LimitGate {
  private readonly name: string;
  private readonly readMax: () => number;
  private readonly readTimeout: () => number;
  private readonly readMaxQueue: () => number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly queue: Waiter[] = [];
  private inFlightCount = 0;
  private counters = {
    acquired: 0,
    queueWaits: 0,
    timeouts: 0,
    aborted: 0,
    totalQueueWaitMs: 0,
  };

  constructor(options: LimitGateOptions) {
    this.name = options.name ?? 'llm';
    this.readMax =
      typeof options.maxConcurrency === 'function'
        ? options.maxConcurrency
        : () => options.maxConcurrency as number;
    this.readTimeout =
      typeof options.queueTimeoutMs === 'function'
        ? options.queueTimeoutMs
        : () => options.queueTimeoutMs as number;
    const mq = options.maxQueue;
    this.readMaxQueue =
      typeof mq === 'function' ? mq : typeof mq === 'number' ? () => mq : () => resolveMaxQueue();
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /** 当前在途数（已占用配额） */
  get inFlight(): number {
    return this.inFlightCount;
  }

  /** 当前排队数 */
  get queued(): number {
    return this.queue.length;
  }

  /** 获取一个配额；返回的 release 函数必须被调用（建议用 finally / run） */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      this.counters.aborted += 1;
      return Promise.reject(abortReason(signal));
    }
    const max = this.readMax();
    if (this.inFlightCount < max) {
      this.inFlightCount += 1;
      this.counters.acquired += 1;
      return Promise.resolve(this.makeRelease());
    }

    const timeoutMs = this.readTimeout();
    return new Promise<() => void>((resolve, reject) => {
      // 队列已满：立即以 429 语义拒绝，不为一个注定久等的请求再挂定时器与监听
      if (this.queue.length >= this.readMaxQueue()) {
        this.counters.timeouts += 1;
        logger.warn('[llm-gate] 等待队列已满，拒绝本次 LLM 调用（429 语义）', {
          gate: this.name,
          queued: this.queue.length,
          maxQueue: this.readMaxQueue(),
          inFlight: this.inFlightCount,
        });
        reject(new QueueTimeoutError(this.name, 0, timeoutMs));
        return;
      }
      const waiter: Waiter = { settled: false, enqueuedAt: this.now(), resolve, reject };
      this.queue.push(waiter);
      this.counters.queueWaits += 1;
      logger.info('[llm-gate] 并发已满，调用排队等待配额', {
        gate: this.name,
        inFlight: this.inFlightCount,
        queued: this.queue.length,
        maxConcurrency: max,
        queueTimeoutMs: timeoutMs,
      });

      waiter.timer = this.setTimer(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.dropFromQueue(waiter);
        this.detachAbort(waiter);
        this.counters.timeouts += 1;
        const waitedMs = Math.max(0, this.now() - waiter.enqueuedAt);
        logger.warn('[llm-gate] 排队超时，拒绝本次 LLM 调用（429 语义）', {
          gate: this.name,
          waitedMs,
          queueTimeoutMs: timeoutMs,
          inFlight: this.inFlightCount,
          queued: this.queue.length,
        });
        reject(new QueueTimeoutError(this.name, waitedMs, timeoutMs));
      }, timeoutMs);

      // 排队期间的外部取消（客户端断开 / 上层 AbortController）：立即出队，不占位
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.dropFromQueue(waiter);
          if (waiter.timer !== undefined) this.clearTimer(waiter.timer);
          this.detachAbort(waiter);
          this.counters.aborted += 1;
          logger.info('[llm-gate] 排队中的 LLM 调用被取消', {
            gate: this.name,
            queued: this.queue.length,
            inFlight: this.inFlightCount,
          });
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
    });
  }

  /** 在闸门内执行一次调用：无论成功、失败还是被取消，配额都在 finally 归还 */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 计数口径快照（含当前在途/排队数） */
  snapshot(): LimitGateSnapshot {
    return {
      name: this.name,
      maxConcurrency: this.readMax(),
      inFlight: this.inFlightCount,
      queued: this.queue.length,
      ...this.counters,
    };
  }

  /** 清零累计计数（不动在途/排队状态，供测试与运维周期性归零） */
  resetStats(): void {
    this.counters = { acquired: 0, queueWaits: 0, timeouts: 0, aborted: 0, totalQueueWaitMs: 0 };
  }

  /** 幂等的释放函数：重复调用不会多放行配额（否则在途数会被击穿成负数） */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightCount -= 1;
      this.dispatch();
    };
  }

  /** 有空闲配额时按 FIFO 派发；跳过已结清（超时/取消）的 waiter */
  private dispatch(): void {
    const max = this.readMax();
    while (this.queue.length > 0 && this.inFlightCount < max) {
      const waiter = this.queue.shift() as Waiter;
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer !== undefined) this.clearTimer(waiter.timer);
      this.detachAbort(waiter);
      this.inFlightCount += 1;
      this.counters.acquired += 1;
      const waitedMs = Math.max(0, this.now() - waiter.enqueuedAt);
      this.counters.totalQueueWaitMs += waitedMs;
      logger.info('[llm-gate] 排队结束，获得 LLM 并发配额', {
        gate: this.name,
        waitedMs,
        inFlight: this.inFlightCount,
        queued: this.queue.length,
      });
      waiter.resolve(this.makeRelease());
    }
  }

  private dropFromQueue(waiter: Waiter): void {
    const idx = this.queue.indexOf(waiter);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  private detachAbort(waiter: Waiter): void {
    // once 只保证回调只跑一次；派发/超时后仍要显式摘除监听，避免长期持有 signal 引用
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.onAbort = undefined;
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('LLM 调用已取消');
}

/**
 * 生产用单例：并发上限与排队超时**每次调用都重新读环境变量**，
 * 因此运维改 LLM_MAX_CONCURRENCY 不需要重启（也让测试能按用例改环境变量），
 * 同时单例本身不会因为改配置而被重建、丢掉在途计数。
 */
export const llmGate = new LimitGate({
  name: 'llm',
  maxConcurrency: () => resolveMaxConcurrency(),
  queueTimeoutMs: () => resolveQueueTimeoutMs(),
});

/** 闸门计数快照（观测在途/排队/超时；见 logger 输出的 [llm-gate] 行） */
export function getLLMGateSnapshot(): LimitGateSnapshot {
  return llmGate.snapshot();
}

// ============================================================================
// 二、参数限幅（入站校验）
// ============================================================================

/** temperature 合法区间（OpenAI 兼容接口约定） */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;

/**
 * maxTokens 上界默认 4096（LLM_MAX_TOKENS_CAP 可调）。
 * 依据：既有链路里专家/辩论等内部调用最大只用 2000，2000~4096 是"给用户留一倍
 * 余量"的区间；再大对研报类文本收益递减，却线性放大账单与请求时长。
 * 环境变量同样有硬上界，防止把"上限"配成无限大而失去意义。
 */
export const DEFAULT_MAX_TOKENS_CAP = 4096;
export const MAX_TOKENS_CAP_LIMIT = 32_768;

/** 解析 maxTokens 上界：非法值回退默认，超过硬上界则夹紧 */
export function resolveMaxTokensCap(
  raw: string | undefined = process.env.LLM_MAX_TOKENS_CAP,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_TOKENS_CAP;
  return Math.min(Math.floor(n), MAX_TOKENS_CAP_LIMIT);
}

/**
 * 单条消息字符上限 8000。
 * 依据：/api/chat 的单条用户消息已限 2000 字；历史/证据里的助手回答受 maxTokens
 * （≤4096）约束，中文约 1.5 字/token ≈ 6000 字，取 8000 留一点余量。
 */
export const MAX_MESSAGE_CHARS = 8000;

/**
 * 会话历史条数上限 80（= 40 轮）。
 * 依据：chatMemory.MAX_TURNS = 40 轮，持久化侧本就只保留 80 条；
 * 请求侧上限与之对齐，避免出现「服务端存得下、请求里却传不进来」的自相矛盾。
 */
export const MAX_HISTORY_MESSAGES = 80;

/**
 * 单次请求消息总字符上限 40000。
 * 依据：约 10k tokens（英文）/ 25k tokens（中文）输入，加上 maxTokens 上限的
 * 输出仍在主流模型 64k 上下文内；同时把单次调用成本钉住（这才是真正兜底的一条，
 * 条数与单条上限都拦不住"80 条 × 8000 字"的组合）。
 */
export const MAX_TOTAL_MESSAGE_CHARS = 40_000;

export interface MessageLimits {
  maxCount: number;
  maxCharsPerMessage: number;
  maxTotalChars: number;
}

/** 默认限幅口径（messages 与 history 共用；差异只在"越界后是拒绝还是夹紧"） */
export const DEFAULT_MESSAGE_LIMITS: MessageLimits = {
  maxCount: MAX_HISTORY_MESSAGES,
  maxCharsPerMessage: MAX_MESSAGE_CHARS,
  maxTotalChars: MAX_TOTAL_MESSAGE_CHARS,
};

/** 出站消息（与 llm/client.ts 的 ChatMessage 结构兼容，避免 utils → llm 的运行时依赖） */
export interface OutboundChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** 单个数值参数的归一化结果：ok=false 时 error 可直接作为 400 的文案 */
export type ParamOutcome =
  { ok: true; value?: number; clampedFrom?: number } | { ok: false; error: string };

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * temperature 入口校验（路由层用）：
 *  - 未提供（undefined/null）→ 沿用上游默认，不视为错误；
 *  - 非数值 / NaN / ±Infinity → 拒绝（客户端 bug，夹紧只会掩盖问题）；
 *  - 负数 → 拒绝（[0,2] 区间外的负值无意义）；
 *  - > 2 → 夹紧到 2（"尽可能随机"的意图仍然明确，夹紧比 400 更可用）。
 */
export function normalizeTemperatureInput(raw: unknown): ParamOutcome {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, error: `temperature 必须是数值（收到 ${typeName(raw)}）` };
  }
  if (raw < TEMPERATURE_MIN) return { ok: false, error: `temperature 不能为负（收到 ${raw}）` };
  if (raw > TEMPERATURE_MAX) return { ok: true, value: TEMPERATURE_MAX, clampedFrom: raw };
  return { ok: true, value: raw };
}

/**
 * maxTokens 入口校验（路由层用）：
 *  - 未提供 → 沿用默认；
 *  - 非数值 / NaN / ±Infinity → 拒绝；< 1（含 0 和负数）→ 拒绝
 *    （0 是"不生成任何 token"的退化请求，夹紧到 1 只会掩盖客户端 bug）；
 *  - > LLM_MAX_TOKENS_CAP（默认 4096）→ 夹紧到上限，这是账单放大的主要入口。
 */
export function normalizeMaxTokensInput(raw: unknown): ParamOutcome {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, error: `maxTokens 必须是数值（收到 ${typeName(raw)}）` };
  }
  if (raw < 1) return { ok: false, error: `maxTokens 必须 ≥ 1（收到 ${raw}）` };
  const cap = resolveMaxTokensCap();
  if (raw > cap) return { ok: true, value: cap, clampedFrom: raw };
  return { ok: true, value: Math.floor(raw) };
}

/** 内部调用方的宽松夹紧：非法值视为未提供，越界夹紧（不抛错、不拒绝） */
export function clampTemperature(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, TEMPERATURE_MIN), TEMPERATURE_MAX);
}

/** 内部调用方的宽松夹紧：非法值视为未提供，越界夹紧到 [1, cap] */
export function clampMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.floor(value), 1), resolveMaxTokensCap());
}

export type MessagesOutcome =
  { ok: true; messages: OutboundChatMessage[] } | { ok: false; error: string };

/**
 * messages 校验（严格拒绝口径）。为什么这里拒绝而不是夹紧：
 * messages 是调用方**显式构造**的 prompt（通常首条是 system），静默截断/丢条会悄悄
 * 改变语义（丢掉 system 指令或最早的用户约束），出问题时极难排查，所以宁可 400。
 * 会话历史 history 则由客户端本地累积，走夹紧口径（见 clampChatHistory）。
 */
export function validateMessages(
  raw: unknown,
  limits: MessageLimits = DEFAULT_MESSAGE_LIMITS,
): MessagesOutcome {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: '请提供 messages 对话数组（非空）' };
  }
  if (raw.length > limits.maxCount) {
    return { ok: false, error: `messages 最多 ${limits.maxCount} 条（收到 ${raw.length} 条）` };
  }
  const messages: OutboundChatMessage[] = [];
  let totalChars = 0;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `messages[${i}] 必须是对象` };
    }
    const role = item.role;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return { ok: false, error: `messages[${i}].role 必须是 system/user/assistant/tool` };
    }
    const content = item.content;
    if (typeof content !== 'string') {
      return { ok: false, error: `messages[${i}].content 必须是字符串` };
    }
    if (content.length > limits.maxCharsPerMessage) {
      return {
        ok: false,
        error: `messages[${i}].content 超过单条上限 ${limits.maxCharsPerMessage} 字`,
      };
    }
    totalChars += content.length;
    if (totalChars > limits.maxTotalChars) {
      return { ok: false, error: `messages 总字符数超过上限 ${limits.maxTotalChars}` };
    }
    // 只透传已知字段：上游对未知字段可能直接 400（如 "Unrecognized request argument"）
    const message: OutboundChatMessage = {
      role: role as OutboundChatMessage['role'],
      content,
    };
    if (typeof item.name === 'string') message.name = item.name;
    if (typeof item.tool_call_id === 'string') message.tool_call_id = item.tool_call_id;
    if (Array.isArray(item.tool_calls)) {
      message.tool_calls = item.tool_calls as OutboundChatMessage['tool_calls'];
    }
    messages.push(message);
  }
  return { ok: true, messages };
}

export interface ChatTurnShape {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatHistoryOutcome =
  { ok: true; turns: ChatTurnShape[] } | { ok: false; error: string };

/**
 * history 结构校验（路由层用）：非法条目 → 400。
 * 只认 user/assistant：允许system 会让调用方借请求体注入系统指令（越权）。
 * 额外字段（如前端带的 meta）一律忽略，不透传进 prompt。
 */
export function validateChatHistory(
  raw: unknown,
  limits: MessageLimits = DEFAULT_MESSAGE_LIMITS,
): ChatHistoryOutcome {
  if (raw === undefined || raw === null) return { ok: true, turns: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'history 必须是数组' };
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `history[${i}] 必须是对象` };
    }
    if (item.role !== 'user' && item.role !== 'assistant') {
      return { ok: false, error: `history[${i}].role 只能是 user 或 assistant` };
    }
    if (typeof item.content !== 'string') {
      return { ok: false, error: `history[${i}].content 必须是字符串` };
    }
  }
  return { ok: true, turns: clampChatHistory(raw, limits) };
}

/**
 * history 夹紧（服务层兜底用，永不抛错）。为什么夹紧而不是拒绝：
 * history 由客户端本地累积（前端会把整段会话回传），条数增长是正常演化，
 * 400 会直接打断正在进行的对话；而且 chatAgent 还会从持久记忆加载历史，
 * 那条路径根本不经过路由，只能在服务层统一兜底。
 * 口径：结构不合法或非 user/assistant 的条目丢弃；条数超限保留**最近**的 N 条；
 * 单条超长截断；总字符超限从**最旧**的一端丢，直到达标。
 */
export function clampChatHistory(
  raw: unknown,
  limits: MessageLimits = DEFAULT_MESSAGE_LIMITS,
): ChatTurnShape[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const notes: string[] = [];
  let turns: ChatTurnShape[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown> | null;
    if (!record || typeof record !== 'object') continue;
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    if (typeof record.content !== 'string') continue;
    turns.push({ role: record.role, content: record.content });
  }
  if (turns.length !== raw.length) {
    notes.push(`丢弃 ${raw.length - turns.length} 条结构不合法的历史`);
  }

  if (turns.length > limits.maxCount) {
    notes.push(`条数 ${turns.length} > ${limits.maxCount}，保留最近 ${limits.maxCount} 条`);
    turns = turns.slice(turns.length - limits.maxCount);
  }

  let truncated = 0;
  turns = turns.map((t) => {
    if (t.content.length <= limits.maxCharsPerMessage) return t;
    truncated += 1;
    return { role: t.role, content: t.content.slice(0, limits.maxCharsPerMessage) };
  });
  if (truncated > 0) {
    notes.push(`${truncated} 条超过单条 ${limits.maxCharsPerMessage} 字已截断`);
  }

  let total = turns.reduce((sum, t) => sum + t.content.length, 0);
  let dropped = 0;
  while (turns.length > 1 && total > limits.maxTotalChars) {
    total -= turns[0].content.length;
    turns = turns.slice(1);
    dropped += 1;
  }
  if (dropped > 0) {
    notes.push(`总字符超过 ${limits.maxTotalChars}，丢弃最早 ${dropped} 条`);
  }

  if (notes.length > 0) {
    logger.warn('[llm-limits] 对话历史已夹紧', {
      received: raw.length,
      kept: turns.length,
      totalChars: total,
      notes,
    });
  }
  return turns;
}

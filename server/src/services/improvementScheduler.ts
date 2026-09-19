/**
 * 改进循环的周期调度（无人值守）
 * ----------------------------------------------------------------------------
 * 让闭环自己按期跑「读经验 → 调判据」，不需要人记得去点接口。
 *
 * 与 `scheduler.ts`（主动监控）同一范式：首次延迟一个间隔、单轮失败不终止循环、
 * 连续失败指数退避（封顶 8 倍）、连续失败达上限自动停止、timer `unref()` 不阻止
 * 进程退出；用 setTimeout 链而不是 setInterval，**结构上不可能重叠**。
 *
 * 与监控循环的三点不同，各有理由：
 *   1. 默认间隔 6 小时而非 5 分钟。判据调优的输入是"新攒下的实验"，而实验按天
 *      积累；跑得更勤只会反复得出"没有未探索过的候选"，白写台账。
 *   2. 首次延迟 10 分钟而非一个完整间隔。启动即跑会与预热（stockMaster、缓存
 *      清理）抢 I/O，而等到 6 小时后才给第一次反馈又太迟。
 *   3. 连续失败上限取 5 而非 10。间隔以小时计，连续 5 次失败意味着环境出了
 *      需要人介入的问题，继续按小时重试没有意义。
 *
 * 关闭方式：`IMPROVEMENT_INTERVAL_HOURS=0`（与 researchDigest 同约定），
 * 启动时不注册定时器；也可以运行期调 `/api/improvement/scheduler/stop`。
 */
import { runImprovementRound, type ImprovementRoundResult } from '../quant/improvementLoop.js';
import logger from '../utils/logger.js';

/** 连续失败达到该次数后自动停止循环（间隔以小时计，5 次足以说明环境有问题） */
const MAX_CONSECUTIVE_ERRORS = 5;
/** 失败退避倍数上限：第 2 次失败起间隔翻倍，最多放大 8 倍 */
const MAX_BACKOFF_MULTIPLIER = 8;
/** 默认间隔：6 小时 */
const DEFAULT_INTERVAL_HOURS = 6;
/** 首次运行延迟：10 分钟（避开启动预热） */
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

export interface ImprovementLoopState {
  running: boolean;
  /** 当前生效的轮询间隔（毫秒） */
  intervalMs: number;
  /** 最近一轮结束时间（ISO） */
  lastRunAt?: string;
  /** 最近一轮的结局说明（中文，可直接展示） */
  lastReason?: string;
  /** 最近一轮是否真的改动了判据 */
  lastChanged: boolean;
  /** 已发起的轮次（含失败轮次） */
  runCount: number;
  /** 抛异常的轮次数 */
  errorCount: number;
  /** 连续失败次数（成功后清零），退避与自动停止的依据 */
  consecutiveErrors: number;
  /** 是否因连续失败被自动停止（与用户主动 stop 区分开） */
  stoppedByErrors: boolean;
  /** 最近一次失败原因 */
  lastError?: string;
}

export interface ImprovementLoopController {
  stop: () => void;
  getState: () => ImprovementLoopState;
}

export interface ImprovementSchedulerOptions {
  /** 轮询间隔（毫秒）；不传则读 env，再退回默认 6 小时 */
  intervalMs?: number;
  /** 首次运行延迟（毫秒）；测试可传 0 */
  firstRunDelayMs?: number;
  /** 跑一轮的函数；默认即真正的改进循环（测试注入替身） */
  runRound?: () => ImprovementRoundResult;
  /** 每轮结束的回调（用于日志之外的通知） */
  onResult?: (result: ImprovementRoundResult) => void;
}

/**
 * 解析 `IMPROVEMENT_INTERVAL_HOURS`。
 * 0 或负数表示**关闭**（返回 null）；非有限值按未配置处理。
 * 与 researchDigest 的 `QUANT_DIGEST_INTERVAL_HOURS` 同约定，避免两处语义漂移。
 */
export function resolveIntervalFromEnv(): number | null {
  const raw = process.env.IMPROVEMENT_INTERVAL_HOURS;
  if (raw === undefined || raw.length === 0) return DEFAULT_INTERVAL_HOURS * 3600_000;
  const hours = Number(raw);
  if (!Number.isFinite(hours)) return DEFAULT_INTERVAL_HOURS * 3600_000;
  if (hours <= 0) return null; // 显式关闭
  // 上限 30 天：防手滑把 100000 填进来导致"永远不会跑"
  return Math.min(hours, 720) * 3600_000;
}

/** 当前调度器（模块级单例；start 会先停掉旧的，避免同一个进程里叠出两条定时器链） */
let current: ImprovementLoopController | null = null;

/** 启动周期调度；env 关闭时返回 null（不注册任何定时器） */
export function startImprovementScheduler(
  opts: ImprovementSchedulerOptions = {},
): ImprovementLoopController | null {
  const envInterval = resolveIntervalFromEnv();
  const intervalMs = opts.intervalMs ?? envInterval;
  if (intervalMs === null) return null; // env 显式关闭

  stopImprovementScheduler();

  const state: ImprovementLoopState = {
    running: true,
    intervalMs,
    lastChanged: false,
    runCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    stoppedByErrors: false,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const runRound = opts.runRound ?? (() => runImprovementRound());

  // setTimeout 链而非 setInterval：上一轮结束后才排下一轮，**结构上不会重叠**
  const scheduleNext = (): void => {
    if (!state.running) return;
    if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      state.running = false;
      state.stoppedByErrors = true;
      timer = null;
      logger.warn('[improvement] 连续失败达上限，调度已自动停止', {
        consecutiveErrors: state.consecutiveErrors,
        lastError: state.lastError,
      });
      return;
    }
    const backoff =
      state.consecutiveErrors <= 1
        ? 1
        : Math.min(2 ** (state.consecutiveErrors - 1), MAX_BACKOFF_MULTIPLIER);
    timer = setTimeout(tick, intervalMs * backoff);
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  };

  const tick = (): void => {
    // 轮次先自增：失败轮次也要计入，便于观测"跑了几轮 / 错了几轮"
    state.runCount += 1;
    try {
      const result = runRound();
      state.consecutiveErrors = 0;
      state.lastRunAt = new Date().toISOString();
      state.lastChanged = result.changed;
      state.lastReason = result.reason;
      if (result.changed) {
        logger.info('[improvement] 保留了一次判据改动', { reason: result.reason });
      }
      opts.onResult?.(result);
    } catch (err) {
      state.errorCount += 1;
      state.consecutiveErrors += 1;
      state.lastError = err instanceof Error ? err.message : String(err);
      // 改进循环本身不外抛；走到这里说明连它都没兜住，值得记 error 级
      logger.error('[improvement] 调度轮次异常', { err: err as Error });
    }
    scheduleNext();
  };

  timer = setTimeout(tick, opts.firstRunDelayMs ?? FIRST_RUN_DELAY_MS);
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  const controller: ImprovementLoopController = {
    stop() {
      state.running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (current === controller) current = null;
    },
    getState: () => ({ ...state }),
  };
  current = controller;
  return controller;
}

/** 停止周期调度（未启动时是空操作） */
export function stopImprovementScheduler(): void {
  if (current) current.stop();
  current = null;
}

/** 当前调度状态；未启动返回 null（供状态接口如实披露） */
export function getImprovementSchedulerState(): ImprovementLoopState | null {
  return current ? current.getState() : null;
}

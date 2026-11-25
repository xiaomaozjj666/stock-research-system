/**
 * 个股分析域：单只分析 / 多股对比 / 流式分析（SSE 内核见 api/sse.ts）。
 */
import type { AnalysisResult, CompareResponse } from '../../types';
import { isCancelled } from '../http';
import { SseSession } from '../sse';
import {
  api,
  AnalysisCancelledError,
  BACKEND_UNREACHABLE_MESSAGE,
  normalizeApiError,
} from './base';

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
    if (isCancelled(error)) throw new Error('请求已取消');
    throw normalizeApiError(error, '分析请求失败');
  } finally {
    currentController = null;
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
    if (isCancelled(error)) throw new AnalysisCancelledError('对比分析已取消');
    throw normalizeApiError(error, '对比分析失败');
  }
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
  /**
   * 自动重连即将开始时回调（attempt 从 1 起）。此前重连期间界面完全静止，
   * 用户会以为卡死；加载屏据此显示「正在第 N 次重连」。
   */
  onReconnect?: (attempt: number, maxRetries: number) => void;
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
  const path = `/api/analyze/stream?stockCode=${encodeURIComponent(stockCode)}${
    options.resume ? '&resume=1' : ''
  }`;

  let resolveDone!: (r: AnalysisResult) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<AnalysisResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let settled = false;
  let cancelled = false;
  let retryCount = 0;

  function finish(err: Error | null, result?: AnalysisResult) {
    if (settled) return;
    settled = true;
    session.close();
    if (err) rejectDone(err);
    else resolveDone(result as AnalysisResult);
  }

  const session = new SseSession({
    path,
    onFrame: (raw) => {
      const data = raw as AnalysisStage;
      if (data.phase === 'done' && data.result) {
        finish(null, data.result);
      } else if (data.phase === 'error') {
        finish(new Error(data.message || '分析过程出错'));
      } else {
        // 与旧实现一致：settle 之后队列里剩余的帧仍会回调 onStage（此流无 settled 守卫）
        onStage(data);
      }
    },
    onParseError: (raw, err) => {
      // 解析失败不再静默吞掉：记录原始帧并回调可见错误事件；
      // 不 finish——单个坏帧不应让整次分析以失败收尾
      console.error('[analyzeStream] SSE 帧 JSON 解析失败', { raw: raw.slice(0, 200), err });
      onStage({
        phase: 'error',
        message: '分析进度数据解析失败：收到无法解码的服务端帧（详情见控制台）',
      });
    },
    onWatchdogTimeout: () => {
      // 首包看门狗：若 20s 内一条事件都没收到，判定为服务不可用
      if (!session.received)
        finish(new Error('后端无响应：20 秒内未收到任何分析进度，请确认服务是否正常'));
    },
    onTransportError: () => {
      // EventSource 在正常结束时也会触发 error，已 settle 的场景直接忽略
      if (settled || cancelled) return;
      session.disconnect();
      // 已收到过事件后断开：分析无法续传，直接报错
      if (session.received) {
        finish(new Error('连接中断，分析未完成，请重试'));
        return;
      }
      // 从未收到事件：指数退避重连（1s/2s/4s…），耗尽后报连接失败（H-03）
      if (retryCount < maxRetries) {
        retryCount += 1;
        options.onReconnect?.(retryCount, maxRetries);
        session.reconnectAfter(1000 * 2 ** (retryCount - 1));
        return;
      }
      finish(new Error(BACKEND_UNREACHABLE_MESSAGE));
    },
  });

  session.open();

  return {
    cancel: () => {
      cancelled = true;
      // settle done：让 `await done` 的调用方能收尾（此前永久挂起，靠调用方手动兜底掩盖）
      finish(new AnalysisCancelledError());
    },
    done,
  };
}

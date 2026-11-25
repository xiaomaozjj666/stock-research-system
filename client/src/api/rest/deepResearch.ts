import type {
  POSTApiResearchDeepRequestBody as DeepResearchRequest,
  POSTApiResearchDeepResponse as DeepResearchResult,
  ResearchCheckpointSummary as DeepResearchCheckpointSummary,
  ResearchRunSummary as DeepResearchRunSummary,
  SavedResearchRun as SavedDeepResearchRun,
} from '../generated';
import { SseSession } from '../sse';
import { api, normalizeApiError } from './base';

/* ============================================================================
 * 多步深度研究（Deep Research）
 * ==========================================================================*/

/** 深度研究的完整结果（报告 / 计划 / 证据 / 验证 / 事件 / 统计） */
export type { DeepResearchRequest, DeepResearchResult };

/** 研究过程中推送的单条 Agent 事件（规划 / 检索 / 验证 / 编排） */
export type DeepResearchEvent = DeepResearchResult['events'][number];

/**
 * SSE 帧。与 routes/research.ts 一一对应：
 * run_meta 首帧携带 runId（断线续跑凭据），agent_event 是过程推送，
 * done 携带完整结果，error 表示中止。
 */
export type DeepResearchStreamEvent =
  | {
      phase: 'run_meta';
      runId: string;
      /** 本次是否从断点续跑 */
      resumed: boolean;
      /** 续跑起点：已完成的轮次（0 表示全新研究） */
      resumedFromRound: number;
    }
  | { phase: 'agent_event'; event: DeepResearchEvent }
  | { phase: 'done'; result: DeepResearchResult }
  | { phase: 'error'; message?: string };

export interface DeepResearchOptions {
  scope?: DeepResearchRequest['scope'];
  config?: DeepResearchRequest['config'];
  /**
   * 断线续跑：带上首帧 run_meta 里的 runId，服务端从断点已完成的轮次继续，
   * 已完成的子问题复用验证结论与证据（不重复付费）。
   */
  runId?: string;
}

/**
 * 深度研究中断错误（可在已收到事件后凭 runId 续跑）。
 * 比普通 Error 多带三个字段，页面据此渲染「继续研究」按钮而不是只报一句失败。
 */
export class DeepResearchInterruptedError extends Error {
  /** 是否可续跑（已拿到 runId） */
  readonly canResume: boolean;
  readonly runId?: string;
  /** 本次（若为续跑）从中断处恢复的已完成轮次 */
  readonly resumedFromRound?: number;

  constructor(
    message: string,
    opts: { canResume: boolean; runId?: string; resumedFromRound?: number },
  ) {
    super(message);
    this.name = 'DeepResearchInterruptedError';
    this.canResume = opts.canResume;
    this.runId = opts.runId;
    this.resumedFromRound = opts.resumedFromRound;
  }
}

/**
 * 同步版：等整轮研究跑完一次性返回。
 * 超时给到 5.5 分钟（服务端同步接口上限 5 分钟），确保服务端的超时提示先于
 * 浏览器侧的网络超时抵达——否则用户只会看到笼统的「网络错误」。
 */
export async function runDeepResearch(question: string): Promise<DeepResearchResult> {
  try {
    const response = await api.post<DeepResearchResult>(
      '/research/deep',
      { question },
      { timeout: 330000 },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '深度研究失败');
  }
}

/**
 * 流式版：逐条推送 Agent Event，最终 resolve 完整结果。
 *
 * 断线续跑：服务端首帧 run_meta 携带 runId；「已收到事件后断开」时以
 * `DeepResearchInterruptedError` reject（带 runId / canResume），页面可带上
 * 该 runId 重新调用本函数从已完成的轮次继续——服务端复用已落盘的计划、证据与
 * 验证结论，不会把已完成的部分重跑一遍（时间与成本双省）。
 */
export function runDeepResearchStream(
  question: string,
  onEvent: (event: DeepResearchStreamEvent) => void,
  options: DeepResearchOptions = {},
): { cancel: () => void; done: Promise<DeepResearchResult> } {
  const params = new URLSearchParams();
  // 续跑时问题可省略（服务端以断点记录为准），空串不再当作参数上传
  if (question.trim() !== '') params.set('question', question.trim());
  if (options.scope) params.set('scope', JSON.stringify(options.scope));
  if (options.config) params.set('config', JSON.stringify(options.config));
  if (options.runId) params.set('runId', options.runId);
  const path = `/api/research/deep/stream?${params.toString()}`;

  let resolveDone!: (r: DeepResearchResult) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<DeepResearchResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let settled = false;
  /** 首帧 run_meta：断线时据此把 runId 交给调用方续跑 */
  let runMeta: { runId: string; resumedFromRound: number } | null = null;

  const interrupted = (message: string): DeepResearchInterruptedError =>
    new DeepResearchInterruptedError(message, {
      canResume: Boolean(runMeta?.runId),
      runId: runMeta?.runId,
      resumedFromRound: runMeta?.resumedFromRound,
    });

  function finish(err: Error | null, result?: DeepResearchResult) {
    if (settled) return;
    settled = true;
    session.close();
    if (err) rejectDone(err);
    else resolveDone(result as DeepResearchResult);
  }

  const session = new SseSession({
    path,
    onFrame: (raw) => {
      const data = raw as DeepResearchStreamEvent;
      if (data.phase === 'run_meta') {
        runMeta = { runId: data.runId, resumedFromRound: data.resumedFromRound };
        // 透传给页面：续跑时用它渲染「已从第 N 轮继续」的可见提示
        onEvent(data);
        return;
      }
      if (data.phase === 'done') {
        finish(null, data.result);
        return;
      }
      if (data.phase === 'error') {
        // 服务端已发 error 帧：已落盘的轮次仍可续跑，别让用户从头再来
        finish(interrupted(data.message || '深度研究失败'));
        return;
      }
      onEvent(data);
    },
    onParseError: () => {
      // 单帧坏掉不应终止整次研究：回调一个可见错误后继续等后续帧
      // （与本流旧实现一致：不写 console；个股分析/聊天流才会写）
      onEvent({ phase: 'error', message: '研究进度数据解析失败（收到无法解码的服务端帧）' });
    },
    onWatchdogTimeout: () => {
      // 首包看门狗：规划阶段要先跑一次 LLM，20 秒内连一条事件都没有说明服务不可用
      if (!session.received) {
        finish(
          new Error(
            options.runId
              ? '后端无响应：20 秒内未收到续跑进度，请确认服务是否正常'
              : '后端无响应：20 秒内未收到研究进度，请确认服务是否正常',
          ),
        );
      }
    },
    onTransportError: () => {
      if (settled) return;
      if (session.received) {
        finish(interrupted('连接中断，研究未完成；可从此前已完成的轮次继续'));
        return;
      }
      if (options.runId) {
        // 续跑请求首包前就断开：EventSource 读不到 4xx/5xx 响应体，无法区分
        // 「断点已过期」「该研究仍在收尾」与「服务没起」，文案给全三种可能。
        // 保留续跑入口（canResume=true）：断点可能只是仍在收尾，稍后可重试。
        finish(
          new DeepResearchInterruptedError(
            '续跑未能开始：断点可能已过期，或该研究仍在进行中，请稍后重试',
            { canResume: true, runId: options.runId },
          ),
        );
        return;
      }
      finish(
        new Error(
          // EventSource 读不到 4xx/5xx 的响应体，无法区分「服务没起」与「服务起了但未配 LLM 密钥」；
          // 这两种情况都表现为首包前断开，所以文案要同时给出两个可操作原因，而不是断言服务没启动。
          '无法开始研究：请确认后端服务已启动，且已配置 LLM 密钥（DEEPSEEK_API_KEY 或 OPENAI_API_KEY）',
        ),
      );
    },
  });

  session.open();

  return {
    cancel: () => finish(new Error('已取消本次研究')),
    done,
  };
}

/* ---------------------------------------------------------------- 研究库 */

/** 历史研究摘要（列表用，不含报告正文） */
export type { DeepResearchRunSummary, SavedDeepResearchRun };

/** 可续跑断点摘要（未完成的研究，凭 runId 续跑） */
export type { DeepResearchCheckpointSummary };

/**
 * 列出可续跑的未完成研究（新 -> 旧）。
 * 页面刷新后凭这里的 runId 恢复「继续研究」入口：一次研究几十次 LLM 调用，
 * 断线（关页/切网）不应意味着整次作废。
 */
export async function listResumableDeepResearchRuns(
  limit = 20,
): Promise<DeepResearchCheckpointSummary[]> {
  try {
    const response = await api.get<{ items: DeepResearchCheckpointSummary[] }>(
      '/research/deep/resumable',
      { params: { limit }, timeout: 15000 },
    );
    return response.data.items;
  } catch (error: unknown) {
    throw normalizeApiError(error, '可续跑研究读取失败');
  }
}

/** 列出历史研究（新 -> 旧） */
export async function listDeepResearchRuns(limit = 20): Promise<DeepResearchRunSummary[]> {
  try {
    const response = await api.get<{ items: DeepResearchRunSummary[] }>('/research/runs', {
      params: { limit },
      timeout: 15000,
    });
    return response.data.items;
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史研究读取失败');
  }
}

/** 回看某次研究的完整结果（报告 / 证据 / 事件轨迹 / 统计） */
export async function getDeepResearchRun(id: string): Promise<SavedDeepResearchRun> {
  try {
    const response = await api.get<SavedDeepResearchRun>(
      `/research/runs/${encodeURIComponent(id)}`,
      { timeout: 20000 },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史研究读取失败');
  }
}

/** 删除一条历史研究 */
export async function deleteDeepResearchRun(id: string): Promise<{ ok: boolean }> {
  try {
    const response = await api.delete<{ ok: boolean }>(`/research/runs/${encodeURIComponent(id)}`, {
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史研究删除失败');
  }
}

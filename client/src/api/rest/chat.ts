import type {
  POSTApiChatHistoryClearResponse as ClearHistoryResponse,
  ChatAgentResponse as GeneratedChatAgentResponse,
  ChatEvidence as GeneratedChatEvidence,
} from '../generated';
import { isCancelled } from '../http';
import { SseSession } from '../sse';
import { api, AnalysisCancelledError, normalizeApiError } from './base';

// === 对话式助手 ===
/**
 * 对话相关类型全部收敛到契约生成的定义。
 *
 * 逐个字段比对过生成物与手写版，结构完全一致，故这里只做别名、不改任何字段。
 * 收益不是省几行代码，而是**它们从此跟着契约走**：服务端给 ChatAgentResponse
 * 加字段时，生成物会更新、这里也会跟着变；此前手写版会静默停留在旧形状。
 * 公开名保留（ChatDebate / RiskDebateResult / AgentPlan / AnswerVerification /
 * CalculationError / ChatEvidence 都有其它模块在 import，改名是破坏性变更）。
 */
export type ChatEvidence = GeneratedChatEvidence;
export type ChatAgentResponse = GeneratedChatAgentResponse;
/** debate / riskDebate / plan / verification 在契约里是内联对象，用索引访问取，勿另立定义 */
export type ChatDebate = NonNullable<ChatAgentResponse['debate']>;
export type RiskDebateResult = NonNullable<ChatAgentResponse['riskDebate']>;
export type AgentPlan = NonNullable<ChatAgentResponse['plan']>;
export type AnswerVerification = NonNullable<ChatAgentResponse['verification']>;
export type CalculationError = NonNullable<
  NonNullable<ChatAgentResponse['verification']>['calculationErrors'][number]
>;

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
    if (isCancelled(error)) throw new AnalysisCancelledError('已取消本次回答');
    throw normalizeApiError(error, '对话请求失败');
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

  let settled = false;
  const finish = (evt: ChatStreamEvent) => {
    if (settled) return;
    settled = true;
    session.close();
    onEvent(evt);
  };

  const session = new SseSession({
    path: `/api/chat/stream?${params.toString()}`,
    onFrame: (raw) => {
      // 已收尾（done/error/cancel）后不再回调：close() 只能阻止后续事件到达，
      // 已排进任务队列的那一帧仍会执行——组件已卸载时回调会让调用方在废弃的会话上 setState
      if (settled) return;
      const data = raw as ChatStreamEvent;
      if (data.phase === 'done' || data.phase === 'error') finish(data);
      else onEvent(data);
    },
    onParseError: (raw, err) => {
      // 解析失败不再静默吞掉：记录原始帧（截断防刷屏）并给出**可见错误事件**，
      // 但不 settle——单个坏帧不应终止后续正常事件流；已 settle 后与旧实现一致地丢弃
      if (settled) return;
      console.error('[chatStream] SSE 帧 JSON 解析失败', { raw: raw.slice(0, 200), err });
      onEvent({
        phase: 'error',
        message: '对话数据解析失败：收到无法解码的服务端帧（详情见控制台），可重试',
      });
    },
    onWatchdogTimeout: () => {
      // 首包看门狗：20 秒内没收到任何事件即判定服务不可用，避免静默挂起
      if (!settled)
        finish({
          phase: 'error',
          message: '后端无响应：20 秒内未收到任何进度，请确认服务是否正常',
        });
    },
    onTransportError: () => {
      if (!settled) finish({ phase: 'error', message: '连接中断，对话未完成，请重试' });
    },
  });

  session.open();
  return {
    cancel: () => {
      settled = true;
      session.close();
    },
  };
}

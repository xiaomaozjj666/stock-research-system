import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatWithAgentStream, type ChatStreamEvent } from '../client.js';

/**
 * chatWithAgentStream 生命周期测试
 * ----------------------------------------------------------------------------
 * 聊天流此前只经 ChatPanel 的 mock 间接覆盖（真实实现从未被执行）。改成共享
 * SseSession 后，这里锁定它自己的可观察行为：20s 首包看门狗、done/error 收尾、
 * 断线文案、cancel 后不再回调（聊天流独有：cancel 不产生任何事件）。
 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(evt: ChatStreamEvent) {
    this.onmessage?.({ data: JSON.stringify(evt) });
  }
  emitError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chatWithAgentStream', () => {
  it('20s 内无任何事件 → 回调「后端无响应」错误事件并关闭连接', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('问题', (e) => events.push(e));
    const es = MockEventSource.instances[0];

    vi.advanceTimersByTime(20_000);
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('error');
    expect(events[0].message).toContain('后端无响应');
    expect(es.closed).toBe(true);
  });

  it('收到事件后看门狗解除，不会在 20s 时产生错误事件', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('问题', (e) => events.push(e));
    MockEventSource.instances[0].emit({ phase: 'planning', message: '规划中' });

    vi.advanceTimersByTime(30_000);
    expect(events.map((e) => e.phase)).toEqual(['planning']);
  });

  it('done 帧收尾：回调一次、关闭连接，后续队列中的帧不再回调（settled 守卫）', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('问题', (e) => events.push(e));
    const es = MockEventSource.instances[0];
    es.emit({ phase: 'planning', message: '规划中' });
    es.emit({
      phase: 'done',
      message: '完成',
      response: { answer: '回复', toolsUsed: [], evidence: [], degraded: false },
    });
    expect(es.closed).toBe(true);

    es.emit({ phase: 'retrieving', message: '不应再回调' });
    expect(events.map((e) => e.phase)).toEqual(['planning', 'done']);
  });

  it('error 帧收尾后，传输层 error 不再产生第二个事件', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('问题', (e) => events.push(e));
    const es = MockEventSource.instances[0];
    es.emit({ phase: 'error', message: '服务端主动结束' });
    es.emitError();
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('服务端主动结束');
  });

  it('首包前断线 → 「连接中断，对话未完成，请重试」', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('问题', (e) => events.push(e));
    MockEventSource.instances[0].emitError();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'error',
      message: '连接中断，对话未完成，请重试',
    });
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it('cancel 静默关闭：不产生任何事件，20s 后也不触发看门狗', () => {
    const events: ChatStreamEvent[] = [];
    const { cancel } = chatWithAgentStream('问题', (e) => events.push(e));
    const es = MockEventSource.instances[0];
    cancel();
    expect(es.closed).toBe(true);

    es.emit({
      phase: 'done',
      message: '迟到',
      response: { answer: '迟到', toolsUsed: [], evidence: [], degraded: false },
    });
    vi.advanceTimersByTime(30_000);
    expect(events).toHaveLength(0);
  });

  it('sessionId 参与 query（会话记忆依赖它）', () => {
    chatWithAgentStream('问题', () => {}, { sessionId: 's-1' });
    const url = MockEventSource.instances[0].url;
    expect(url).toContain('message=');
    expect(url).toContain('sessionId=s-1');
  });
});

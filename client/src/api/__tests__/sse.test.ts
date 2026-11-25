// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSE_WATCHDOG_MS, SseSession } from '../sse.js';

/**
 * SSE 共享内核单测
 * ----------------------------------------------------------------------------
 * 三条流（个股分析 / 聊天 / 深度研究）已改为复用 SseSession，这里锁定内核自身
 * 的机制契约：看门狗、坏帧容错、重连时序、令牌快照、close 语义。各端点自己的
 * 文案与 settle 语义由 analyzeStream / deepResearchStream / chatStream 用例覆盖。
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
  emit(raw: string | unknown) {
    this.onmessage?.({ data: typeof raw === 'string' ? raw : JSON.stringify(raw) });
  }
  fail() {
    this.onerror?.();
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  localStorage.clear();
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SseSession', () => {
  it('open 建立连接；看门狗默认 20s，超时只回调一次', () => {
    const onWatchdogTimeout = vi.fn();
    const session = new SseSession({
      path: '/api/x/stream?a=1',
      onFrame: () => {},
      onWatchdogTimeout,
    });
    session.open();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toContain('/api/x/stream?a=1');

    vi.advanceTimersByTime(SSE_WATCHDOG_MS - 1);
    expect(onWatchdogTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onWatchdogTimeout).toHaveBeenCalledTimes(1);
  });

  it('收到任意帧即解除看门狗；坏帧不派发 onFrame 但仍算「收到过」', () => {
    const onFrame = vi.fn();
    const onParseError = vi.fn();
    const onWatchdogTimeout = vi.fn();
    const session = new SseSession({
      path: '/api/x',
      onFrame,
      onParseError,
      onWatchdogTimeout,
    });
    session.open();

    MockEventSource.instances[0].emit('{不是合法 JSON');
    expect(onParseError).toHaveBeenCalledWith('{不是合法 JSON', expect.any(Error));
    expect(onFrame).not.toHaveBeenCalled();
    expect(session.received).toBe(true);

    // 坏帧之后看门狗不再触发，后续正常帧继续派发（坏帧不终止事件流）
    vi.advanceTimersByTime(SSE_WATCHDOG_MS);
    expect(onWatchdogTimeout).not.toHaveBeenCalled();
    MockEventSource.instances[0].emit({ phase: 'ok' });
    expect(onFrame).toHaveBeenCalledWith({ phase: 'ok' });
  });

  it('reconnectAfter 先关闭旧连接，到点重开并重新武装看门狗', () => {
    const onWatchdogTimeout = vi.fn();
    const session = new SseSession({
      path: '/api/x',
      onFrame: () => {},
      onWatchdogTimeout,
      watchdogMs: 100,
    });
    session.open();
    const first = MockEventSource.instances[0];

    session.reconnectAfter(1000);
    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances).toHaveLength(2);
    // 旧连接的看门狗已随 disconnect 清除，新连接从重连时刻重新计时
    expect(onWatchdogTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(onWatchdogTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onWatchdogTimeout).toHaveBeenCalledTimes(1);
  });

  it('close 取消待定重连，此后 open 不建立新连接', () => {
    const session = new SseSession({ path: '/api/x', onFrame: () => {} });
    session.open();
    session.reconnectAfter(1000);
    session.close();

    vi.advanceTimersByTime(10_000);
    expect(MockEventSource.instances).toHaveLength(1);
    session.open();
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('传输层 error 原样交给调用方（重连或 settle 由端点决定）', () => {
    const onTransportError = vi.fn();
    const session = new SseSession({ path: '/api/x', onFrame: () => {}, onTransportError });
    session.open();
    MockEventSource.instances[0].fail();
    expect(onTransportError).toHaveBeenCalledTimes(1);
  });

  it('令牌在构造时快照：重连沿用同一份，不重读 localStorage', () => {
    localStorage.setItem('srs:api-token', 'tok-a');
    const session = new SseSession({ path: '/api/x?y=1', onFrame: () => {} });
    session.open();
    expect(MockEventSource.instances[0].url).toContain('y=1');
    expect(MockEventSource.instances[0].url).toContain('token=tok-a');

    localStorage.setItem('srs:api-token', 'tok-b');
    session.reconnectAfter(1000);
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances[1].url).toContain('token=tok-a');
  });

  it('close 后已排队的帧仍会派发（是否忽略由调用方自己的 settled 守卫决定）', () => {
    const onFrame = vi.fn();
    const session = new SseSession({ path: '/api/x', onFrame });
    session.open();
    const es = MockEventSource.instances[0];
    session.close();
    // 与旧实现一致：EventSource.close() 只阻止后续到达，已排队的那一帧仍会执行
    es.emit({ phase: 'late' });
    expect(onFrame).toHaveBeenCalledWith({ phase: 'late' });
  });
});

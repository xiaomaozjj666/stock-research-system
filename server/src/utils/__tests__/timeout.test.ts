import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout } from '../timeout.js';

/**
 * withTimeout 行为测试
 * ----------------------------------------------------------------------------
 * 核心诉求：超时不只是「调用方这边 reject」，还要**真正取消上游**——
 * 否则底层 fetch / 流继续跑完，socket 与配额仍被占着。
 * 因此这里用假定时器 + 永不 settle 的 promise + 真实 AbortController，
 * 断言 controller.signal.aborted，而不是只看 reject。
 */

/** 永不 settle 的 promise：模拟上游连接不断、数据也不来 */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** 把 promise 结果转成可断言的 settled 快照（先挂处理器，避免 unhandled rejection） */
async function outcome<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: Error) => ({ ok: false as const, error }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout —— 超时真正取消上游', () => {
  it('超时后 controller.signal.aborted === true，且以含毫秒数的超时错误 reject', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const settled = outcome(withTimeout(never(), 5000, { controller }));

    expect(controller.signal.aborted).toBe(false); // 未到点不能提前取消
    vi.advanceTimersByTime(4999);
    expect(controller.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    const result = await settled;

    expect(result.ok).toBe(false);
    expect((result as { error: Error }).error.message).toMatch(/timeout/);
    expect((result as { error: Error }).error.message).toContain('5000ms');
    expect(controller.signal.aborted).toBe(true);
  });

  it('超时会调用 onTimeout 回调（且只调一次）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onTimeout = vi.fn();

    const settled = outcome(withTimeout(never(), 100, { controller, onTimeout }));
    vi.advanceTimersByTime(100);
    await settled;
    vi.advanceTimersByTime(1000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it('超时 aborted 后底层请求随之失败，不会反而被误报成「调用方取消」', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    // 模拟底层 fetch：signal abort 时以 AbortError 失败（abort 是同步派发的，
    // 若实现里先 abort 后落定，这里就会把超时改写成「调用方取消」）
    const upstream = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason as Error));
    });

    const settled = outcome(withTimeout(upstream, 300, { controller }));
    vi.advanceTimersByTime(300);
    const result = await settled;

    expect((result as { error: Error }).error.message).toMatch(/timeout: 300ms/);
    expect((result as { error: Error }).error.message).not.toMatch(/abort/i);
  });

  it('不传 opts 时保持向后兼容：仍然超时 reject（含毫秒数）', async () => {
    vi.useFakeTimers();

    const settled = [outcome(withTimeout(never(), 1000)), outcome(withTimeout(never(), 2000))];
    vi.advanceTimersByTime(2000);

    const [a, b] = await Promise.all(settled);
    expect((a as { error: Error }).error.message).toMatch(/timeout.*1000ms/);
    expect((b as { error: Error }).error.message).toMatch(/timeout.*2000ms/);
  });

  it('超时定时器不残留（不会二次触发）', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const settled = outcome(withTimeout(never(), 300, { onTimeout }));
    vi.advanceTimersByTime(300);
    await settled;

    expect(vi.getTimerCount()).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('onTimeout 回调抛错也不能吞掉超时（promise 必须落定）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const settled = outcome(
      withTimeout(never(), 200, {
        controller,
        onTimeout: () => {
          throw new Error('记账失败');
        },
      }),
    );
    vi.advanceTimersByTime(200);
    const result = await settled;

    expect((result as { error: Error }).error.message).toMatch(/timeout: 200ms/);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('withTimeout —— 未超时 / 已取消', () => {
  it('未超时时正常返回，且清掉定时器（signal 不被 abort）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const result = await outcome(withTimeout(Promise.resolve('ok'), 5000, { controller }));

    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000); // 之后也不该冒出超时 reject
    expect(controller.signal.aborted).toBe(false);
  });

  it('未超时时上游自身的失败原样透传（不被改写成超时）', async () => {
    vi.useFakeTimers();

    const result = await outcome(withTimeout(Promise.reject(new Error('上游 500')), 5000));

    expect((result as { error: Error }).error.message).toBe('上游 500');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('调用前就已取消：不会被误报成超时（保持 pending，等上游自己结束）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    const result = outcome(withTimeout(never(), 1000, { controller }));
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('调用前就已取消：上游以取消原因失败时透传 AbortError，而不是超时错误', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    const upstream = Promise.reject(controller.signal.reason as Error);
    const result = await outcome(withTimeout(upstream, 1000, { controller }));

    expect((result as { error: Error }).error.message).toMatch(/abort/i);
    expect((result as { error: Error }).error.message).not.toMatch(/timeout/);
  });

  it('等待期间被外部取消：立即以取消原因 reject（不是超时），并清掉定时器', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const settled = outcome(withTimeout(never(), 10_000, { controller }));
    vi.advanceTimersByTime(100);
    controller.abort();
    const result = await settled;

    expect((result as { error: Error }).error.message).toMatch(/abort/i);
    expect((result as { error: Error }).error.message).not.toMatch(/timeout/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('等待期间被外部取消后可自定义原因（signal.reason 原样透传）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const settled = outcome(withTimeout(never(), 10_000, { controller }));
    controller.abort(new Error('批量回测已中止'));
    const result = await settled;

    expect((result as { error: Error }).error.message).toBe('批量回测已中止');
  });

  it('只传 signal（无 controller）：能识别取消，但超时时不会误报成取消', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const settled = outcome(withTimeout(never(), 400, { signal: controller.signal }));
    vi.advanceTimersByTime(400);
    const result = await settled;

    // 没有可 abort 的句柄，超时仍以超时错误 reject（会不会真的断开上游由调用方负责）
    expect((result as { error: Error }).error.message).toMatch(/timeout: 400ms/);
    expect(controller.signal.aborted).toBe(false);
  });
});

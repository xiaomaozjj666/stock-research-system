import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAutonomousLoop } from '../scheduler.js';
import type { WatchlistAlertInput } from '../alerts.js';

describe('autonomous 循环', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('按间隔运行监控并触发告警，stop 后停止', async () => {
    const monitor = vi.fn(async (): Promise<{ results: WatchlistAlertInput[]; count: number; generatedAt: string }> => ({
      results: [{ code: '600519', name: '茅台', newsSentiment: { polarity: 0.8, weightedImpact: 0.3, hasNews: true } }],
      count: 1,
      generatedAt: new Date().toISOString(),
    }));
    const onAlert = vi.fn();
    const loop = startAutonomousLoop({ intervalMs: 1000, monitor, onAlert });

    await vi.advanceTimersByTimeAsync(1000);
    expect(monitor).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(loop.getState().running).toBe(true);
    expect(loop.getState().lastAlertCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(monitor).toHaveBeenCalledTimes(2);

    loop.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(monitor).toHaveBeenCalledTimes(2); // 停止后不再运行
    expect(loop.getState().running).toBe(false);
  });

  it('无告警时不调用 onAlert', async () => {
    const monitor = vi.fn(async (): Promise<{ results: WatchlistAlertInput[]; count: number; generatedAt: string }> => ({
      results: [{ code: 'x', name: null, newsSentiment: { polarity: 0.1, weightedImpact: 0.1, hasNews: true } }],
      count: 1,
      generatedAt: new Date().toISOString(),
    }));
    const onAlert = vi.fn();
    const loop = startAutonomousLoop({ intervalMs: 500, monitor, onAlert });
    await vi.advanceTimersByTimeAsync(500);
    expect(monitor).toHaveBeenCalledTimes(1);
    expect(onAlert).not.toHaveBeenCalled();
    loop.stop();
  });

  it('单次监控失败不终止循环', async () => {
    let n = 0;
    const monitor = vi.fn(async (): Promise<{ results: WatchlistAlertInput[]; count: number; generatedAt: string }> => {
      n++;
      if (n === 1) throw new Error('boom');
      return { results: [], count: 0, generatedAt: new Date().toISOString() };
    });
    const loop = startAutonomousLoop({ intervalMs: 500, monitor });
    await vi.advanceTimersByTimeAsync(1000);
    expect(monitor).toHaveBeenCalledTimes(2);
    expect(loop.getState().runCount).toBe(2); // 失败轮次也计入
    expect(loop.getState().errorCount).toBe(1);
    expect(loop.getState().lastError).toContain('boom');
    loop.stop();
  });
});

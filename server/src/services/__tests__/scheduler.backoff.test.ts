import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAutonomousLoop, type MonitorReport } from '../scheduler.js';

const emptyReport = (): MonitorReport => ({
  results: [],
  count: 0,
  generatedAt: new Date().toISOString(),
});

describe('autonomous 循环失败退避与自动停止（H-02）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('连续失败时指数拉长重试间隔（首次失败不变，第 2 次起翻倍，封顶 8 倍），成功后恢复', async () => {
    let n = 0;
    const monitor = vi.fn(async (): Promise<MonitorReport> => {
      n++;
      if (n <= 2) throw new Error(`boom-${n}`);
      return emptyReport();
    });
    const loop = startAutonomousLoop({ intervalMs: 500, monitor });

    // 首轮 t=500 失败：首次失败不退避，下一轮仍按基础间隔 +500
    await vi.advanceTimersByTimeAsync(500);
    expect(monitor).toHaveBeenCalledTimes(1);

    // 第 2 轮 t=1000 失败：退避生效，下一轮 +1000（2 倍）
    await vi.advanceTimersByTimeAsync(500);
    expect(monitor).toHaveBeenCalledTimes(2);

    // t=1400：若按基础间隔本应跑第 3 轮，退避使其推迟到 t=2000
    await vi.advanceTimersByTimeAsync(400);
    expect(monitor).toHaveBeenCalledTimes(2);

    // t=2000：第 3 轮成功，连续失败计数清零
    await vi.advanceTimersByTimeAsync(600);
    expect(monitor).toHaveBeenCalledTimes(3);
    expect(loop.getState().errorCount).toBe(2);

    // 成功后恢复基础间隔：第 4 轮在 t=2500
    await vi.advanceTimersByTimeAsync(500);
    expect(monitor).toHaveBeenCalledTimes(4);
    loop.stop();
  });

  it('连续失败 10 次后自动停止循环，之后不再触发监控', async () => {
    const monitor = vi.fn(async (): Promise<MonitorReport> => {
      throw new Error('always-fail');
    });
    const loop = startAutonomousLoop({ intervalMs: 500, monitor });

    // 10 次连续失败总耗时：500(首轮) + 500 + 1000 + 2000 + 4000×6 = 28000ms
    await vi.advanceTimersByTimeAsync(28000);
    expect(monitor).toHaveBeenCalledTimes(10);
    expect(loop.getState().running).toBe(false);
    expect(loop.getState().errorCount).toBe(10);
    expect(loop.getState().lastError).toContain('always-fail');

    // 自动停止后再推时间也不应触发新轮次
    await vi.advanceTimersByTimeAsync(60000);
    expect(monitor).toHaveBeenCalledTimes(10);
  });
});

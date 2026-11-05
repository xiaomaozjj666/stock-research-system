/**
 * quantCachePruner / digestScheduler 的 start/stop 生命周期
 * 背景：这两个调度器此前连 stop 函数都没有，定时器是 start 内的局部变量，
 * 优雅关闭根本无法停止它们（资源泄漏）。现在模块级保存 timer + 幂等 start/stop。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startQuantCachePruner, stopQuantCachePruner } from '../quantCache.js';
import { startDigestScheduler, stopDigestScheduler } from '../researchDigest.js';

beforeEach(() => {
  vi.useFakeTimers();
  // 两个 start 在 NODE_ENV=test 下会主动跳过定时器，这里临时切到非测试环境验证生命周期
  vi.stubEnv('NODE_ENV', 'development');
});

afterEach(() => {
  stopQuantCachePruner();
  stopDigestScheduler();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('quantCachePruner 定时清理生命周期', () => {
  it('启动注册定时器，停止后清理干净', () => {
    const baseline = vi.getTimerCount();
    startQuantCachePruner(60_000);
    expect(vi.getTimerCount()).toBe(baseline + 1);

    stopQuantCachePruner();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('重复启动幂等（不叠加定时器）；重复停止是安全空操作', () => {
    const baseline = vi.getTimerCount();
    startQuantCachePruner(60_000);
    startQuantCachePruner(60_000);
    expect(vi.getTimerCount()).toBe(baseline + 1);

    stopQuantCachePruner();
    expect(() => stopQuantCachePruner()).not.toThrow();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('未启动时停止是安全空操作', () => {
    expect(() => stopQuantCachePruner()).not.toThrow();
  });
});

describe('digestScheduler 定时简报生命周期', () => {
  it('启动注册定时器，停止后清理干净', () => {
    vi.stubEnv('QUANT_DIGEST_INTERVAL_HOURS', '1');
    const baseline = vi.getTimerCount();
    startDigestScheduler();
    expect(vi.getTimerCount()).toBe(baseline + 1);

    stopDigestScheduler();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('重复启动幂等；env 关闭时不注册任何定时器', () => {
    const baseline = vi.getTimerCount();
    vi.stubEnv('QUANT_DIGEST_INTERVAL_HOURS', '0');
    startDigestScheduler();
    expect(vi.getTimerCount()).toBe(baseline); // 0 = 关闭

    vi.stubEnv('QUANT_DIGEST_INTERVAL_HOURS', '1');
    startDigestScheduler();
    startDigestScheduler();
    expect(vi.getTimerCount()).toBe(baseline + 1);
    stopDigestScheduler();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('未启动时停止是安全空操作', () => {
    expect(() => stopDigestScheduler()).not.toThrow();
  });
});

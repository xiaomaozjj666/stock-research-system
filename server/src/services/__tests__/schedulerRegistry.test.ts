/**
 * 后台调度器统一注册/关闭（架构整改：此前关闭流程只停 outcomeRefresher 一个）
 * - registerScheduler / stopAllSchedulers：全量停止、异常容错、幂等、关闭后注册即停
 * - createShutdownHandler：停调度器 → closeServer → exit；重复信号去重；超时强退
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createShutdownHandler,
  registerScheduler,
  resetSchedulerRegistryForTests,
  stopAllSchedulers,
} from '../schedulerRegistry.js';

beforeEach(() => {
  resetSchedulerRegistryForTests();
});
afterEach(() => {
  resetSchedulerRegistryForTests();
  vi.useRealTimers();
});

describe('schedulerRegistry 统一注册/停止', () => {
  it('stopAllSchedulers 停止全部已注册调度器（不只停其中一个）', () => {
    const stops = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    stops.forEach((stop, i) => registerScheduler(`scheduler-${i}`, stop));

    stopAllSchedulers();

    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it('单个调度器停止抛错不中断其余清理', () => {
    const first = vi.fn(() => {
      throw new Error('stop failed');
    });
    const second = vi.fn();
    registerScheduler('bad', first);
    registerScheduler('good', second);

    expect(() => stopAllSchedulers()).not.toThrow();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stopAllSchedulers 幂等：重复调用不重复执行 stop', () => {
    const stop = vi.fn();
    registerScheduler('once', stop);
    stopAllSchedulers();
    stopAllSchedulers();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('关闭流程开始后再注册：立即停止而非注册（关闭后不留活定时器）', () => {
    stopAllSchedulers();
    const late = vi.fn();
    registerScheduler('late', late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('未注册任何调度器时停止是安全空操作', () => {
    expect(() => stopAllSchedulers()).not.toThrow();
  });
});

describe('createShutdownHandler 优雅关闭流程', () => {
  it('关闭时停全部调度器、关闭 server 并以 0 退出', () => {
    const stops = [vi.fn(), vi.fn()];
    registerScheduler('a', stops[0]);
    registerScheduler('b', stops[1]);
    const exit = vi.fn();
    const closeServer = vi.fn((cb: (err?: Error) => void) => cb());

    const shutdown = createShutdownHandler({ closeServer, exit });
    shutdown('SIGTERM');

    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('server.close 出错时以 1 退出', () => {
    const exit = vi.fn();
    const closeServer = vi.fn((cb: (err?: Error) => void) => cb(new Error('close failed')));
    const shutdown = createShutdownHandler({ closeServer, exit });
    shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('重复信号只处理一次（不重复停调度器、不重复 close）', () => {
    const stop = vi.fn();
    registerScheduler('only', stop);
    const exit = vi.fn();
    const closeServer = vi.fn((cb: (err?: Error) => void) => cb());
    const shutdown = createShutdownHandler({ closeServer, exit });

    shutdown('SIGTERM');
    shutdown('SIGINT');
    shutdown('uncaughtException');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('连接迟迟不关闭：超时后强制以 1 退出', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const closeServer = vi.fn(); // 永不回调，模拟长连接挂住
    const shutdown = createShutdownHandler({ closeServer, exit, forceExitTimeoutMs: 1000 });

    shutdown('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('正常关闭后清理强制退出定时器（不会误触发强退）', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const closeServer = vi.fn((cb: (err?: Error) => void) => cb());
    const shutdown = createShutdownHandler({ closeServer, exit, forceExitTimeoutMs: 1000 });

    shutdown('SIGTERM');
    exit.mockClear();
    vi.advanceTimersByTime(5000); // 正常退出后 forceExit 不应再触发
    expect(exit).not.toHaveBeenCalled();
  });
});

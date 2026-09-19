/**
 * improvementScheduler：改进循环的周期调度
 * ----------------------------------------------------------------------------
 * 这个模块控制"判据会不会在无人值守时被改写"，所以用例重点不在"能跑起来"，
 * 而在几条**失败与边界**行为：
 *   - env 显式关闭时必须一个定时器都不注册（返回 null，而不是"注册了但空转"）；
 *   - 显式传 intervalMs 要压过 env（用户当场说了算）；
 *   - 单轮抛异常只累计、不终止循环；连续失败达上限要自动停并标记原因；
 *   - 同一个进程里重复 start 不能叠出两条定时器链。
 *
 * 用假定时器；`runRound` 一律注入替身，不触碰真实台账与策略文件。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 有几个用例是**故意**让单轮抛异常的，日志会往 stdout 里灌完整堆栈；
// 这里替身掉 logger，既保持输出干净，也顺带断言"异常确实被记了 error 级"。
vi.mock('../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import logger from '../../utils/logger.js';
import {
  getImprovementSchedulerState,
  resolveIntervalFromEnv,
  startImprovementScheduler,
  stopImprovementScheduler,
} from '../improvementScheduler.js';
import type { ImprovementRoundResult } from '../../quant/improvementLoop.js';

const env = process.env.IMPROVEMENT_INTERVAL_HOURS;

function okRound(reason = 'ok'): ImprovementRoundResult {
  return {
    changed: false,
    reason,
    record: null,
    policyState: {
      policy: {
        minIcSamples: 5,
        significanceLevel: 0.05,
        minMonotonicity: 0.6,
        requirePositiveSpread: true,
      },
      source: 'default',
      updatedAt: null,
      revision: 0,
      lastChange: null,
    },
    evaluated: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.IMPROVEMENT_INTERVAL_HOURS;
  stopImprovementScheduler();
});
afterEach(() => {
  stopImprovementScheduler();
  vi.useRealTimers();
  if (env === undefined) delete process.env.IMPROVEMENT_INTERVAL_HOURS;
  else process.env.IMPROVEMENT_INTERVAL_HOURS = env;
});

describe('resolveIntervalFromEnv', () => {
  it('未配置 → 默认 6 小时', () => {
    expect(resolveIntervalFromEnv()).toBe(6 * 3600_000);
  });

  it('空字符串按未配置处理', () => {
    process.env.IMPROVEMENT_INTERVAL_HOURS = '';
    expect(resolveIntervalFromEnv()).toBe(6 * 3600_000);
  });

  it('0 或负数 = 显式关闭（返回 null，区别于"没配"）', () => {
    process.env.IMPROVEMENT_INTERVAL_HOURS = '0';
    expect(resolveIntervalFromEnv()).toBeNull();
    process.env.IMPROVEMENT_INTERVAL_HOURS = '-3';
    expect(resolveIntervalFromEnv()).toBeNull();
  });

  it('非法值按未配置处理，不因为手滑就让调度消失', () => {
    process.env.IMPROVEMENT_INTERVAL_HOURS = 'abc';
    expect(resolveIntervalFromEnv()).toBe(6 * 3600_000);
  });

  it('正常小时数生效', () => {
    process.env.IMPROVEMENT_INTERVAL_HOURS = '1';
    expect(resolveIntervalFromEnv()).toBe(3600_000);
  });

  it('上限 720 小时（30 天）：防手滑填个天文数字等于再也不跑', () => {
    process.env.IMPROVEMENT_INTERVAL_HOURS = '100000';
    expect(resolveIntervalFromEnv()).toBe(720 * 3600_000);
  });
});

describe('启动与停止', () => {
  it('env 关闭且未显式给间隔 → 不启动（返回 null，而不是空转）', () => {
    process.env.IMPROVEMENT_INTERVAL_HOURS = '0';
    expect(startImprovementScheduler()).toBeNull();
    expect(getImprovementSchedulerState()).toBeNull();
  });

  it('显式 intervalMs 压过 env 的关闭设置（用户当场说了算）', () => {
    process.env.IMPROVEMENT_INTERVAL_HOURS = '0';
    const c = startImprovementScheduler({ intervalMs: 60_000 });
    expect(c).not.toBeNull();
    expect(c!.getState().intervalMs).toBe(60_000);
  });

  it('启动后状态可读，停止后归 null', () => {
    const c = startImprovementScheduler({ intervalMs: 60_000 });
    const st = getImprovementSchedulerState()!;
    expect(st.running).toBe(true);
    expect(st.runCount).toBe(0);
    expect(st.lastChanged).toBe(false);
    expect(st.stoppedByErrors).toBe(false);

    c!.stop();
    expect(getImprovementSchedulerState()).toBeNull();
  });

  it('重复 start 不会叠出两条定时器链（旧链被停掉）', () => {
    const first = startImprovementScheduler({ intervalMs: 60_000, firstRunDelayMs: 0 });
    const second = startImprovementScheduler({ intervalMs: 60_000, firstRunDelayMs: 0 });
    expect(second).not.toBeNull();
    expect(first!.getState().running).toBe(false);
    expect(getImprovementSchedulerState()!.intervalMs).toBe(60_000);
    // 只有第二条链在跑：推进一次只应产生一轮
    const calls: number[] = [];
    vi.advanceTimersByTime(1);
    expect(getImprovementSchedulerState()!.runCount).toBe(1);
    void calls;
  });

  it('stop 之后再推进时间不会继续跑', () => {
    const c = startImprovementScheduler({
      intervalMs: 1000,
      firstRunDelayMs: 0,
      runRound: () => okRound(),
    });
    vi.advanceTimersByTime(1);
    expect(c!.getState().runCount).toBe(1);
    c!.stop();
    vi.advanceTimersByTime(100_000);
    expect(c!.getState().runCount).toBe(1);
  });
});

describe('轮次行为', () => {
  it('按间隔重复执行，并把结局写进状态', () => {
    const seen: string[] = [];
    const c = startImprovementScheduler({
      intervalMs: 1000,
      firstRunDelayMs: 0,
      runRound: () => ({ ...okRound('第一轮'), changed: true }),
      onResult: (r) => seen.push(r.reason),
    });
    vi.advanceTimersByTime(1);
    const st1 = c!.getState();
    expect(st1.runCount).toBe(1);
    expect(st1.lastChanged).toBe(true);
    expect(st1.lastReason).toBe('第一轮');
    expect(st1.lastRunAt).toBeTruthy();
    expect(seen).toEqual(['第一轮']);

    vi.advanceTimersByTime(1000);
    expect(c!.getState().runCount).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(c!.getState().runCount).toBe(3);
  });

  it('单轮抛异常只累计，不终止循环（下一轮照常跑）', () => {
    let n = 0;
    const c = startImprovementScheduler({
      intervalMs: 1000,
      firstRunDelayMs: 0,
      runRound: () => {
        n += 1;
        if (n === 1) throw new Error('模拟回放失败');
        return okRound('恢复');
      },
    });
    vi.advanceTimersByTime(1);
    expect(c!.getState().errorCount).toBe(1);
    expect(c!.getState().lastError).toBe('模拟回放失败');
    expect(c!.getState().running).toBe(true);
    // 异常必须留下 error 级日志：判据是被自动改写的东西，静默失败最危险
    expect(vi.mocked(logger.error)).toHaveBeenCalled();

    // 首次失败仍按原间隔重试（不退避），成功后清零
    vi.advanceTimersByTime(1000);
    expect(c!.getState().runCount).toBe(2);
    expect(c!.getState().consecutiveErrors).toBe(0);
    expect(c!.getState().lastReason).toBe('恢复');
  });

  it('连续失败按指数退避（间隔翻倍），并在达上限时自动停止', () => {
    const c = startImprovementScheduler({
      intervalMs: 1000,
      firstRunDelayMs: 0,
      runRound: () => {
        throw new Error('一直失败');
      },
    });
    // 第 1 次：立即（firstRunDelayMs=0）
    vi.advanceTimersByTime(1);
    expect(c!.getState().consecutiveErrors).toBe(1);
    // 第 2 次：consecutiveErrors<=1 → 不打折，1000ms 后
    vi.advanceTimersByTime(1000);
    expect(c!.getState().consecutiveErrors).toBe(2);
    // 第 3 次：退避 2 倍 → 需要 2000ms
    vi.advanceTimersByTime(1000);
    expect(c!.getState().consecutiveErrors).toBe(2); // 还没到点
    vi.advanceTimersByTime(1000);
    expect(c!.getState().consecutiveErrors).toBe(3);
    // 继续推进到上限
    vi.advanceTimersByTime(10 * 60 * 1000);
    const st = c!.getState();
    expect(st.stoppedByErrors).toBe(true);
    expect(st.running).toBe(false);
    expect(st.consecutiveErrors).toBeGreaterThanOrEqual(5);
    expect(st.errorCount).toBe(st.runCount);
    // 自动停止后不再产生新轮次
    const frozen = st.runCount;
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(c!.getState().runCount).toBe(frozen);
  });

  it('成功后连续失败计数清零，退避也随之解除', () => {
    let fail = true;
    const c = startImprovementScheduler({
      intervalMs: 1000,
      firstRunDelayMs: 0,
      runRound: () => {
        if (fail) throw new Error('先失败');
        return okRound();
      },
    });
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(1000);
    expect(c!.getState().consecutiveErrors).toBe(2);

    fail = false;
    vi.advanceTimersByTime(4000); // 2 倍退避期内
    expect(c!.getState().consecutiveErrors).toBe(0);
  });
});

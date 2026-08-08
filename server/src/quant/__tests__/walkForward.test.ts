import { describe, it, expect } from 'vitest';
import {
  rollingWindows,
  walkForwardBacktest,
  sliceWindows,
  consistencyScore,
  runWalkForward,
} from '../walkForward.js';
import type { BacktestComparison } from '../backtestEvaluator.js';
import type { OHLCVData, StrategyConfig, BacktestResult } from '../types.js';
import type { WindowDataSlice, WalkForwardConfig } from '../walkForward.js';

// ============================================================
// 旧 API 测试（rollingWindows / walkForwardBacktest）
// ============================================================

const ohlcv: OHLCVData[] = Array.from({ length: 60 }, (_, i) => ({
  date: `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
  open: 10 + i,
  close: 11 + i,
  high: 12 + i,
  low: 9 + i,
  volume: 1000,
}));

const baseStrategy: StrategyConfig = {
  name: '均线交叉',
  type: 'ma_cross',
  stockCode: '600519',
  params: { fast: 5, slow: 20 },
  startDate: '2024-01-01',
  endDate: '2024-12-31',
};

function result(sharpe: number, totalReturn = sharpe * 10, maxDrawdown = -5): BacktestResult {
  return {
    totalReturn,
    annualizedReturn: totalReturn,
    sharpeRatio: sharpe,
    maxDrawdown,
    winRate: 55,
    tradeCount: 3,
    profitFactor: 1.5,
    equityCurve: [],
    trades: [],
    benchmark: [],
  };
}

describe('rollingWindows', () => {
  it('生成不重叠滚动窗口（step = testSize）', () => {
    const w = rollingWindows(60, 30, 15, 15);
    expect(w).toHaveLength(2);
    expect(w[0].train).toEqual([0, 29]);
    expect(w[0].test).toEqual([30, 44]);
    expect(w[1].train).toEqual([15, 44]);
    expect(w[1].test).toEqual([45, 59]);
  });

  it('参数非法或数据不足返回空', () => {
    expect(rollingWindows(60, 30, 15, 0)).toEqual([]);
    expect(rollingWindows(10, 30, 15, 15)).toEqual([]);
  });
});

describe('walkForwardBacktest', () => {
  it('样本外稳定：oosRatio 接近 1 → stable=true', () => {
    // 训练与测试都给出相近夏普
    const report = walkForwardBacktest(
      () => result(1.4),
      ohlcv,
      baseStrategy,
      { trainSize: 30, testSize: 15, step: 15 },
    );
    expect(report.insufficient).toBe(false);
    expect(report.folds).toHaveLength(2);
    expect(report.avgTrainSharpe).toBeCloseTo(1.4);
    expect(report.avgTestSharpe).toBeCloseTo(1.4);
    expect(report.oosRatio).toBeCloseTo(1);
    expect(report.stable).toBe(true);
  });

  it('样本外崩塌（过拟合信号）：oosRatio 远低于阈值 → stable=false', () => {
    let call = 0;
    const report = walkForwardBacktest(
      () => {
        // 第一个调用是 train，第二个是 test；按折交替
        const isTest = call % 2 === 1;
        call++;
        return result(isTest ? 0.1 : 1.5);
      },
      ohlcv,
      baseStrategy,
      { trainSize: 30, testSize: 15, step: 15 },
    );
    expect(report.avgTrainSharpe).toBeCloseTo(1.5);
    expect(report.avgTestSharpe).toBeCloseTo(0.1);
    expect(report.oosRatio).toBeCloseTo(0.1 / 1.5, 5);
    expect(report.stable).toBe(false);
  });

  it('数据不足以构成一个完整窗口 → insufficient=true，无折', () => {
    const short = ohlcv.slice(0, 10);
    const report = walkForwardBacktest(
      () => result(1),
      short,
      baseStrategy,
      { trainSize: 30, testSize: 15, step: 15 },
    );
    expect(report.insufficient).toBe(true);
    expect(report.folds).toHaveLength(0);
    expect(report.stable).toBe(false);
  });

  it('窗口策略的起止日期对齐到切片数据', () => {
    const report = walkForwardBacktest(
      () => result(1),
      ohlcv,
      baseStrategy,
      { trainSize: 30, testSize: 15, step: 15 },
    );
    const f0 = report.folds[0];
    expect(f0.train.start).toBe(ohlcv[0].date);
    expect(f0.train.end).toBe(ohlcv[29].date);
    expect(f0.test.start).toBe(ohlcv[30].date);
    expect(f0.test.end).toBe(ohlcv[44].date);
  });
});

// ============================================================
// 新 API 测试（sliceWindows / consistencyScore / runWalkForward）
// ============================================================

/** 生成权益曲线（n 个点，值线性递增） */
function makeEquity(n: number): { date: string; value: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    value: 10000 + i * 10,
  }));
}

/** 构造 BacktestResult（带足够长的权益曲线以通过 compareBacktests 样本量检查） */
function makeResult(opts: {
  sharpe?: number;
  totalReturn?: number;
  winRate?: number;
  equityDays?: number;
}): BacktestResult {
  const days = opts.equityDays ?? 40;
  const ret = opts.totalReturn ?? 10;
  const curve = Array.from({ length: days }, (_, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    // 按 totalReturn 复利生成，不同 ret 产生不同曲线
    value: 10000 * Math.pow(1 + ret / 100 / days, i),
  }));
  return {
    totalReturn: ret,
    annualizedReturn: ret,
    sharpeRatio: opts.sharpe ?? 1.2,
    maxDrawdown: 10,
    winRate: opts.winRate ?? 55,
    tradeCount: 5,
    profitFactor: 1.5,
    equityCurve: curve,
    trades: [],
    benchmark: [],
  };
}

/**
 * 创建 mock runBacktest 函数。
 * 每次调用返回 {baseline=trainResult, experiment=testResult}。
 * makeTrain / makeTest 接收窗口索引 i，返回对应窗口的 IS/OOS 结果。
 */
function createMockRunBacktest(
  makeTrain: (i: number) => BacktestResult,
  makeTest: (i: number) => BacktestResult,
) {
  let i = 0;
  return async (
    _trainData: WindowDataSlice,
    _testData: WindowDataSlice,
    _cfg: WalkForwardConfig,
  ): Promise<{ baseline: BacktestResult; experiment: BacktestResult }> => {
    const idx = i++;
    return { baseline: makeTrain(idx), experiment: makeTest(idx) };
  };
}

// ---------- sliceWindows：窗口切分正确性 ----------

describe('sliceWindows', () => {
  it('rolling 模式（默认）：固定长度训练窗滑动', () => {
    const w = sliceWindows(60, { trainSize: 30, testSize: 15, step: 15 });
    expect(w).toHaveLength(2);
    // 窗口 0：train [0,29]，test [30,44]
    expect(w[0].train).toEqual([0, 29]);
    expect(w[0].test).toEqual([30, 44]);
    // 窗口 1：train [15,44]（训练窗前移 step），test [45,59]
    expect(w[1].train).toEqual([15, 44]);
    expect(w[1].test).toEqual([45, 59]);
  });

  it('rolling 模式：step 默认 = testSize（不重叠测试窗）', () => {
    const w = sliceWindows(60, { trainSize: 30, testSize: 15 });
    expect(w).toHaveLength(2);
    expect(w[0].test).toEqual([30, 44]);
    expect(w[1].test).toEqual([45, 59]);
  });

  it('anchored 模式（expanding window）：训练窗起点固定为 0，长度递增', () => {
    const w = sliceWindows(60, { trainSize: 30, testSize: 15, step: 15, anchored: true });
    expect(w).toHaveLength(2);
    // 窗口 0：train [0,29]（长度 30），test [30,44]
    expect(w[0].train).toEqual([0, 29]);
    expect(w[0].test).toEqual([30, 44]);
    // 窗口 1：train [0,44]（长度 45，扩张！），test [45,59]
    expect(w[1].train).toEqual([0, 44]);
    expect(w[1].test).toEqual([45, 59]);
  });

  it('anchored vs rolling：训练窗起点不同', () => {
    const rolling = sliceWindows(60, { trainSize: 30, testSize: 15, step: 15, anchored: false });
    const anchored = sliceWindows(60, { trainSize: 30, testSize: 15, step: 15, anchored: true });
    // 第 0 个窗口两者一致
    expect(rolling[0].train).toEqual(anchored[0].train);
    // 第 1 个窗口：rolling 起点 = 15，anchored 起点 = 0
    expect(rolling[1].train[0]).toBe(15);
    expect(anchored[1].train[0]).toBe(0);
    // anchored 训练窗更长
    expect(anchored[1].train[1] - anchored[1].train[0])
      .toBeGreaterThan(rolling[1].train[1] - rolling[1].train[0]);
  });

  it('step < testSize：测试窗重叠，窗口数增加', () => {
    const w = sliceWindows(100, { trainSize: 30, testSize: 15, step: 10 });
    // i=0: test [30,44]; i=1: test [40,54]; ... i=5: test [80,94]; i=6: testStart=90, 90+15=105>100
    expect(w).toHaveLength(6);
    // 测试窗重叠：窗口 0 的 test 结束(44) >= 窗口 1 的 test 开始(40)
    expect(w[0].test[1]).toBeGreaterThanOrEqual(w[1].test[0]);
  });

  it('数据不足返回空', () => {
    expect(sliceWindows(10, { trainSize: 30, testSize: 15 })).toEqual([]);
    expect(sliceWindows(44, { trainSize: 30, testSize: 15 })).toEqual([]); // 刚好不够
  });

  it('刚好够一个窗口', () => {
    expect(sliceWindows(45, { trainSize: 30, testSize: 15 })).toHaveLength(1);
  });

  it('参数非法返回空', () => {
    expect(sliceWindows(60, { trainSize: 0, testSize: 15 })).toEqual([]);
    expect(sliceWindows(60, { trainSize: 30, testSize: 0 })).toEqual([]);
    expect(sliceWindows(60, { trainSize: 30, testSize: 15, step: 0 })).toEqual([]);
    expect(sliceWindows(0, { trainSize: 30, testSize: 15 })).toEqual([]);
  });
});

// ---------- consistencyScore：一致性评分计算 ----------

describe('consistencyScore', () => {
  it('空数组返回 0', () => {
    expect(consistencyScore([])).toBe(0);
  });

  it('单元素返回 1（无变异）', () => {
    expect(consistencyScore([1.5])).toBe(1);
  });

  it('完全一致的 Sharpe → 接近 1', () => {
    expect(consistencyScore([1.5, 1.5, 1.5])).toBeCloseTo(1, 5);
  });

  it('均值 ≤ 0 返回 0', () => {
    expect(consistencyScore([-1, -2])).toBe(0);
    expect(consistencyScore([0, 0])).toBe(0);
  });

  it('变异越大分数越低', () => {
    const stable = consistencyScore([1.5, 1.4, 1.6]);
    const unstable = consistencyScore([1.5, 0.5, 2.5]);
    expect(stable).toBeGreaterThan(unstable);
    expect(stable).toBeGreaterThan(0.5);
  });

  it('极端变异裁剪到 0', () => {
    // sharpes = [2.0, 0.2]，mean=1.1，std≈1.273，CV≈1.157，1-CV < 0 → 裁剪到 0
    expect(consistencyScore([2.0, 0.2])).toBe(0);
  });

  it('结果始终在 [0, 1] 范围内', () => {
    const cases = [
      [1, 1, 1],
      [1, 2, 3],
      [-1, -2],
      [0.5, 0.5],
      [10, 0.1],
    ];
    for (const c of cases) {
      const score = consistencyScore(c);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------- runWalkForward：OOS 指标汇总 ----------

describe('runWalkForward — OOS 指标汇总', () => {
  it('oosSharpe / oosReturn / oosWinRate 取各窗口 testResult 的均值', async () => {
    const equity = makeEquity(60);
    const res = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0, totalReturn: 10, winRate: 50 }),
        (i) => makeResult({ sharpe: 1.5 + i * 0.1, totalReturn: 15 + i * 2, winRate: 55 + i }),
      ),
    });
    // 2 窗口：test sharpes=[1.5, 1.6], returns=[15, 17], winRates=[55, 56]
    expect(res.windows).toHaveLength(2);
    expect(res.oosSharpe).toBeCloseTo((1.5 + 1.6) / 2, 5);
    expect(res.oosReturn).toBeCloseTo((15 + 17) / 2, 5);
    expect(res.oosWinRate).toBeCloseTo((55 + 56) / 2, 5);
  });

  it('各窗口 OOS Sharpe 一致 → consistencyScore 接近 1', async () => {
    const equity = makeEquity(60);
    const res = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0 }),
        () => makeResult({ sharpe: 1.5 }),
      ),
    });
    expect(res.consistencyScore).toBeCloseTo(1, 5);
  });

  it('各窗口 OOS Sharpe 差异大 → consistencyScore 偏低', async () => {
    const equity = makeEquity(60);
    const res = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0 }),
        (i) => makeResult({ sharpe: i === 0 ? 2.0 : 0.2 }),
      ),
    });
    expect(res.consistencyScore).toBe(0);
  });

  it('每个窗口的 comparison 由 compareBacktests 生成', async () => {
    const equity = makeEquity(60);
    const res = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0, totalReturn: 10 }),
        () => makeResult({ sharpe: 1.5, totalReturn: 15 }),
      ),
    });
    for (const w of res.windows) {
      expect(w.comparison).toBeDefined();
      expect(typeof w.comparison.verdict).toBe('string');
      expect(Array.isArray(w.comparison.metrics)).toBe(true);
      expect(typeof w.comparison.summary).toBe('string');
    }
  });

  it('trainResult / testResult 正确映射到 baseline / experiment', async () => {
    const equity = makeEquity(60);
    const res = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 0.8, totalReturn: 5 }),
        () => makeResult({ sharpe: 1.5, totalReturn: 20 }),
      ),
    });
    // trainResult = baseline（IS），testResult = experiment（OOS）
    expect(res.windows[0].trainResult.sharpeRatio).toBe(0.8);
    expect(res.windows[0].testResult.sharpeRatio).toBe(1.5);
    expect(res.windows[0].trainResult.totalReturn).toBe(5);
    expect(res.windows[0].testResult.totalReturn).toBe(20);
  });
});

// ---------- runWalkForward：窗口切分正确性（anchored vs rolling） ----------

describe('runWalkForward — 窗口切分（anchored vs rolling）', () => {
  it('anchored 模式：所有窗口 trainStart 固定为首日，trainEnd 递增', async () => {
    const equity = makeEquity(60);
    const res = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15, anchored: true },
      runBacktest: createMockRunBacktest(
        () => makeResult({}),
        () => makeResult({}),
      ),
    });
    expect(res.windows).toHaveLength(2);
    // 训练窗起点均为首日
    expect(res.windows[0].trainStart).toBe(equity[0].date);
    expect(res.windows[1].trainStart).toBe(equity[0].date);
    // 训练窗终点递增（扩张）
    expect(res.windows[1].trainEnd).not.toBe(res.windows[0].trainEnd);
    // 测试窗日期
    expect(res.windows[0].testStart).toBe(equity[30].date);
    expect(res.windows[0].testEnd).toBe(equity[44].date);
    expect(res.windows[1].testStart).toBe(equity[45].date);
    expect(res.windows[1].testEnd).toBe(equity[59].date);
  });

  it('rolling 模式：trainStart 随窗口前移', async () => {
    const equity = makeEquity(60);
    const res = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15, anchored: false },
      runBacktest: createMockRunBacktest(
        () => makeResult({}),
        () => makeResult({}),
      ),
    });
    expect(res.windows).toHaveLength(2);
    // 窗口 0：train 从 index 0 开始
    expect(res.windows[0].trainStart).toBe(equity[0].date);
    expect(res.windows[0].trainEnd).toBe(equity[29].date);
    // 窗口 1：train 从 index 15 开始（前移 step=15）
    expect(res.windows[1].trainStart).toBe(equity[15].date);
    expect(res.windows[1].trainEnd).toBe(equity[44].date);
  });

  it('summary 包含窗口模式信息', async () => {
    const equity = makeEquity(60);
    const rollingRes = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15, anchored: false },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(rollingRes.summary).toContain('rolling window');

    const anchoredRes = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15, anchored: true },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(anchoredRes.summary).toContain('expanding window');
  });
});

// ---------- runWalkForward：窗口数计算 ----------

describe('runWalkForward — 窗口数计算', () => {
  it('n=60, trainSize=30, testSize=15, step=15 → 2 个窗口', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(res.windows).toHaveLength(2);
  });

  it('n=120, trainSize=60, testSize=30, step=30 → 2 个窗口', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(120),
      benchmarkCurve: [],
      config: { trainSize: 60, testSize: 30, step: 30 },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    // testStart: 60, 90; 90+30=120<=120 → 2 窗口
    expect(res.windows).toHaveLength(2);
  });

  it('step < testSize 产生更多重叠窗口', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(100),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 10 },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(res.windows).toHaveLength(6);
  });

  it('runBacktest 被调用次数 = 窗口数', async () => {
    let callCount = 0;
    const equity = makeEquity(100);
    const res = await runWalkForward({
      equityCurve: equity,
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 10 },
      runBacktest: async () => {
        callCount++;
        return { baseline: makeResult({}), experiment: makeResult({}) };
      },
    });
    expect(callCount).toBe(res.windows.length);
    expect(callCount).toBe(6);
  });
});

// ---------- runWalkForward：空数据/数据不足处理 ----------

describe('runWalkForward — 空数据/数据不足', () => {
  it('空权益曲线 → 无窗口，返回带 caveat 的空结果', async () => {
    const res = await runWalkForward({
      equityCurve: [],
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15 },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(res.windows).toHaveLength(0);
    expect(res.oosSharpe).toBe(0);
    expect(res.oosReturn).toBe(0);
    expect(res.oosWinRate).toBe(0);
    expect(res.consistencyScore).toBe(0);
    expect(res.caveats.some((c) => c.includes('权益曲线为空'))).toBe(true);
  });

  it('数据不足以构成任何窗口 → 返回带 caveat 的空结果', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(20),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15 },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(res.windows).toHaveLength(0);
    expect(res.caveats.some((c) => c.includes('不足以'))).toBe(true);
    expect(res.summary).toContain('数据不足');
  });

  it('数据刚好等于 trainSize+testSize → 1 个窗口', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(45),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15 },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(res.windows).toHaveLength(1);
  });

  it('runBacktest 在空数据时不被调用', async () => {
    let called = false;
    await runWalkForward({
      equityCurve: [],
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15 },
      runBacktest: async () => {
        called = true;
        return { baseline: makeResult({}), experiment: makeResult({}) };
      },
    });
    expect(called).toBe(false);
  });
});

// ---------- runWalkForward：caveats 提示 ----------

describe('runWalkForward — caveats 提示', () => {
  it('窗口数 < 3 时提示统计显著性有限', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(res.windows).toHaveLength(2);
    expect(res.caveats.some((c) => c.includes('统计显著性有限'))).toBe(true);
  });

  it('OOS 夏普为负时提示', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0 }),
        () => makeResult({ sharpe: -0.5 }),
      ),
    });
    expect(res.oosSharpe).toBeLessThan(0);
    expect(res.caveats.some((c) => c.includes('为负'))).toBe(true);
  });

  it('一致性评分偏低时提示', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0 }),
        (i) => makeResult({ sharpe: i === 0 ? 2.0 : 0.2 }),
      ),
    });
    expect(res.consistencyScore).toBeLessThan(0.5);
    expect(res.caveats.some((c) => c.includes('一致性评分偏低'))).toBe(true);
  });

  it('OOS 远低于 IS 时提示过拟合', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 3.0 }),
        () => makeResult({ sharpe: 0.2 }),
      ),
    });
    expect(res.caveats.some((c) => c.includes('过拟合') || c.includes('远低于'))).toBe(true);
  });

  it('基准曲线长度不一致时提示', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: makeEquity(50),
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(() => makeResult({}), () => makeResult({})),
    });
    expect(res.caveats.some((c) => c.includes('基准曲线长度') && c.includes('不一致'))).toBe(true);
  });

  it('正常情况（稳定 + 正收益）不触发关键 caveat', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(120),
      benchmarkCurve: makeEquity(120),
      config: { trainSize: 60, testSize: 30, step: 30 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.2, totalReturn: 12 }),
        () => makeResult({ sharpe: 1.1, totalReturn: 10 }),
      ),
    });
    expect(res.windows).toHaveLength(2);
    // 不应有"为负""过拟合""一致性偏低"等关键警示
    expect(res.caveats.some((c) => c.includes('为负'))).toBe(false);
    expect(res.caveats.some((c) => c.includes('过拟合'))).toBe(false);
  });
});

// ---------- runWalkForward：类型完整性 ----------

describe('runWalkForward — 类型完整性', () => {
  it('返回结果包含所有必需字段', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0 }),
        () => makeResult({ sharpe: 1.2 }),
      ),
    });
    expect(res).toHaveProperty('windows');
    expect(res).toHaveProperty('oosSharpe');
    expect(res).toHaveProperty('oosReturn');
    expect(res).toHaveProperty('oosWinRate');
    expect(res).toHaveProperty('consistencyScore');
    expect(res).toHaveProperty('summary');
    expect(res).toHaveProperty('caveats');
    expect(typeof res.oosSharpe).toBe('number');
    expect(typeof res.oosReturn).toBe('number');
    expect(typeof res.oosWinRate).toBe('number');
    expect(typeof res.consistencyScore).toBe('number');
    expect(typeof res.summary).toBe('string');
    expect(Array.isArray(res.caveats)).toBe(true);
  });

  it('每个 window 包含完整的字段结构', async () => {
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0 }),
        () => makeResult({ sharpe: 1.2 }),
      ),
    });
    const w = res.windows[0];
    expect(typeof w.trainStart).toBe('string');
    expect(typeof w.trainEnd).toBe('string');
    expect(typeof w.testStart).toBe('string');
    expect(typeof w.testEnd).toBe('string');
    expect(w.trainResult).toHaveProperty('sharpeRatio');
    expect(w.testResult).toHaveProperty('sharpeRatio');
    expect(w.comparison).toHaveProperty('verdict');
    expect(w.comparison).toHaveProperty('metrics');
  });

  it('compareOptions 透传给 compareBacktests', async () => {
    // 传入 numStrategiesTried=10，验证不报错且 comparison 正常生成
    const res = await runWalkForward({
      equityCurve: makeEquity(60),
      benchmarkCurve: [],
      config: { trainSize: 30, testSize: 15, step: 15 },
      runBacktest: createMockRunBacktest(
        () => makeResult({ sharpe: 1.0, totalReturn: 10 }),
        () => makeResult({ sharpe: 1.5, totalReturn: 15 }),
      ),
      compareOptions: { numStrategiesTried: 10 },
    });
    expect(res.windows[0].comparison).toBeDefined();
    // DSR 应被计算（numStrategiesTried > 1）
    const comp = res.windows[0].comparison as BacktestComparison;
    expect(comp.deflatedSharpeRatio).toBeDefined();
  });
});

/**
 * Walk-Forward 评估模块 —— 学界标准滚动样本外（OOS）评估方法
 * ============================================================================
 * 本模块提供两套 API：
 *
 * 一、简单滚动窗口评估（旧 API，基于 OHLCVData 的同步实现）
 *    - rollingWindows / walkForwardBacktest
 *    - 用「样本外夏普 / 样本内夏普」快速衡量策略过拟合程度
 *
 * 二、Walk-Forward 完整评估模式（新 API，基于 equityCurve + compareBacktests）
 *    - runWalkForward / sliceWindows / consistencyScore
 *    - 对每个窗口调用注入的 runBacktest 获取同一策略的 IS/OOS 结果
 *    - 用 compareBacktests 做单窗口 IS vs OOS 对比
 *    - 汇总所有窗口的 OOS 表现（夏普/收益/胜率/一致性）
 *    - 学界标准 OOS 评估方法，对标 Pardo(2008)、Ingram(2014) Walk-Forward Analysis
 *
 *    ⚠ 语义澄清（重要）：新 API 的 runWalkForward 回答的是「该策略是否过拟合？」
 *    （IS 漂亮但 OOS 崩塌 = 过拟合信号），而不是「LLM 信号 vs 无 LLM 基线」的受控对比。
 *    这里 baseline 槽位装的是同一策略的样本内（IS）结果、experiment 槽位装的是样本外（OOS）
 *    结果，二者只是存储槽位，并非「信号组 vs 对照组」。需要做信号 vs 基线的受控显著性对比时，
 *    请直接调用 compareBacktests（见 backtestEvaluator.ts），不要在 runWalkForward 里混用语义。
 *
 * 设计原则：
 *  - 纯函数（runBacktest 由调用方注入），无外部依赖，便于单测
 *  - 确定性（不引入随机源），可复现
 *  - 所有注释使用中文
 */

import type { OHLCVData, StrategyConfig, BacktestResult } from './types.js';
import { compareBacktests } from './backtestEvaluator.js';
import type { BacktestComparison, CompareOptions } from './backtestEvaluator.js';

// ============================================================
// 第一部分：简单滚动窗口评估（旧 API，保留以兼容现有调用方）
// ============================================================

/** 一个滚动窗口的索引区间（含端点） */
export interface WindowRange {
  train: [number, number];
  test: [number, number];
}

/**
 * 生成滚动（rolling）训练/测试窗口索引。
 *  - 每个窗口：train = [start, start+trainSize-1]，test = [start+trainSize, ...+testSize-1]。
 *  - 每次前移 step，直到 test 区间超出序列长度。
 * 纯函数，便于单测。序列过短无法容纳一个完整窗口时返回 []。
 */
export function rollingWindows(
  n: number,
  trainSize: number,
  testSize: number,
  step: number,
): WindowRange[] {
  if (n <= 0 || trainSize <= 0 || testSize <= 0 || step <= 0) return [];
  const out: WindowRange[] = [];
  let start = 0;
  while (start + trainSize + testSize <= n) {
    out.push({
      train: [start, start + trainSize - 1],
      test: [start + trainSize, start + trainSize + testSize - 1],
    });
    start += step;
  }
  return out;
}

export interface WalkForwardFold {
  index: number;
  train: { start: string; end: string; sharpeRatio: number; totalReturn: number; maxDrawdown: number };
  test: { start: string; end: string; sharpeRatio: number; totalReturn: number; maxDrawdown: number };
}

export interface WalkForwardReport {
  /** 各折的样本内(train) / 样本外(test) 表现 */
  folds: WalkForwardFold[];
  /** 平均样本内夏普 */
  avgTrainSharpe: number;
  /** 平均样本外夏普 */
  avgTestSharpe: number;
  /** 样本外稳定性 = avgTestSharpe / avgTrainSharpe（≤0 或除零时记 0） */
  oosRatio: number;
  /** 样本外夏普相对样本内不低于阈值（默认 0.5）即视为稳健 */
  stable: boolean;
  /** 数据不足以构成一个完整窗口 */
  insufficient: boolean;
}

export interface WalkForwardOptions {
  trainSize?: number;
  testSize?: number;
  step?: number;
  /** oosRatio 稳健阈值，默认 0.5 */
  oosRatioThreshold?: number;
}

/** 取回测结果的关键指标（缺省安全值） */
function metricsOf(r: BacktestResult) {
  return {
    sharpeRatio: isFinite(r.sharpeRatio) ? r.sharpeRatio : 0,
    totalReturn: isFinite(r.totalReturn) ? r.totalReturn : 0,
    maxDrawdown: isFinite(r.maxDrawdown) ? r.maxDrawdown : 0,
  };
}

/**
 * Walk-forward（滚动样本外）稳健性回测。
 * 将整段行情切成多个 train/test 窗口，对每个窗口分别回测，
 * 用「样本外夏普 / 样本内夏普」衡量策略是否过度拟合：
 *   - oosRatio 越接近 1，策略越稳健；远低于 1 说明样本内漂亮、样本外崩塌（过拟合信号）。
 * runBacktest 由调用方注入，便于离线/测试时用桩函数替换。
 */
export function walkForwardBacktest(
  runBacktest: (data: OHLCVData[], strategy: StrategyConfig) => BacktestResult,
  ohlcv: OHLCVData[],
  strategy: StrategyConfig,
  opts: WalkForwardOptions = {},
): WalkForwardReport {
  const n = ohlcv.length;
  const trainSize = opts.trainSize ?? Math.max(20, Math.floor(n * 0.6));
  const testSize = opts.testSize ?? Math.max(10, Math.floor(n * 0.2));
  const step = opts.step ?? testSize;
  const threshold = opts.oosRatioThreshold ?? 0.5;

  const windows = rollingWindows(n, trainSize, testSize, step);
  if (windows.length === 0) {
    return {
      folds: [],
      avgTrainSharpe: 0,
      avgTestSharpe: 0,
      oosRatio: 0,
      stable: false,
      insufficient: true,
    };
  }

  const folds: WalkForwardFold[] = windows.map((w, i) => {
    const trainData = ohlcv.slice(w.train[0], w.train[1] + 1);
    const testData = ohlcv.slice(w.test[0], w.test[1] + 1);
    const trainStrat: StrategyConfig = {
      ...strategy,
      startDate: trainData[0]?.date ?? strategy.startDate,
      endDate: trainData[trainData.length - 1]?.date ?? strategy.endDate,
    };
    const testStrat: StrategyConfig = {
      ...strategy,
      startDate: testData[0]?.date ?? strategy.startDate,
      endDate: testData[testData.length - 1]?.date ?? strategy.endDate,
    };
    const tm = metricsOf(runBacktest(trainData, trainStrat));
    const pm = metricsOf(runBacktest(testData, testStrat));
    return {
      index: i,
      train: { start: trainStrat.startDate, end: trainStrat.endDate, ...tm },
      test: { start: testStrat.startDate, end: testStrat.endDate, ...pm },
    };
  });

  const avgTrainSharpe = folds.reduce((s, f) => s + f.train.sharpeRatio, 0) / folds.length;
  const avgTestSharpe = folds.reduce((s, f) => s + f.test.sharpeRatio, 0) / folds.length;
  const oosRatio =
    isFinite(avgTrainSharpe) && avgTrainSharpe !== 0 ? avgTestSharpe / avgTrainSharpe : 0;

  return {
    folds,
    avgTrainSharpe,
    avgTestSharpe,
    oosRatio,
    stable: oosRatio >= threshold,
    insufficient: false,
  };
}

// ============================================================
// 第二部分：Walk-Forward 完整评估模式（新 API）
// 基于 equityCurve + compareBacktests 的异步滚动 OOS 评估
// ============================================================

/** 权益曲线数据点 */
export interface EquityPoint {
  date: string;
  value: number;
}

/** 单窗口数据切片（含权益曲线与基准曲线） */
export interface WindowDataSlice {
  /** 训练/测试期的权益曲线切片 */
  equity: EquityPoint[];
  /** 训练/测试期的基准曲线切片 */
  benchmark: EquityPoint[];
}

/**
 * Walk-Forward 配置
 */
export interface WalkForwardConfig {
  /** 训练窗口大小（数据点数） */
  trainSize: number;
  /** 测试窗口大小（数据点数） */
  testSize: number;
  /** 滑动步长，默认 = testSize（测试窗不重叠） */
  step?: number;
  /**
   * true = expanding window（训练窗从起点扩张，长度递增）
   * false = rolling window（固定长度滑动）
   * 默认 false
   */
  anchored?: boolean;
}

/**
 * 单个 Walk-Forward 窗口的评估结果
 */
export interface WalkForwardWindow {
  /** 训练期起始日期 */
  trainStart: string;
  /** 训练期结束日期 */
  trainEnd: string;
  /** 测试期起始日期 */
  testStart: string;
  /** 测试期结束日期 */
  testEnd: string;
  /** 训练期（样本内，IS）回测结果 —— 同一策略，对应 runBacktest 返回的 baseline 槽位 */
  trainResult: BacktestResult;
  /** 测试期（样本外，OOS）回测结果 —— 同一策略，对应 runBacktest 返回的 experiment 槽位 */
  testResult: BacktestResult;
  /** 单窗口 IS vs OOS 对比（过拟合诊断），由 compareBacktests 生成 */
  comparison: BacktestComparison;
}

/**
 * Walk-Forward 汇总结果
 */
export interface WalkForwardResult {
  /** 各窗口明细 */
  windows: WalkForwardWindow[];
  /** 样本外平均夏普比率 */
  oosSharpe: number;
  /** 样本外平均总收益率（%） */
  oosReturn: number;
  /** 样本外平均胜率（%） */
  oosWinRate: number;
  /** 子期间 OOS 表现一致性（0-1，越高越稳定） */
  consistencyScore: number;
  /** 人类可读总结 */
  summary: string;
  /** 注意事项（数据质量/样本量/过拟合/一致性等） */
  caveats: string[];
}

/**
 * runWalkForward 入参
 */
export interface WalkForwardParams {
  /** 完整权益曲线 */
  equityCurve: EquityPoint[];
  /** 完整基准曲线（买入持有），可为空 */
  benchmarkCurve: EquityPoint[];
  /** Walk-Forward 配置 */
  config: WalkForwardConfig;
  /**
   * 由调用方注入的回测函数。
   * 对每个窗口，接收训练/测试数据切片与配置，返回该策略在样本内（IS）与样本外（OOS）的结果。
   * 注意：本模块语义是「同一策略 IS vs OOS」（回答是否过拟合），
   * baseline 槽位装 IS（trainData）结果、experiment 槽位装 OOS（testData）结果，
   * 二者不是「无 LLM vs 带 LLM」的信号对比 —— 那种受控对比请直接使用 compareBacktests。
   */
  runBacktest: (
    trainData: WindowDataSlice,
    testData: WindowDataSlice,
    cfg: WalkForwardConfig,
  ) => Promise<{ baseline: BacktestResult; experiment: BacktestResult }>;
  /** 透传给 compareBacktests 的选项（如搜索次数、bootstrap 参数等） */
  compareOptions?: CompareOptions;
}

/** 窗口索引区间（含端点） */
interface WindowSlice {
  train: [number, number];
  test: [number, number];
}

/**
 * 按配置切分窗口索引。
 *
 * - anchored=false（rolling window，默认）：训练窗固定长度 trainSize，随窗口前移滑动。
 *   窗口 i：train = [i·step, i·step+trainSize-1]，test = [trainSize+i·step, +testSize-1]
 *
 * - anchored=true（expanding window）：训练窗起点固定为 0，终点随窗口前移扩张。
 *   窗口 i：train = [0, trainSize+i·step-1]，test = [trainSize+i·step, +testSize-1]
 *
 * - step 默认 = testSize（测试窗不重叠）。
 *
 * 纯函数，序列过短无法容纳一个完整窗口时返回 []。
 *
 * @param n 序列总长度
 * @param config Walk-Forward 配置
 * @returns 窗口索引区间数组
 */
export function sliceWindows(n: number, config: WalkForwardConfig): WindowSlice[] {
  const { trainSize, testSize } = config;
  const step = config.step ?? testSize;
  const anchored = config.anchored ?? false;

  if (n <= 0 || trainSize <= 0 || testSize <= 0 || step <= 0) return [];

  const out: WindowSlice[] = [];
  let i = 0;
  while (true) {
    const testStart = trainSize + i * step;
    // 测试窗必须完整落在序列范围内
    if (testStart + testSize > n) break;

    const testEnd = testStart + testSize - 1;
    let trainStart: number;
    let trainEnd: number;

    if (anchored) {
      // expanding window：训练窗起点固定为 0，终点扩张至测试窗起点前一位
      trainStart = 0;
      trainEnd = testStart - 1;
    } else {
      // rolling window：训练窗固定长度 trainSize，随窗口前移
      trainStart = i * step;
      trainEnd = i * step + trainSize - 1;
    }

    out.push({ train: [trainStart, trainEnd], test: [testStart, testEnd] });
    i++;
  }
  return out;
}

/**
 * 计算样本标准差（n-1 自由度）
 * @param xs 数值数组
 * @returns 样本标准差；元素数 < 2 时返回 0
 */
function sampleStd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * 一致性评分 = 1 - (子期间 Sharpe 标准差 / 子期间 Sharpe 均值)
 *
 * 衡量各窗口 OOS Sharpe 的稳定程度：
 *  - 越接近 1 越稳定（各子期间表现一致）
 *  - 越接近 0 越不稳定（各子期间表现波动大）
 *
 * 边界处理：
 *  - 空数组 → 0
 *  - 均值 ≤ 0 → 0（无正收益可谈稳定性）
 *  - 结果裁剪到 [0, 1]
 *
 * @param sharpes 各窗口的 OOS Sharpe 数组
 * @returns 一致性评分 ∈ [0, 1]
 */
export function consistencyScore(sharpes: number[]): number {
  const n = sharpes.length;
  if (n === 0) return 0;
  const mean = sharpes.reduce((s, x) => s + x, 0) / n;
  if (mean <= 0) return 0;
  const std = sampleStd(sharpes);
  const cv = std / mean; // 变异系数
  return Math.max(0, Math.min(1, 1 - cv));
}

/**
 * 构建 Walk-Forward 人类可读总结
 */
function buildWalkForwardSummary(
  windowCount: number,
  anchored: boolean,
  oosSharpe: number,
  oosReturn: number,
  oosWinRate: number,
  consistency: number,
): string {
  const mode = anchored
    ? 'expanding window（扩张窗口）'
    : 'rolling window（滚动窗口）';
  const stability =
    consistency >= 0.7
      ? '较为稳定'
      : consistency >= 0.4
        ? '稳定性一般'
        : '稳定性较差';
  return (
    `Walk-Forward 评估完成（${mode}）：共 ${windowCount} 个窗口，` +
    `OOS 平均夏普 ${oosSharpe.toFixed(2)}，平均收益 ${oosReturn.toFixed(2)}%，` +
    `平均胜率 ${oosWinRate.toFixed(1)}%，一致性评分 ${consistency.toFixed(2)}（${stability}）。`
  );
}

/**
 * 执行 Walk-Forward 滚动回测评估。
 *
 * 流程：
 *  1. 按 config 切分权益曲线为多个 train/test 窗口
 *  2. 对每个窗口调用注入的 runBacktest，获取同一策略的 IS（baseline 槽位）+ OOS（experiment 槽位）结果
 *  3. 用 compareBacktests 对每个窗口做 IS vs OOS 对比（过拟合诊断）
 *  4. 汇总所有窗口的 OOS 表现（夏普/收益/胜率）
 *  5. 计算 consistencyScore = 1 - (子期间 Sharpe 标准差 / 子期间 Sharpe 均值)
 *  6. 生成总结与注意事项
 *
 * 语义：IS vs OOS 的对比衡量「该策略是否过拟合」，而非「LLM 信号 vs 基线」。
 *
 * @param params Walk-Forward 评估参数
 * @returns Walk-Forward 汇总结果
 */
export async function runWalkForward(
  params: WalkForwardParams,
): Promise<WalkForwardResult> {
  const { equityCurve, benchmarkCurve, config, runBacktest, compareOptions } = params;
  const caveats: string[] = [];
  const anchored = config.anchored ?? false;

  // === 数据质量检查 ===
  if (equityCurve.length === 0) {
    caveats.push('权益曲线为空，无法进行 Walk-Forward 评估');
    return {
      windows: [],
      oosSharpe: 0,
      oosReturn: 0,
      oosWinRate: 0,
      consistencyScore: 0,
      summary: '权益曲线为空，无可用窗口。',
      caveats,
    };
  }

  if (benchmarkCurve.length > 0 && benchmarkCurve.length !== equityCurve.length) {
    caveats.push(
      `权益曲线长度(${equityCurve.length})与基准曲线长度(${benchmarkCurve.length})不一致，基准切片可能错位`,
    );
  }

  // === 窗口切分 ===
  const windows = sliceWindows(equityCurve.length, config);
  if (windows.length === 0) {
    caveats.push(
      `数据长度(${equityCurve.length})不足以构成一个完整窗口` +
        `（需至少 trainSize+testSize=${config.trainSize + config.testSize} 个点）`,
    );
    return {
      windows: [],
      oosSharpe: 0,
      oosReturn: 0,
      oosWinRate: 0,
      consistencyScore: 0,
      summary: '数据不足以构成任何 Walk-Forward 窗口。',
      caveats,
    };
  }

  if (windows.length < 3) {
    caveats.push(
      `仅 ${windows.length} 个窗口，统计显著性有限，建议至少 3 个以上窗口以获得可靠的稳定性评估`,
    );
  }

  // === 逐窗口回测 ===
  const wfWindows: WalkForwardWindow[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const trainEquity = equityCurve.slice(w.train[0], w.train[1] + 1);
    const testEquity = equityCurve.slice(w.test[0], w.test[1] + 1);
    const trainBenchmark =
      benchmarkCurve.length > 0
        ? benchmarkCurve.slice(w.train[0], w.train[1] + 1)
        : [];
    const testBenchmark =
      benchmarkCurve.length > 0
        ? benchmarkCurve.slice(w.test[0], w.test[1] + 1)
        : [];

    const trainData: WindowDataSlice = { equity: trainEquity, benchmark: trainBenchmark };
    const testData: WindowDataSlice = { equity: testEquity, benchmark: testBenchmark };

    // 调用注入的 runBacktest，获取同一策略的 IS（baseline 槽位）+ OOS（experiment 槽位）
    const { baseline, experiment } = await runBacktest(trainData, testData, config);

    // 单窗口 IS vs OOS 对比（过拟合诊断）
    const comparison = compareBacktests(baseline, experiment, compareOptions);

    wfWindows.push({
      trainStart: trainEquity[0]?.date ?? '',
      trainEnd: trainEquity[trainEquity.length - 1]?.date ?? '',
      testStart: testEquity[0]?.date ?? '',
      testEnd: testEquity[testEquity.length - 1]?.date ?? '',
      trainResult: baseline,
      testResult: experiment,
      comparison,
    });
  }

  // === OOS 指标汇总 ===
  const oosSharpes = wfWindows.map((w) => w.testResult.sharpeRatio ?? 0);
  const oosReturns = wfWindows.map((w) => w.testResult.totalReturn ?? 0);
  const oosWinRates = wfWindows.map((w) => w.testResult.winRate ?? 0);

  const oosSharpe = oosSharpes.reduce((s, x) => s + x, 0) / oosSharpes.length;
  const oosReturn = oosReturns.reduce((s, x) => s + x, 0) / oosReturns.length;
  const oosWinRate = oosWinRates.reduce((s, x) => s + x, 0) / oosWinRates.length;
  const consistency = consistencyScore(oosSharpes);

  // === 注意事项（caveats） ===
  // OOS 夏普为负
  if (oosSharpe < 0) {
    caveats.push(
      `OOS 平均夏普为负(${oosSharpe.toFixed(2)})，策略在样本外整体亏损，建议检查策略有效性`,
    );
  }

  // 一致性评分偏低
  if (consistency < 0.5) {
    caveats.push(
      `一致性评分偏低(${consistency.toFixed(2)})，各窗口 OOS 表现波动较大，策略稳定性存疑`,
    );
  }

  // 过拟合检测：OOS 夏普远低于 IS 夏普
  const isSharpes = wfWindows.map((w) => w.trainResult.sharpeRatio ?? 0);
  const avgIsSharpe = isSharpes.reduce((s, x) => s + x, 0) / isSharpes.length;
  if (avgIsSharpe > 0 && oosSharpe < avgIsSharpe * 0.5) {
    caveats.push(
      `OOS 平均夏普(${oosSharpe.toFixed(2)})远低于 IS 平均夏普(${avgIsSharpe.toFixed(2)})，` +
        `疑似过拟合：策略在训练期表现良好但样本外显著退化`,
    );
  }

  // 单窗口对比结论统计（此处 experiment 槽位 = OOS，baseline 槽位 = IS）：
  // experiment_wins = OOS 优于 IS；baseline_wins = OOS 劣于 IS（过拟合信号）
  const experimentWins = wfWindows.filter(
    (w) => w.comparison.verdict === 'experiment_wins',
  ).length;
  const baselineWins = wfWindows.filter(
    (w) => w.comparison.verdict === 'baseline_wins',
  ).length;
  // 仅当 OOS 相对 IS 显著退化（而非任何轻微回退）才提示过拟合，避免把正常回退误判为过拟合。
  // 阈值 0.7：OOS 平均夏普 < 70% 的 IS 平均夏普才算显著退化。
  const isOOSSignificantlyWorse = oosSharpe < avgIsSharpe * 0.7;
  if (baselineWins > experimentWins && isOOSSignificantlyWorse) {
    caveats.push(
      `${baselineWins}/${wfWindows.length} 个窗口中样本外劣于样本内，策略整体呈过拟合迹象`,
    );
  }

  const summary = buildWalkForwardSummary(
    wfWindows.length,
    anchored,
    oosSharpe,
    oosReturn,
    oosWinRate,
    consistency,
  );

  return {
    windows: wfWindows,
    oosSharpe,
    oosReturn,
    oosWinRate,
    consistencyScore: consistency,
    summary,
    caveats,
  };
}

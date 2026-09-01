import type { OHLCVData, StrategyConfig, BacktestResult, Trade, FactorOverlay } from './types.js';
import { getBenchmarkCurve } from './dataProvider.js';
import { computePerformance, type AnalyzerContext } from './analyzers.js';
import {
  A_SHARE_COST_MODEL,
  makeCostModel,
  buyCost,
  sellProceeds,
  marketImpactCost,
  type CostModel,
} from './costModel.js';

/**
 * 新闻时效衰减半衰期（天）：与 newsSignal.NEWS_MODEL_CONSTANTS.HALF_LIFE_DAYS 保持一致。
 * 引擎内自带常量而非跨模块 import，保持回测内核零依赖（backtrader 同款取舍）。
 */
const NEWS_HALF_LIFE_DAYS = 5.8;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * 计算 bar 日期的新闻姿态 posture ∈ [0,1]（建仓资金缩放系数）。
 * 严格时序语义（items 存在时优先）：
 *   只使用发布日 ≤ barDate 的新闻，按 exp 半衰期（NEWS_HALF_LIFE_DAYS）衰减加权聚合极性，
 *   posture = 0.5 + 0.5·polarity；本 bar 尚无任何已知新闻时返回 1（与基线一致）——
 *   全程无未来信息，消除"聚合常数叠加"的前视偏差。
 * 旧口径回退（无 items）：聚合极性常数，自 since 起生效，此前返回 1。
 * @returns posture ∈ [0,1]；无叠加层时恒为 1
 */
export function newsOverlayPostureAt(
  overlay:
    | { polarity: number; since?: string; items?: { publishedAt: string; polarity: number }[] }
    | undefined,
  barDate: string,
): number {
  if (!overlay) return 1;

  // 严格时序：归一化 + 排序 + 逐条判定发布日
  const timeline = (overlay.items ?? [])
    .map((pt) => ({
      date: String(pt.publishedAt ?? '').slice(0, 10),
      polarity: Number(pt.polarity),
    }))
    .filter((pt) => /^\d{4}-\d{2}-\d{2}$/.test(pt.date) && Number.isFinite(pt.polarity))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (timeline.length > 0) {
    let wSum = 0;
    let pSum = 0;
    for (const pt of timeline) {
      if (pt.date > barDate) break; // 已排序：其后条目均晚于本 bar（未来信息，跳过）
      const age = Math.max(0, (Date.parse(barDate) - Date.parse(pt.date)) / 86400000);
      const w = Math.pow(2, -age / NEWS_HALF_LIFE_DAYS);
      wSum += w;
      pSum += w * Math.max(-1, Math.min(1, pt.polarity));
    }
    if (!(wSum > 0)) return 1; // 尚无已知新闻：与基线一致（不缩仓）
    const p = Math.max(-1, Math.min(1, pSum / wSum));
    return clamp01(0.5 + 0.5 * p);
  }

  // 旧口径：聚合常数，自 since 起
  if (overlay.since && barDate < overlay.since) return 1;
  return clamp01(0.5 + 0.5 * Math.max(-1, Math.min(1, overlay.polarity)));
}

/** 把 items 时间线归一化为排序后的日期列表（取最早发布日等场景用） */
function overlayFirstDate(
  overlay:
    | { polarity: number; since?: string; items?: { publishedAt: string; polarity: number }[] }
    | undefined,
): string | undefined {
  const dates = (overlay?.items ?? [])
    .map((pt) => String(pt.publishedAt ?? '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates[0];
}

/**
 * 组合 alpha 信号姿态 posture ∈ [0,1]（建仓资金缩放系数）。
 * 组合 alpha 是「全周期方向性结论」（无逐条时间线），故姿态对每根 bar 为常数：
 *   - 显式传入 posture 时直接采用并截到 [0,1]；
 *   - 否则由 alpha 推导 posture = clamp(0.5 + 0.5·alpha, 0, 1)
 *     （看多满仓、中性半仓、看空 0 空仓，long-only 下不可做空）。
 * 与 newsOverlay 的 posture 在引擎内取较小值（AND 语义）——任一信号看空都将压制仓位，
 * 避免两层信号相互叠加放大风险。
 * @returns posture ∈ [0,1]；无叠加层时恒为 1
 */
export function factorOverlayPostureAt(
  overlay: FactorOverlay | undefined,
  _barDate?: string,
): number {
  if (!overlay) return 1;
  if (typeof overlay.posture === 'number' && Number.isFinite(overlay.posture)) {
    return clamp01(overlay.posture);
  }
  return clamp01(0.5 + 0.5 * (Number.isFinite(overlay.alpha) ? overlay.alpha : 0));
}

/**
 * 运行回测
 * 逐K线回放，严格按时间顺序，杜绝未来函数；
 * 成交采用 T+1 信号延迟（backtrader Market 单 / qlib shift=1 语义）：信号 T 日收盘生成、
 * T+1 日开盘价成交。
 *
 * 成本处理为可插拔成本模型（CostModel）：
 * - 未显式传入 costModel 时，按 strategy.commission / strategy.slippage 构造对称模型，行为与历史一致；
 * - strategy.costModel = 'a_share' 时使用 A 股真实费率（佣金万 2.5 双边 + 印花税万 5 卖出单边 + 最低佣金 5 元）；
 * - 也可直接传入自定义 CostModel（如不对称费率、最低费用、冲击成本场景）。
 */
export function runBacktest(
  data: OHLCVData[],
  strategy: StrategyConfig,
  costModelOverride?: CostModel,
): BacktestResult {
  const initialCapital = strategy.initialCapital || 1000000;
  // 显式传 0（关掉费用做对照实验）必须生效，不能用 || 吞成默认万三
  const commission = strategy.commission ?? 0.0003; // 万三
  const slippage = strategy.slippage ?? 0.001; // 0.1%

  const costModel: CostModel =
    costModelOverride ??
    (strategy.costModel === 'a_share'
      ? A_SHARE_COST_MODEL
      : makeCostModel({ openRate: commission, closeRate: commission, slippage }));

  // 最新消息情绪叠加层：posture = clamp(0.5 + 0.5·polarity, 0, 1)
  //   polarity=+1(全面利好) → posture=1 满仓；polarity=0(中性) → 0.5 半仓；
  //   polarity=−1(全面利空) → 0 不建仓。仅在「建仓」时缩放仓位，平仓不受影响。
  //   严格时序：items 时间线存在时逐 bar 只用已知新闻（newsOverlayPostureAt）；
  //   否则退化为旧口径（自 since 起常数 posture）。
  const newsOverlay = strategy.newsOverlay;
  const newsAware = !!newsOverlay;
  const newsSince = newsOverlay?.since ?? overlayFirstDate(newsOverlay);
  const newsPosture = newsOverlay
    ? newsOverlayPostureAt(newsOverlay, data[data.length - 1]?.date ?? '')
    : 1;
  // 组合 alpha 信号叠加层（量价因子研究方向 → 可交易 overlay）：姿态为常数（全周期方向性结论），
  // posture = clamp(0.5 + 0.5·alpha, 0, 1)。与新闻姿态取较小值（AND 语义）：任一信号看空即压制仓位，
  // 不互相叠加放大。仅在「建仓」时缩放，平仓不受影响。
  const factorOverlay = strategy.factorOverlay;
  const factorAware = !!factorOverlay;
  const factorDirection = factorOverlay?.direction;
  const factorPosture = factorOverlay
    ? factorOverlayPostureAt(factorOverlay, data[data.length - 1]?.date ?? '')
    : 1;
  const postureAt = (barDate: string) =>
    Math.min(
      newsOverlayPostureAt(newsOverlay, barDate),
      factorOverlayPostureAt(factorOverlay, barDate),
    );

  let cash = initialCapital;
  let position = 0; // 持仓股数
  const trades: Trade[] = [];
  const equityCurve: { date: string; value: number }[] = [];

  // 预计算收盘价前缀和，使 MA 查询从 O(period) 降为 O(1)，消除逐 bar 重复求和
  const prefixSum = new Float64Array(data.length + 1);
  for (let i = 0; i < data.length; i++) {
    prefixSum[i + 1] = prefixSum[i] + data[i].close;
  }
  // MA(index, period) = 区间 [index-period+1, index] 收盘价均值；越界返回 NaN
  const maAt = (index: number, period: number): number => {
    if (index < period - 1) return NaN;
    return (prefixSum[index + 1] - prefixSum[index - period + 1]) / period;
  };

  // 根据策略类型生成信号；成交采用「T+1 信号延迟」语义（backtrader Market 单/qlib shift=1）：
  //   信号在 bar i 收盘后生成 → 于 bar i+1 **开盘价**成交——收盘价仅用于决策，成交价取自
  //   下一根 bar 的 open，杜绝「收盘决策 + 同收盘价即时成交」这一现实中不可实现的口径。
  //   数据末 bar 生成的信号无法成交（无下一根），与真实世界一致地丢弃。
  let pending: 'buy' | 'sell' | null = null;

  for (let i = 0; i < data.length; i++) {
    const bar = data[i];

    // 1. 先执行上一 bar 生成的信号（本 bar 开盘价成交）。
    //    停牌 bar（volume=0）无法撮合：信号顺延到下一根有成交的 bar（市场单语义），
    //    避免停牌日照常按 open 成交、系统性高估可成交性
    const tradable = bar.volume > 0;
    if (tradable && pending === 'buy' && position === 0) {
      // 本 bar 的新闻姿态：严格时序（已知新闻加权）或旧口径（since 起常数），无叠加时为 1
      const posture = postureAt(bar.date);
      if (posture > 0) {
        const price = bar.open * (1 + costModel.slippage);
        // 按新闻姿态缩放可用资金（强空新闻 posture→0 时不建仓）
        const deployable = cash * posture;
        // A股100股整数倍；每股价按含买入费率估算（成交额×(1+openRate)，minCost 忽略以便整手取整）
        const shares = Math.floor(deployable / (price * (1 + costModel.openRate)) / 100) * 100;
        if (shares > 0) {
          const { total, fee } = buyCost(costModel, shares, price);
          // 二次方市场冲击成本（qlib Exchange）：impactCost × 参与率² × 成交额
          // （bar.volume 单位为手，×100 换算为股，与 shares 同单位）
          const impact = marketImpactCost(costModel, shares * price, bar.volume * 100, shares);
          cash -= total + impact;
          position = shares;
          trades.push({
            date: bar.date,
            type: 'buy',
            price: Math.round(price * 100) / 100,
            shares,
            commission: Math.round((fee + impact) * 100) / 100,
            reason:
              getSignalReason(strategy, 'buy') +
              (newsAware
                ? `（新闻姿态${(newsOverlayPostureAt(newsOverlay, bar.date) * 100).toFixed(0)}%）`
                : '') +
              (factorAware
                ? `（因子姿态${(factorOverlayPostureAt(factorOverlay, bar.date) * 100).toFixed(0)}%）`
                : ''),
          });
        }
      }
      pending = null;
    } else if (tradable && pending === 'sell' && position > 0) {
      const price = bar.open * (1 - costModel.slippage);
      const { proceeds, fee } = sellProceeds(costModel, position, price);
      const impact = marketImpactCost(costModel, position * price, bar.volume * 100, position);
      cash += proceeds - impact;
      trades.push({
        date: bar.date,
        type: 'sell',
        price: Math.round(price * 100) / 100,
        shares: position,
        commission: Math.round((fee + impact) * 100) / 100,
        reason: getSignalReason(strategy, 'sell'),
      });
      position = 0;
      pending = null;
    }

    // 2. 用本 bar 数据生成新信号（下一 bar 开盘成交）
    const signal = generateSignal(data, i, strategy, maAt);
    if (signal === 'buy' && position === 0) {
      pending = 'buy';
    } else if (signal === 'sell' && position > 0) {
      pending = 'sell';
    }

    // 3. 记录权益
    const equity = cash + position * bar.close;
    equityCurve.push({
      date: bar.date,
      value: Math.round((equity / initialCapital) * 10000) / 100,
    });
  }

  // 绩效指标：由可插拔分析器集合计算（backtrader Analyzer 模式），
  // 新增指标只需追加分析器，无需改动引擎
  const stats = computePerformance({ equityCurve, trades } satisfies AnalyzerContext);
  const round = (v: number) => Math.round(v * 100) / 100;

  return {
    totalReturn: round(stats.totalReturn),
    annualizedReturn: round(stats.annualizedReturn),
    sharpeRatio: round(stats.sharpeRatio),
    sortinoRatio: round(stats.sortinoRatio),
    maxDrawdown: round(stats.maxDrawdown),
    winRate: round(stats.winRate),
    tradeCount: stats.tradeCount,
    profitFactor: round(stats.profitFactor),
    equityCurve,
    trades,
    benchmark: getBenchmarkCurve(data),
    newsAware,
    newsPosture,
    ...(newsSince ? { newsSince } : {}),
    factorAware,
    ...(factorAware ? { factorPosture, ...(factorDirection ? { factorDirection } : {}) } : {}),
  };
}

/**
 * 生成交易信号
 * 严格按时间顺序，只使用 i 及之前的数据
 */
function generateSignal(
  data: OHLCVData[],
  index: number,
  strategy: StrategyConfig,
  maAt: (i: number, p: number) => number,
): 'buy' | 'sell' | 'hold' {
  switch (strategy.type) {
    case 'ma_cross':
      return maCrossSignal(data, index, strategy.params, maAt);
    case 'momentum':
      return momentumSignal(data, index, strategy.params);
    case 'mean_reversion':
      return meanReversionSignal(data, index, strategy.params, maAt);
    default:
      return 'hold';
  }
}

// 均线交叉信号
function maCrossSignal(
  data: OHLCVData[],
  index: number,
  params: Record<string, number>,
  maAt: (i: number, p: number) => number,
): 'buy' | 'sell' | 'hold' {
  const shortPeriod = params.shortPeriod || 5;
  const longPeriod = params.longPeriod || 20;

  if (index < longPeriod) return 'hold';

  const shortMA = maAt(index, shortPeriod);
  const longMA = maAt(index, longPeriod);
  const prevShortMA = maAt(index - 1, shortPeriod);
  const prevLongMA = maAt(index - 1, longPeriod);

  // 金叉买入
  if (prevShortMA <= prevLongMA && shortMA > longMA) return 'buy';
  // 死叉卖出
  if (prevShortMA >= prevLongMA && shortMA < longMA) return 'sell';

  return 'hold';
}

// 动量信号
function momentumSignal(
  data: OHLCVData[],
  index: number,
  params: Record<string, number>,
): 'buy' | 'sell' | 'hold' {
  const lookback = params.lookback || 20;
  const buyThreshold = (params.buyThreshold || 5) / 100;
  const sellThreshold = (params.sellThreshold || -3) / 100;

  if (index < lookback) return 'hold';

  const momentum =
    (data[index].close - data[index - lookback].close) / data[index - lookback].close;

  if (momentum > buyThreshold) return 'buy';
  if (momentum < sellThreshold) return 'sell';

  return 'hold';
}

// 均值回归信号
function meanReversionSignal(
  data: OHLCVData[],
  index: number,
  params: Record<string, number>,
  maAt: (i: number, p: number) => number,
): 'buy' | 'sell' | 'hold' {
  const maPeriod = params.maPeriod || 20;
  const buyDev = (params.buyDeviation || -3) / 100;
  const sellDev = (params.sellDeviation || 3) / 100;

  if (index < maPeriod) return 'hold';

  const ma = maAt(index, maPeriod);
  const deviation = (data[index].close - ma) / ma;

  if (deviation < buyDev) return 'buy'; // 价格低于均线过多，买入
  if (deviation > sellDev) return 'sell'; // 价格高于均线过多，卖出

  return 'hold';
}

// 获取信号原因描述
function getSignalReason(strategy: StrategyConfig, signal: 'buy' | 'sell'): string {
  switch (strategy.type) {
    case 'ma_cross':
      return signal === 'buy' ? '短期均线上穿长期均线（金叉）' : '短期均线下穿长期均线（死叉）';
    case 'momentum':
      return signal === 'buy' ? '动量超过买入阈值' : '动量跌破卖出阈值';
    case 'mean_reversion':
      return signal === 'buy' ? '价格偏离均线下方超过阈值' : '价格偏离均线上方超过阈值';
    default:
      return '自定义信号';
  }
}

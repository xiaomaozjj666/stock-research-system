import type { OHLCVData, StrategyConfig, BacktestResult, Trade } from './types.js';
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
 * 运行回测
 * 逐K线回放，严格按时间顺序，杜绝未来函数
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
  const commission = strategy.commission || 0.0003; // 万三
  const slippage = strategy.slippage || 0.001; // 0.1%

  const costModel: CostModel =
    costModelOverride ??
    (strategy.costModel === 'a_share'
      ? A_SHARE_COST_MODEL
      : makeCostModel({ openRate: commission, closeRate: commission, slippage }));

  // 最新消息情绪叠加层：posture = clamp(0.5 + 0.5·polarity, 0, 1)
  //   polarity=+1(全面利好) → posture=1 满仓；polarity=0(中性) → 0.5 半仓；
  //   polarity=−1(全面利空) → 0 不建仓。仅在「建仓」时缩放仓位，平仓不受影响。
  const newsOverlay = strategy.newsOverlay;
  const newsAware = !!newsOverlay;
  const newsPosture = newsOverlay ? Math.max(0, Math.min(1, 0.5 + 0.5 * newsOverlay.polarity)) : 1;

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

  // 根据策略类型生成信号
  for (let i = 0; i < data.length; i++) {
    const bar = data[i];
    const signal = generateSignal(data, i, strategy, maAt);

    // 执行交易
    if (signal === 'buy' && position === 0) {
      if (newsPosture > 0) {
        const price = bar.close * (1 + costModel.slippage);
        // 按新闻姿态缩放可用资金（强空新闻 posture→0 时不建仓）
        const deployable = cash * newsPosture;
        // A股100股整数倍；每股价按含买入费率估算（成交额×(1+openRate)，minCost 忽略以便整手取整）
        const shares = Math.floor(deployable / (price * (1 + costModel.openRate)) / 100) * 100;
        if (shares > 0) {
          const { total, fee } = buyCost(costModel, shares, price);
          // 二次方市场冲击成本（qlib Exchange）：impactCost × (成交额/当日成交量)²
          const impact = marketImpactCost(costModel, shares * price, bar.volume);
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
              (newsAware ? `（新闻姿态${(newsPosture * 100).toFixed(0)}%）` : ''),
          });
        }
      }
    } else if (signal === 'sell' && position > 0) {
      const price = bar.close * (1 - costModel.slippage);
      const { proceeds, fee } = sellProceeds(costModel, position, price);
      const impact = marketImpactCost(costModel, position * price, bar.volume);
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
    }

    // 记录权益
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

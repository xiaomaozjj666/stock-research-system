import type { OHLCVData, StrategyConfig, BacktestResult, Trade } from './types.js';
import { getBenchmarkCurve } from './dataProvider.js';

/**
 * 运行回测
 * 逐K线回放，严格按时间顺序，杜绝未来函数
 */
export function runBacktest(data: OHLCVData[], strategy: StrategyConfig): BacktestResult {
  const initialCapital = strategy.initialCapital || 1000000;
  const commission = strategy.commission || 0.0003; // 万三
  const slippage = strategy.slippage || 0.001; // 0.1%

  // 最新消息情绪叠加层：posture = clamp(0.5 + 0.5·polarity, 0, 1)
  //   polarity=+1(全面利好) → posture=1 满仓；polarity=0(中性) → 0.5 半仓；
  //   polarity=−1(全面利空) → 0 不建仓。仅在「建仓」时缩放仓位，平仓不受影响。
  const newsOverlay = strategy.newsOverlay;
  const newsAware = !!newsOverlay;
  const newsPosture = newsOverlay
    ? Math.max(0, Math.min(1, 0.5 + 0.5 * newsOverlay.polarity))
    : 1;

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
        const price = bar.close * (1 + slippage);
        // 按新闻姿态缩放可用资金（强空新闻 posture→0 时不建仓）
        const deployable = cash * newsPosture;
        const shares = Math.floor(deployable / (price * (1 + commission)) / 100) * 100; // A股100股整数倍
        if (shares > 0) {
          const cost = shares * price * (1 + commission);
          cash -= cost;
          position = shares;
          trades.push({
            date: bar.date,
            type: 'buy',
            price: Math.round(price * 100) / 100,
            shares,
            commission: Math.round(shares * price * commission * 100) / 100,
            reason: getSignalReason(strategy, 'buy') + (newsAware ? `（新闻姿态${(newsPosture * 100).toFixed(0)}%）` : '')
          });
        }
      }
    } else if (signal === 'sell' && position > 0) {
      const price = bar.close * (1 - slippage);
      const revenue = position * price * (1 - commission);
      cash += revenue;
      trades.push({
        date: bar.date,
        type: 'sell',
        price: Math.round(price * 100) / 100,
        shares: position,
        commission: Math.round(position * price * commission * 100) / 100,
        reason: getSignalReason(strategy, 'sell')
      });
      position = 0;
    }

    // 记录权益
    const equity = cash + position * bar.close;
    equityCurve.push({ date: bar.date, value: Math.round(equity / initialCapital * 10000) / 100 });
  }

  // 计算绩效指标
  const totalReturn = ((equityCurve[equityCurve.length - 1].value - 100) / 100) * 100;
  const years = data.length / 252;
  const annualizedReturn = (Math.pow(1 + totalReturn / 100, 1 / years) - 1) * 100;

  // 夏普比率（基于日收益率，扣除无风险利率）
  const riskFreeRate = 0.025; // 中国10年期国债收益率
  const dailyRiskFree = riskFreeRate / 252;
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    dailyReturns.push((equityCurve[i].value - equityCurve[i - 1].value) / equityCurve[i - 1].value);
  }
  const avgDailyReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const excessAvgReturn = avgDailyReturn - dailyRiskFree;
  const dailyStdDev = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDailyReturn) ** 2, 0) / dailyReturns.length);
  const sharpeRatio = dailyStdDev > 0 ? (excessAvgReturn / dailyStdDev) * Math.sqrt(252) : 0;

  // 索提诺比率（只考虑下行风险）
  const excessReturns = dailyReturns.map(r => r - dailyRiskFree);
  const downsideReturns = excessReturns.filter(r => r < 0);
  const downsideDev = downsideReturns.length > 0
    ? Math.sqrt(downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length)
    : 0;
  const sortinoRatio = downsideDev > 0 ? (excessAvgReturn / downsideDev) * Math.sqrt(252) : 0;

  // 最大回撤
  let maxDrawdown = 0;
  let peak = equityCurve[0].value;
  for (const point of equityCurve) {
    if (point.value > peak) peak = point.value;
    const drawdown = (peak - point.value) / peak * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // 胜率（考虑交易成本）
  const transactionCostRate = 0.001; // 单次交易成本（佣金+滑点）
  const sellTrades = trades.filter(t => t.type === 'sell');
  const buyTrades = trades.filter(t => t.type === 'buy');
  let wins = 0;
  for (let i = 0; i < Math.min(buyTrades.length, sellTrades.length); i++) {
    // 考虑买卖双向交易成本
    const netReturn = sellTrades[i].price * (1 - transactionCostRate) - buyTrades[i].price * (1 + transactionCostRate);
    if (netReturn > 0) wins++;
  }
  const winRate = sellTrades.length > 0 ? (wins / sellTrades.length) * 100 : 0;

  // 盈亏比
  const totalProfit = sellTrades.filter((t, i) => t.price > buyTrades[i]?.price)
    .reduce((s, t, i) => s + (t.price - buyTrades[i].price) * t.shares, 0);
  const totalLoss = sellTrades.filter((t, i) => t.price <= buyTrades[i]?.price)
    .reduce((s, t, i) => s + (buyTrades[i].price - t.price) * t.shares, 0);
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 99 : 0;

  return {
    totalReturn: Math.round(totalReturn * 100) / 100,
    annualizedReturn: Math.round(annualizedReturn * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    sortinoRatio: Math.round(sortinoRatio * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    winRate: Math.round(winRate * 100) / 100,
    tradeCount: trades.length,
    profitFactor: Math.round(profitFactor * 100) / 100,
    equityCurve,
    trades,
    benchmark: getBenchmarkCurve(data),
    newsAware,
    newsPosture
  };
}

/**
 * 生成交易信号
 * 严格按时间顺序，只使用 i 及之前的数据
 */
function generateSignal(data: OHLCVData[], index: number, strategy: StrategyConfig, maAt: (i: number, p: number) => number): 'buy' | 'sell' | 'hold' {
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
function maCrossSignal(data: OHLCVData[], index: number, params: Record<string, number>, maAt: (i: number, p: number) => number): 'buy' | 'sell' | 'hold' {
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
function momentumSignal(data: OHLCVData[], index: number, params: Record<string, number>): 'buy' | 'sell' | 'hold' {
  const lookback = params.lookback || 20;
  const buyThreshold = (params.buyThreshold || 5) / 100;
  const sellThreshold = (params.sellThreshold || -3) / 100;

  if (index < lookback) return 'hold';

  const momentum = (data[index].close - data[index - lookback].close) / data[index - lookback].close;

  if (momentum > buyThreshold) return 'buy';
  if (momentum < sellThreshold) return 'sell';

  return 'hold';
}

// 均值回归信号
function meanReversionSignal(data: OHLCVData[], index: number, params: Record<string, number>, maAt: (i: number, p: number) => number): 'buy' | 'sell' | 'hold' {
  const maPeriod = params.maPeriod || 20;
  const buyDev = (params.buyDeviation || -3) / 100;
  const sellDev = (params.sellDeviation || 3) / 100;

  if (index < maPeriod) return 'hold';

  const ma = maAt(index, maPeriod);
  const deviation = (data[index].close - ma) / ma;

  if (deviation < buyDev) return 'buy';   // 价格低于均线过多，买入
  if (deviation > sellDev) return 'sell';  // 价格高于均线过多，卖出

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

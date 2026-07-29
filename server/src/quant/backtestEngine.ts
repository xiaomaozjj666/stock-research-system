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
  
  let cash = initialCapital;
  let position = 0; // 持仓股数
  const trades: Trade[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  
  // 根据策略类型生成信号
  for (let i = 0; i < data.length; i++) {
    const bar = data[i];
    const signal = generateSignal(data, i, strategy);
    
    // 执行交易
    if (signal === 'buy' && position === 0) {
      const price = bar.close * (1 + slippage);
      const shares = Math.floor(cash / (price * (1 + commission)) / 100) * 100; // A股100股整数倍
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
          reason: getSignalReason(strategy, 'buy')
        });
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
  
  // 夏普比率（基于日收益率）
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    dailyReturns.push((equityCurve[i].value - equityCurve[i - 1].value) / equityCurve[i - 1].value);
  }
  const avgDailyReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const dailyStdDev = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDailyReturn) ** 2, 0) / dailyReturns.length);
  const sharpeRatio = dailyStdDev > 0 ? (avgDailyReturn / dailyStdDev) * Math.sqrt(252) : 0;
  
  // 最大回撤
  let maxDrawdown = 0;
  let peak = equityCurve[0].value;
  for (const point of equityCurve) {
    if (point.value > peak) peak = point.value;
    const drawdown = (peak - point.value) / peak * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  
  // 胜率
  const sellTrades = trades.filter(t => t.type === 'sell');
  const buyTrades = trades.filter(t => t.type === 'buy');
  let wins = 0;
  for (let i = 0; i < Math.min(buyTrades.length, sellTrades.length); i++) {
    if (sellTrades[i].price > buyTrades[i].price) wins++;
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
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    winRate: Math.round(winRate * 100) / 100,
    tradeCount: trades.length,
    profitFactor: Math.round(profitFactor * 100) / 100,
    equityCurve,
    trades,
    benchmark: getBenchmarkCurve(data)
  };
}

/**
 * 生成交易信号
 * 严格按时间顺序，只使用 i 及之前的数据
 */
function generateSignal(data: OHLCVData[], index: number, strategy: StrategyConfig): 'buy' | 'sell' | 'hold' {
  switch (strategy.type) {
    case 'ma_cross':
      return maCrossSignal(data, index, strategy.params);
    case 'momentum':
      return momentumSignal(data, index, strategy.params);
    case 'mean_reversion':
      return meanReversionSignal(data, index, strategy.params);
    default:
      return 'hold';
  }
}

// 均线交叉信号
function maCrossSignal(data: OHLCVData[], index: number, params: Record<string, number>): 'buy' | 'sell' | 'hold' {
  const shortPeriod = params.shortPeriod || 5;
  const longPeriod = params.longPeriod || 20;
  
  if (index < longPeriod) return 'hold';
  
  const shortMA = calcMA(data, index, shortPeriod);
  const longMA = calcMA(data, index, longPeriod);
  const prevShortMA = calcMA(data, index - 1, shortPeriod);
  const prevLongMA = calcMA(data, index - 1, longPeriod);
  
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
function meanReversionSignal(data: OHLCVData[], index: number, params: Record<string, number>): 'buy' | 'sell' | 'hold' {
  const maPeriod = params.maPeriod || 20;
  const buyDev = (params.buyDeviation || -3) / 100;
  const sellDev = (params.sellDeviation || 3) / 100;
  
  if (index < maPeriod) return 'hold';
  
  const ma = calcMA(data, index, maPeriod);
  const deviation = (data[index].close - ma) / ma;
  
  if (deviation < buyDev) return 'buy';   // 价格低于均线过多，买入
  if (deviation > sellDev) return 'sell';  // 价格高于均线过多，卖出
  
  return 'hold';
}

// 计算简单移动平均
function calcMA(data: OHLCVData[], index: number, period: number): number {
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    sum += data[i].close;
  }
  return sum / period;
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

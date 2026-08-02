import type { BacktestResult, AuditReport, StrategyConfig, OptimizationReport } from '../types.js';

/**
 * 策略优化Agent - 策略优化建议（纯函数）
 */
export function strategyOptimizer(
  backtest: BacktestResult,
  audit: AuditReport,
  strategy: StrategyConfig
): OptimizationReport {
  // --- 1. 性能评分 ---
  const performanceScore = calcPerformanceScore(backtest);

  // --- 2. 优化建议 ---
  const suggestions = generateSuggestions(backtest, audit, strategy);

  // --- 3. 参数敏感性分析 ---
  const parameterSensitivity = analyzeParameterSensitivity(strategy, backtest);

  // --- 4. 风险指标 ---
  const riskMetrics = calcRiskMetrics(backtest);

  // --- 5. 迭代方向 ---
  const iterationDirections = generateIterationDirections(backtest, audit, performanceScore);

  return {
    performanceScore,
    suggestions,
    parameterSensitivity,
    riskMetrics,
    iterationDirections,
  };
}

// --- 子函数 ---

/** 性能评分 0-100 */
function calcPerformanceScore(backtest: BacktestResult): number {
  let score = 0;

  // 收益率贡献（0-25）：年化>15%满分
  const annualized = backtest.annualizedReturn ?? 0;
  score += Math.min(25, Math.max(0, (annualized / 15) * 25));

  // 风险调整收益（0-25）：夏普>1.5满分
  const sharpe = backtest.sharpeRatio ?? 0;
  score += Math.min(25, Math.max(0, (sharpe / 1.5) * 25));

  // 回撤控制（0-25）：最大回撤<15%满分（回撤为负数或正数，这里取绝对值）
  const maxDD = Math.abs(backtest.maxDrawdown ?? 0);
  if (maxDD <= 15) {
    score += 25;
  } else if (maxDD <= 40) {
    score += Math.max(0, 25 - ((maxDD - 15) / 25) * 25);
  }

  // 交易质量（0-25）：胜率>50%且盈亏比>1.5满分
  const winRate = backtest.winRate ?? 0;
  const profitFactor = backtest.profitFactor ?? 0;
  const winRateScore = Math.min(12.5, Math.max(0, (winRate / 50) * 12.5));
  const pfScore = Math.min(12.5, Math.max(0, (profitFactor / 1.5) * 12.5));
  score += winRateScore + pfScore;

  return Math.round(Math.min(100, Math.max(0, score)));
}

/** 生成优化建议 */
function generateSuggestions(
  backtest: BacktestResult,
  audit: AuditReport,
  _strategy: StrategyConfig
): OptimizationReport['suggestions'] {
  const suggestions: OptimizationReport['suggestions'] = [];
  const maxDD = Math.abs(backtest.maxDrawdown ?? 0);
  const winRate = backtest.winRate ?? 0;
  const tradeCount = backtest.tradeCount ?? 0;
  const sharpe = backtest.sharpeRatio ?? 0;
  const annualized = backtest.annualizedReturn ?? 0;
  const profitFactor = backtest.profitFactor ?? 0;

  // 回撤过大
  if (maxDD > 20) {
    suggestions.push({
      category: 'risk',
      title: '增加止损机制',
      detail: `最大回撤${maxDD.toFixed(1)}%超过20%，建议增加动态止损线（如ATR止损或固定比例止损）以控制下行风险`,
      impact: 'high',
    });
  }

  // 胜率过低
  if (winRate < 40 && tradeCount > 0) {
    suggestions.push({
      category: 'entry',
      title: '优化入场信号',
      detail: `胜率仅${winRate.toFixed(1)}%，建议增加过滤条件（如趋势确认、成交量验证）提高入场准确率`,
      impact: 'high',
    });
  }

  // 交易次数不足
  if (tradeCount < 20 && tradeCount > 0) {
    suggestions.push({
      category: 'parameter',
      title: '调整参数增加交易频率',
      detail: `仅${tradeCount}次交易，样本不足。建议缩短均线周期或降低入场阈值以获取更多交易信号`,
      impact: 'medium',
    });
  }

  // 夏普比率过低
  if (sharpe < 0.5 && annualized > 0) {
    suggestions.push({
      category: 'position',
      title: '降低仓位或增加对冲',
      detail: `夏普比率${sharpe.toFixed(2)}偏低，风险调整收益不佳。建议降低单次仓位或引入对冲工具`,
      impact: 'medium',
    });
  }

  // 盈亏比过低
  if (profitFactor < 1.2 && profitFactor > 0 && tradeCount > 0) {
    suggestions.push({
      category: 'exit',
      title: '优化出场策略',
      detail: `盈亏比${profitFactor.toFixed(2)}偏低，建议引入移动止盈或延长盈利持仓时间`,
      impact: 'medium',
    });
  }

  // 年化收益为负
  if (annualized < 0) {
    suggestions.push({
      category: 'parameter',
      title: '重新评估策略逻辑',
      detail: `年化收益${annualized.toFixed(1)}%为负，当前参数不适合该标的，建议重新审视策略适用性`,
      impact: 'high',
    });
  }

  // 审计发现过拟合风险
  if (audit.overfittingRisk === 'high') {
    suggestions.push({
      category: 'parameter',
      title: '降低参数精确度',
      detail: '过拟合风险高，建议使用参数区间而非精确值，并进行样本外验证',
      impact: 'high',
    });
  }

  // 审计发现未来函数风险
  if (audit.futureFunctionRisk === 'high') {
    suggestions.push({
      category: 'risk',
      title: '排查未来函数',
      detail: '存在未来函数风险，请确保所有信号仅使用历史数据计算',
      impact: 'high',
    });
  }

  return suggestions;
}

/** 参数敏感性分析 */
function analyzeParameterSensitivity(
  strategy: StrategyConfig,
  backtest: BacktestResult
): OptimizationReport['parameterSensitivity'] {
  const result: OptimizationReport['parameterSensitivity'] = [];
  const params = strategy.params;
  const sharpe = backtest.sharpeRatio ?? 0;
  const winRate = backtest.winRate ?? 0;

  for (const [key, value] of Object.entries(params)) {
    let suggestedMin: number;
    let suggestedMax: number;
    let optimal: number;
    let sensitivity: 'high' | 'medium' | 'low';

    // 基于参数类型给出建议
    if (key === 'shortPeriod' || key === 'lookback' || key === 'maPeriod') {
      // 短期周期类参数
      suggestedMin = Math.max(2, Math.round(value * 0.6));
      suggestedMax = Math.round(value * 1.5);
      optimal = value;
      sensitivity = Math.abs(winRate - 50) > 15 ? 'high' : Math.abs(winRate - 50) > 8 ? 'medium' : 'low';
    } else if (key === 'longPeriod') {
      // 长期周期类参数
      suggestedMin = Math.max(10, Math.round(value * 0.7));
      suggestedMax = Math.round(value * 1.4);
      optimal = value;
      sensitivity = sharpe > 1 ? 'low' : sharpe > 0.5 ? 'medium' : 'high';
    } else if (key.includes('Threshold') || key.includes('Deviation')) {
      // 阈值类参数
      suggestedMin = Math.round(value * 0.5 * 100) / 100;
      suggestedMax = Math.round(value * 1.8 * 100) / 100;
      optimal = value;
      sensitivity = 'medium';
    } else {
      // 通用参数
      suggestedMin = Math.round(value * 0.7 * 100) / 100;
      suggestedMax = Math.round(value * 1.3 * 100) / 100;
      optimal = value;
      sensitivity = 'low';
    }

    result.push({
      param: key,
      currentValue: value,
      suggestedRange: { min: suggestedMin, max: suggestedMax, optimal },
      sensitivity,
    });
  }

  return result;
}

/** 计算风险指标 */
function calcRiskMetrics(backtest: BacktestResult): OptimizationReport['riskMetrics'] {
  // VaR 95%：基于权益曲线计算日收益率
  const curve = backtest.equityCurve ?? [];
  let var95 = 0;
  if (curve.length >= 2) {
    const dailyReturns: number[] = [];
    for (let i = 1; i < curve.length; i++) {
      if (curve[i - 1].value !== 0) {
        dailyReturns.push((curve[i].value - curve[i - 1].value) / curve[i - 1].value);
      }
    }
    if (dailyReturns.length > 0) {
      dailyReturns.sort((a, b) => a - b);
      const idx = Math.floor(dailyReturns.length * 0.05);
      var95 = Math.abs(dailyReturns[idx]) * 100; // 转为百分比
    }
  }

  // 最大连续亏损次数
  let maxConsecutiveLoss = 0;
  let currentLoss = 0;
  const trades = backtest.trades ?? [];
  // 配对交易计算盈亏
  for (let i = 0; i < trades.length - 1; i += 2) {
    const buyTrade = trades.find(t => t.type === 'buy' && t.date === trades[i].date);
    const sellTrade = trades.find(t => t.type === 'sell' && t.date === trades[i + 1]?.date);
    if (buyTrade && sellTrade) {
      const pnl = (sellTrade.price - buyTrade.price) * buyTrade.shares;
      if (pnl < 0) {
        currentLoss++;
        maxConsecutiveLoss = Math.max(maxConsecutiveLoss, currentLoss);
      } else {
        currentLoss = 0;
      }
    }
  }

  // 平均持仓天数
  let avgHoldingDays = 0;
  const holdingPeriods: number[] = [];
  for (let i = 0; i < trades.length - 1; i += 2) {
    const buyDate = new Date(trades[i].date + 'T00:00:00');
    const sellDate = new Date(trades[i + 1].date + 'T00:00:00');
    const days = (sellDate.getTime() - buyDate.getTime()) / (1000 * 60 * 60 * 24);
    if (days >= 0) holdingPeriods.push(days);
  }
  if (holdingPeriods.length > 0) {
    avgHoldingDays = holdingPeriods.reduce((s, d) => s + d, 0) / holdingPeriods.length;
  }

  return {
    var95: Math.round(var95 * 100) / 100,
    maxConsecutiveLoss,
    avgHoldingDays: Math.round(avgHoldingDays * 10) / 10,
  };
}

/** 生成迭代优化方向 */
function generateIterationDirections(
  backtest: BacktestResult,
  audit: AuditReport,
  performanceScore: number
): string[] {
  const directions: string[] = [];
  const maxDD = Math.abs(backtest.maxDrawdown ?? 0);
  const sharpe = backtest.sharpeRatio ?? 0;
  const winRate = backtest.winRate ?? 0;

  if (maxDD > 20) {
    directions.push('引入动态止损和仓位管理（如Kelly公式）降低回撤');
  }
  if (sharpe < 1) {
    directions.push('优化风险调整收益：考虑加入波动率过滤或自适应仓位');
  }
  if (winRate < 45) {
    directions.push('提升入场信号质量：结合多因子确认或机器学习过滤');
  }
  if (audit.overfittingRisk !== 'low') {
    directions.push('进行Walk-Forward验证和参数稳健性测试以降低过拟合');
  }

  directions.push('扩展多标的回测验证策略普适性');

  if (performanceScore < 60) {
    directions.push('考虑组合其他策略类型（如趋势+均值回归）构建复合策略');
  }

  // 保证至少3个方向
  if (directions.length < 3) {
    directions.push('优化交易执行逻辑，减少滑点影响');
  }

  return directions.slice(0, 5);
}

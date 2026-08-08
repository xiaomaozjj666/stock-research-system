import type { BacktestResult, StrategyConfig, AuditReport } from '../types.js';

/**
 * 回测审计Agent - 回测结果审计（纯函数）
 */
export function backtestAuditor(backtest: BacktestResult, strategy: StrategyConfig): AuditReport {
  const checks: AuditReport['checks'] = [];
  const issues: string[] = [];
  let score = 100;

  // --- 1. 未来函数检查 ---
  const futureCheck = checkFutureFunction(backtest, strategy);
  checks.push(futureCheck.check);
  if (!futureCheck.check.passed) {
    score -= futureCheck.penalty;
    issues.push(futureCheck.check.detail);
  }

  // --- 2. 过拟合风险检查 ---
  const overfitCheck = checkOverfitting(backtest, strategy);
  checks.push(overfitCheck.check);
  if (!overfitCheck.check.passed) {
    score -= overfitCheck.penalty;
    issues.push(overfitCheck.check.detail);
  }

  // --- 3. 幸存者偏差检查 ---
  // checkSurvivorshipBias 是信息性检查：单股回测无法完全检测幸存者偏差，设计上恒 passed:true。
  // 下方 if 分支为冗余防御，保留以防未来该检查能返回失败（勿误判为可删除的死代码）。
  const survivorCheck = checkSurvivorshipBias(strategy);
  checks.push(survivorCheck.check);
  if (!survivorCheck.check.passed) {
    score -= survivorCheck.penalty;
    issues.push(survivorCheck.check.detail);
  }

  // --- 4. 交易成本假设检查 ---
  const costCheck = checkTradingCosts(strategy);
  checks.push(costCheck.check);
  if (!costCheck.check.passed) {
    score -= costCheck.penalty;
    issues.push(costCheck.check.detail);
  }

  // --- 5. 统计可靠性检查 ---
  const reliabilityCheck = checkStatisticalReliability(backtest, strategy);
  checks.push(reliabilityCheck.check);
  if (!reliabilityCheck.check.passed) {
    score -= reliabilityCheck.penalty;
    issues.push(reliabilityCheck.check.detail);
  }

  score = Math.max(0, score);

  // 确定风险等级
  const futureFunctionRisk = futureCheck.check.passed ? 'low' : futureCheck.check.severity === 'critical' ? 'high' : 'medium';
  const overfittingRisk = overfitCheck.check.passed ? 'low' : overfitCheck.check.severity === 'critical' ? 'high' : 'medium';
  const survivorshipBias = survivorCheck.check.passed ? 'low' : 'medium';

  // 可靠性评估
  let reliability: string;
  if (score >= 80) {
    reliability = '回测结果可信度较高，可作为参考依据';
  } else if (score >= 60) {
    reliability = '回测结果存在一定风险，建议谨慎参考';
  } else if (score >= 40) {
    reliability = '回测结果可信度较低，需要修正后重新验证';
  } else {
    reliability = '回测结果不可信，存在严重方法论问题';
  }

  return {
    riskScore: score,
    futureFunctionRisk,
    overfittingRisk,
    survivorshipBias,
    checks,
    issues,
    reliability,
  };
}

// --- 审计检查子函数 ---

function checkFutureFunction(backtest: BacktestResult, strategy: StrategyConfig) {
  // 检查交易是否按时间顺序
  let tradesOrdered = true;
  const trades = backtest.trades ?? [];
  for (let i = 1; i < trades.length; i++) {
    if (trades[i].date < trades[i - 1].date) {
      tradesOrdered = false;
      break;
    }
  }

  // 检查均线周期是否合理（不应超过数据范围的一半）
  const startDate = new Date(strategy.startDate + 'T00:00:00');
  const endDate = new Date(strategy.endDate + 'T00:00:00');
  const totalDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
  let paramsReasonable = true;
  const maParams = ['shortPeriod', 'longPeriod', 'lookback', 'maPeriod'];
  for (const p of maParams) {
    if (strategy.params[p] && strategy.params[p] > totalDays * 0.5) {
      paramsReasonable = false;
      break;
    }
  }

  const passed = tradesOrdered && paramsReasonable;
  return {
    check: {
      name: '未来函数检查',
      passed,
      detail: passed
        ? '交易按时间顺序执行，策略参数合理'
        : !tradesOrdered
          ? '交易记录未按时间顺序排列，可能存在未来数据泄露'
          : '策略参数周期超过数据范围一半，可能使用了未来数据',
      severity: (!tradesOrdered ? 'critical' : 'warning') as 'critical' | 'warning',
    },
    penalty: !tradesOrdered ? 20 : !paramsReasonable ? 15 : 0,
  };
}

function checkOverfitting(backtest: BacktestResult, _strategy: StrategyConfig) {
  const tradeCount = backtest.tradeCount ?? 0;
  const annualizedReturn = backtest.annualizedReturn ?? 0;

  // 交易次数过少
  const tooFewTrades = tradeCount < 10;
  // 收益率异常高
  const abnormallyHigh = annualizedReturn > 50;

  const passed = !tooFewTrades && !abnormallyHigh;
  let detail = '';
  if (tooFewTrades && abnormallyHigh) {
    detail = `交易仅${tradeCount}次且年化收益${annualizedReturn.toFixed(1)}%异常高，过拟合风险极高`;
  } else if (tooFewTrades) {
    detail = `交易仅${tradeCount}次，样本不足可能导致过拟合`;
  } else if (abnormallyHigh) {
    detail = `年化收益${annualizedReturn.toFixed(1)}%异常高，可能存在过拟合`;
  } else {
    detail = `交易${tradeCount}次，年化收益${annualizedReturn.toFixed(1)}%，过拟合风险可控`;
  }

  return {
    check: {
      name: '过拟合风险',
      passed,
      detail,
      severity: (tooFewTrades && abnormallyHigh ? 'critical' : tooFewTrades || abnormallyHigh ? 'warning' : 'info') as 'critical' | 'warning' | 'info',
    },
    penalty: tooFewTrades && abnormallyHigh ? 25 : tooFewTrades ? 15 : abnormallyHigh ? 10 : 0,
  };
}

function checkSurvivorshipBias(strategy: StrategyConfig) {
  // 简单启发式：如果股票代码是常见的已退市模式则标记
  // 实际上无法完全检测，这里给出信息性提示
  return {
    check: {
      name: '幸存者偏差',
      passed: true,
      detail: `当前仅测试了单只股票(${strategy.stockCode})，建议增加已退市股票的测试以排除幸存者偏差`,
      severity: 'info' as const,
    },
    penalty: 0,
  };
}

function checkTradingCosts(strategy: StrategyConfig) {
  const commission = strategy.commission ?? 0.0003; // 默认万三
  const slippage = strategy.slippage ?? 0.001; // 默认0.1%

  const commissionReasonable = commission >= 0.0002; // 至少万二
  const hasSlippage = slippage > 0;

  const passed = commissionReasonable && hasSlippage;
  let detail = '';
  if (!commissionReasonable && !hasSlippage) {
    detail = `佣金率(${(commission * 10000).toFixed(1)}‱)偏低且未设置滑点，交易成本假设不充分`;
  } else if (!commissionReasonable) {
    detail = `佣金率(${(commission * 10000).toFixed(1)}‱)偏低，建议不低于万二`;
  } else if (!hasSlippage) {
    detail = '未考虑滑点成本，建议设置至少0.1%的滑点';
  } else {
    detail = `佣金率${(commission * 10000).toFixed(1)}‱，滑点${(slippage * 100).toFixed(2)}%，交易成本假设合理`;
  }

  return {
    check: {
      name: '交易成本假设',
      passed,
      detail,
      severity: (!commissionReasonable ? 'warning' : 'info') as 'warning' | 'info',
    },
    penalty: !commissionReasonable ? 10 : !hasSlippage ? 5 : 0,
  };
}

function checkStatisticalReliability(backtest: BacktestResult, strategy: StrategyConfig) {
  const tradeCount = backtest.tradeCount ?? 0;
  const startDate = new Date(strategy.startDate + 'T00:00:00');
  const endDate = new Date(strategy.endDate + 'T00:00:00');
  const yearsDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365);

  const enoughTrades = tradeCount >= 30;
  const longEnough = yearsDiff >= 1;

  const passed = enoughTrades && longEnough;
  let detail = '';
  if (!enoughTrades && !longEnough) {
    detail = `交易${tradeCount}次（建议≥30），回测${yearsDiff.toFixed(1)}年（建议≥1年），统计可靠性不足`;
  } else if (!enoughTrades) {
    detail = `交易${tradeCount}次，建议至少30次交易以保证统计意义`;
  } else if (!longEnough) {
    detail = `回测仅${yearsDiff.toFixed(1)}年，建议至少覆盖1年以包含不同市场环境`;
  } else {
    detail = `交易${tradeCount}次，回测${yearsDiff.toFixed(1)}年，统计可靠性良好`;
  }

  return {
    check: {
      name: '统计可靠性',
      passed,
      detail,
      severity: (!enoughTrades && !longEnough ? 'warning' : !enoughTrades || !longEnough ? 'warning' : 'info') as 'warning' | 'info',
    },
    penalty: !enoughTrades && !longEnough ? 15 : !enoughTrades || !longEnough ? 8 : 0,
  };
}

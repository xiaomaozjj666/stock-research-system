import type { StrategyConfig, DataQualityReport, BacktestResult, AuditReport, OptimizationReport, OHLCVData } from '../types.js';
import { dataEngineer } from './dataEngineer.js';
import { backtestAuditor } from './backtestAuditor.js';
import { strategyOptimizer } from './strategyOptimizer.js';

/**
 * 解析用户输入为策略配置
 * 支持自然语言描述（如"双均线交叉策略，5日和20日"）或结构化配置
 */
export function parseStrategyInput(input: string | StrategyConfig): StrategyConfig {
  if (typeof input !== 'string') return input;

  // 简单的自然语言解析
  const config: StrategyConfig = {
    name: '自定义策略',
    type: 'ma_cross',
    stockCode: '600519',
    params: { shortPeriod: 5, longPeriod: 20 },
    startDate: new Date(Date.now() - 365 * 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
  };

  // 识别策略类型
  if (input.includes('动量') || input.includes('momentum')) {
    config.type = 'momentum';
    config.params = { lookback: 20, buyThreshold: 5, sellThreshold: -3 };
    config.name = '动量策略';
  } else if (input.includes('均值回归') || input.includes('mean')) {
    config.type = 'mean_reversion';
    config.params = { maPeriod: 20, buyDeviation: -3, sellDeviation: 3 };
    config.name = '均值回归策略';
  } else if (input.includes('均线') || input.includes('ma') || input.includes('cross')) {
    config.type = 'ma_cross';
    config.name = '均线交叉策略';
    // 尝试提取参数
    const shortMatch = input.match(/(\d+)\s*[日天]?\s*(?:短|快速|short)/i) || input.match(/(?:短|快速).*?(\d+)/);
    const longMatch = input.match(/(\d+)\s*[日天]?\s*(?:长|慢速|long)/i) || input.match(/(?:长|慢速).*?(\d+)/);
    if (shortMatch) config.params.shortPeriod = parseInt(shortMatch[1]);
    if (longMatch) config.params.longPeriod = parseInt(longMatch[1]);
  }

  // 提取股票代码
  const codeMatch = input.match(/(\d{6})/);
  if (codeMatch) config.stockCode = codeMatch[1];

  return config;
}

/**
 * 编排流水线：按顺序调度3个子Agent
 */
export async function orchestrate(
  strategy: StrategyConfig,
  data: OHLCVData[],
  backtestResult: BacktestResult,
  onProgress?: (stage: string, percent: number) => void
): Promise<{ dataQuality: DataQualityReport; audit: AuditReport; optimization: OptimizationReport }> {

  // Step 1: 数据质量检查
  onProgress?.('data_check', 40);
  const dataQuality = dataEngineer(data);

  // Step 2: 回测审计
  onProgress?.('audit', 70);
  const audit = backtestAuditor(backtestResult, strategy);

  // Step 3: 策略优化
  onProgress?.('optimization', 90);
  const optimization = strategyOptimizer(backtestResult, audit, strategy);

  onProgress?.('complete', 100);

  return { dataQuality, audit, optimization };
}

/**
 * 生成综合摘要
 */
export function generateSummary(
  strategy: StrategyConfig,
  dataQuality: DataQualityReport,
  backtest: BacktestResult,
  audit: AuditReport,
  optimization: OptimizationReport
): string {
  const returnDesc = backtest.totalReturn > 0
    ? `正收益${backtest.totalReturn.toFixed(1)}%`
    : `亏损${Math.abs(backtest.totalReturn).toFixed(1)}%`;
  const riskDesc = audit.riskScore >= 70 ? '风险可控' : audit.riskScore >= 50 ? '存在一定风险' : '风险较高';
  const dataDesc = dataQuality.overallScore >= 80 ? '数据质量良好' : '数据存在质量问题';

  return `${strategy.name}在${strategy.stockCode}上的回测显示${returnDesc}，年化${backtest.annualizedReturn.toFixed(1)}%，夏普比率${backtest.sharpeRatio.toFixed(2)}，最大回撤${backtest.maxDrawdown.toFixed(1)}%。${dataDesc}（评分${dataQuality.overallScore}），回测${riskDesc}（审计评分${audit.riskScore}）。${optimization.suggestions.length > 0 ? `发现${optimization.suggestions.length}项优化建议。` : ''}`;
}

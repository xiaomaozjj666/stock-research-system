import type { StrategyConfig, QuantResearchReport } from './types.js';
import { fetchOHLCVData } from './dataProvider.js';
import { runBacktest } from './backtestEngine.js';
import { parseStrategyInput, orchestrate, generateSummary } from './agents/orchestrator.js';

/**
 * 量化研究完整流水线
 * 流程：解析输入 → 获取数据 → 执行回测 → 数据检查+审计+优化 → 整合报告
 */
export async function runQuantPipeline(
  userInput: string | StrategyConfig,
  onProgress?: (stage: string, percent: number) => void,
): Promise<QuantResearchReport> {
  // Step 1: 解析策略输入
  onProgress?.('parsing', 5);
  const strategy = parseStrategyInput(userInput);

  // Step 2: 获取历史数据
  onProgress?.('data_fetch', 15);
  const data = await fetchOHLCVData(strategy.stockCode, strategy.startDate, strategy.endDate);

  if (data.length < 30) {
    throw new Error(`历史数据不足（仅${data.length}条），请扩大时间范围`);
  }

  // Step 3: 执行回测
  onProgress?.('backtest', 30);
  const backtestResult = runBacktest(data, strategy);

  // Step 4: 数据检查 + 审计 + 优化（由orchestrator调度）
  const { dataQuality, audit, optimization } = await orchestrate(
    strategy,
    data,
    backtestResult,
    onProgress,
  );

  // Step 5: 生成综合摘要
  onProgress?.('summary', 95);
  const summary = generateSummary(strategy, dataQuality, backtestResult, audit, optimization);

  // Step 6: 整合完整报告
  const report: QuantResearchReport = {
    strategy,
    dataQuality,
    backtest: backtestResult,
    audit,
    optimization,
    summary,
    confidence: `基于${data.length}个交易日数据回测，策略类型：${strategy.type}，参数：${JSON.stringify(strategy.params)}。`,
    limitations:
      '本回测基于历史数据，不代表未来表现。未考虑市场流动性风险、极端行情、政策变化等因素。回测结果仅供参考，不构成投资建议。',
  };

  onProgress?.('complete', 100);
  return report;
}

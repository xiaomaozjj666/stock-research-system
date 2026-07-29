// 策略配置
export interface StrategyConfig {
  name: string;
  type: 'ma_cross' | 'momentum' | 'mean_reversion' | 'custom';
  stockCode: string;
  params: Record<string, number>;
  startDate: string;
  endDate: string;
  initialCapital?: number;
  commission?: number;
  slippage?: number;
}

// 回测结果
export interface BacktestResult {
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  tradeCount: number;
  profitFactor: number;
  equityCurve: { date: string; value: number }[];
  trades: { date: string; type: 'buy' | 'sell'; price: number; shares: number; commission: number; reason: string }[];
  benchmark: { date: string; value: number }[];
}

// 数据质量报告
export interface DataQualityReport {
  overallScore: number;
  totalRecords: number;
  missingDates: string[];
  outliers: { date: string; field: string; value: number; expected: string }[];
  duplicates: string[];
  issues: string[];
  suggestions: string[];
  dataRange: { start: string; end: string; tradingDays: number };
}

// 审计报告
export interface AuditReport {
  riskScore: number;
  futureFunctionRisk: 'low' | 'medium' | 'high';
  overfittingRisk: 'low' | 'medium' | 'high';
  survivorshipBias: 'low' | 'medium' | 'high';
  checks: { name: string; passed: boolean; detail: string; severity: 'info' | 'warning' | 'critical' }[];
  issues: string[];
  reliability: string;
}

// 优化报告
export interface OptimizationReport {
  performanceScore: number;
  suggestions: { category: string; title: string; detail: string; impact: 'high' | 'medium' | 'low' }[];
  parameterSensitivity: { param: string; currentValue: number; suggestedRange: { min: number; max: number; optimal: number }; sensitivity: string }[];
  riskMetrics: { var95: number; maxConsecutiveLoss: number; avgHoldingDays: number };
  iterationDirections: string[];
}

// 完整报告
export interface QuantResearchReport {
  strategy: StrategyConfig;
  dataQuality: DataQualityReport;
  backtest: BacktestResult;
  audit: AuditReport;
  optimization: OptimizationReport;
  summary: string;
  confidence: string;
  limitations: string;
}

// 进度阶段
export type PipelineStage = 'fetch' | 'quality' | 'backtest' | 'audit';

export interface PipelineState {
  stage: PipelineStage;
  status: 'waiting' | 'running' | 'done';
  elapsed?: number;
}

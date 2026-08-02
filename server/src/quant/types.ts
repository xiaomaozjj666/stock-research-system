// OHLCV 日K线数据
export interface OHLCVData {
  date: string;       // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isSimulated?: boolean;  // F1.6: 是否为模拟数据（API降级时标记）
}

// 策略配置
export interface StrategyConfig {
  name: string;
  type: 'ma_cross' | 'momentum' | 'mean_reversion' | 'custom';
  stockCode: string;
  params: Record<string, number>;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
  initialCapital?: number;  // 初始资金，默认100万
  commission?: number;      // 佣金率，默认万三
  slippage?: number;        // 滑点，默认0.1%
  /** 最新消息情绪叠加层（可选）：polarity ∈ [−1,1]，用于按新闻姿态缩放仓位 */
  newsOverlay?: { polarity: number };
}

// 交易记录
export interface Trade {
  date: string;
  type: 'buy' | 'sell';
  price: number;
  shares: number;
  commission: number;
  reason: string;
}

// 回测结果
export interface BacktestResult {
  totalReturn: number;        // 总收益率 %
  annualizedReturn: number;   // 年化收益率 %
  sharpeRatio: number;        // 夏普比率
  sortinoRatio?: number;      // 索提诺比率
  maxDrawdown: number;        // 最大回撤 %
  winRate: number;            // 胜率 %
  tradeCount: number;         // 交易次数
  profitFactor: number;       // 盈亏比
  equityCurve: { date: string; value: number }[];
  trades: Trade[];
  benchmark: { date: string; value: number }[];  // 基准（买入持有）曲线
  /** 是否应用了最新消息情绪叠加层 */
  newsAware?: boolean;
  /** 新闻姿态：posture = clamp(0.5 + 0.5·polarity, 0, 1)，用于仓位缩放 */
  newsPosture?: number;
}

// 数据质量报告
export interface DataQualityReport {
  overallScore: number;       // 0-100 质量评分
  totalRecords: number;
  missingDates: string[];     // 缺失的交易日
  outliers: { date: string; field: string; value: number; expected: string }[];
  duplicates: string[];       // 重复日期
  issues: string[];           // 问题描述列表
  suggestions: string[];      // 预处理建议
  dataRange: { start: string; end: string; tradingDays: number };
}

// 回测审计报告
export interface AuditReport {
  riskScore: number;          // 0-100 风险评分（越高越安全）
  futureFunctionRisk: 'low' | 'medium' | 'high';
  overfittingRisk: 'low' | 'medium' | 'high';
  survivorshipBias: 'low' | 'medium' | 'high';
  checks: {
    name: string;
    passed: boolean;
    detail: string;
    severity: 'info' | 'warning' | 'critical';
  }[];
  issues: string[];
  reliability: string;        // 可靠性评估文字
}

// 策略优化报告
export interface OptimizationReport {
  performanceScore: number;   // 0-100 性能评分
  suggestions: {
    category: 'parameter' | 'risk' | 'entry' | 'exit' | 'position';
    title: string;
    detail: string;
    impact: 'high' | 'medium' | 'low';
  }[];
  parameterSensitivity: {
    param: string;
    currentValue: number;
    suggestedRange: { min: number; max: number; optimal: number };
    sensitivity: 'high' | 'medium' | 'low';
  }[];
  riskMetrics: {
    var95: number;            // 95% VaR
    maxConsecutiveLoss: number;
    avgHoldingDays: number;
  };
  iterationDirections: string[];  // 迭代优化方向
}

// 流水线进度
export interface PipelineProgress {
  stage: string;
  percent: number;
  message: string;
}

// 完整量化研究报告
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

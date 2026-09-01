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
  /** 交易成本模型（可选）：'a_share' = A 股真实费率（佣金万2.5双边 + 印花税万5卖出单边 + 最低佣金5元） */
  costModel?: 'a_share';
}

// 最新消息单条
export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  publishedAt: string;
  source?: string;
  polarity?: number;
}

// 最新消息情绪信号
export interface NewsSignal {
  polarity: number;
  sentimentZ: number;
  bullishRatio: number;
  newsCount: number;
  freshness: number;
  weightedImpact: number;
  items: NewsItem[];
  hasNews: boolean;
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
  trades: {
    date: string;
    type: 'buy' | 'sell';
    price: number;
    shares: number;
    commission: number;
    reason: string;
  }[];
  benchmark: { date: string; value: number }[];
  newsAware?: boolean;
  newsPosture?: number;
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
  checks: {
    name: string;
    passed: boolean;
    detail: string;
    severity: 'info' | 'warning' | 'critical';
  }[];
  issues: string[];
  reliability: string;
}

// 优化报告
export interface OptimizationReport {
  performanceScore: number;
  suggestions: {
    category: string;
    title: string;
    detail: string;
    impact: 'high' | 'medium' | 'low';
  }[];
  parameterSensitivity: {
    param: string;
    currentValue: number;
    suggestedRange: { min: number; max: number; optimal: number };
    sensitivity: string;
  }[];
  riskMetrics: { var95: number; maxConsecutiveLoss: number; avgHoldingDays: number };
  iterationDirections: string[];
}

// 量价因子（A 股方向已校正）
export type PriceVolumeFactorName =
  | 'volatility_1m'
  | 'volatility_3m'
  | 'idiosyncratic_vol'
  | 'reversal_1m'
  | 'reversal_3m'
  | 'residual_momentum_6m'
  | 'momentum_12_1'
  | 'turnover_ratio_reversal'
  | 'amihud_illiquidity'
  | 'beta'
  | 'max_daily_return_1m';

export type FactorCategory =
  'volatility' | 'reversal' | 'momentum' | 'liquidity' | 'volume' | 'risk';

/** 单因子、单持有期的预测力（时间序列 IC） */
export interface FactorPredictabilityHorizon {
  /** Spearman 秩相关 IC ∈ [-1, 1] */
  ic: number;
  /** 经济方向 IC = ic × direction；>0 表示因子预期方向与真实收益一致 */
  effectiveIc: number;
  /** t 统计量 */
  tStat: number;
  /** Student t 双侧 p 值 */
  pValue: number;
  /** p < 0.05 视为统计显著 */
  significant: boolean;
  /** 有效样本数 */
  n: number;
}

export interface FactorPredictability {
  name: PriceVolumeFactorName;
  direction: 1 | -1;
  category: FactorCategory;
  /** 持有期（交易日）→ 预测力；样本不足时为 null */
  horizons: Record<number, FactorPredictabilityHorizon | null>;
  /** 是否有任一持有期达到统计显著 */
  hasSignal: boolean;
}

export interface PriceVolumeFactor {
  name: PriceVolumeFactorName;
  /** 当前快照值；数据不足时为 NaN（available=false） */
  value: number;
  /** +1 = 值越高预期收益越高；−1 = 值越低预期收益越高 */
  direction: 1 | -1;
  category: FactorCategory;
  /** 实证依据摘要 */
  evidence: string;
  /** 是否按 A 股实证做过方向翻转 */
  aShareAdjusted: boolean;
  /** 当前快照值是否可用（Number.isFinite） */
  available: boolean;
  /** 该因子对这只股票自身远期收益的时间序列预测力（21/63 交易日） */
  predictability?: FactorPredictability;
}

/** 组合方向 */
export type CompositeDirection = 'up' | 'down' | 'neutral';

/** 单因子对组合 alpha 的贡献（主导项） */
export interface CompositeContributor {
  name: PriceVolumeFactorName;
  /** 方向校正 IC（含符号） */
  effectiveIc: number;
  /** 置信度权重 = |tStat| */
  weight: number;
  /** 加权贡献 = w · effectiveIc */
  contribution: number;
}

/** 单持有期组合 alpha */
export interface CompositeAlphaHorizon {
  period: number;
  /** 组合方向性 alpha ∈ [-1, 1]，IC 置信度加权均值 */
  alpha: number;
  /** 综合方向：up / down / neutral */
  direction: CompositeDirection;
  /** 达到统计显著的因子数 */
  significantCount: number;
  /** 该持有期下有预测力的因子总数（非 null） */
  evaluableCount: number;
  /** 显著因子方向一致率 ∈ [0,1] */
  agreement: number;
  /** 主导贡献因子（最多 3 项） */
  topContributors: CompositeContributor[];
}

/** 跨持有期组合 alpha */
export interface CompositeAlpha {
  horizons: CompositeAlphaHorizon[];
  /** 任一持有期有显著信号 */
  hasSignal: boolean;
  /** 综合方向（跨持有期多数表决） */
  overallDirection: CompositeDirection;
}

// 完整报告
export interface QuantResearchReport {
  strategy: StrategyConfig;
  dataQuality: DataQualityReport;
  backtest: BacktestResult;
  backtestBaseline?: BacktestResult;
  newsSentiment?: NewsSignal;
  audit: AuditReport;
  optimization: OptimizationReport;
  summary: string;
  confidence: string;
  limitations: string;
  /** 量价因子快照值 + 时间序列预测力（IC/t/p/显著） */
  priceVolumeFactors?: PriceVolumeFactor[];
  /** 多因子加权组合 alpha（方向性信号 + 显著因子数 + 方向一致率） */
  compositeAlpha?: CompositeAlpha;
}

// 进度阶段
export type PipelineStage = 'fetch' | 'quality' | 'backtest' | 'audit';

export interface PipelineState {
  stage: PipelineStage;
  status: 'waiting' | 'running' | 'done';
  elapsed?: number;
}

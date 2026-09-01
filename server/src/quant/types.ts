// OHLCV 日K线数据
export interface OHLCVData {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isSimulated?: boolean; // F1.6: 是否为模拟数据（API降级时标记）
}

// 策略配置
export interface StrategyConfig {
  name: string;
  type: 'ma_cross' | 'momentum' | 'mean_reversion' | 'custom';
  stockCode: string;
  params: Record<string, number>;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  initialCapital?: number; // 初始资金，默认100万
  commission?: number; // 佣金率，默认万三
  slippage?: number; // 滑点，默认0.1%
  /**
   * 交易成本模型（可选）：
   * - 'a_share'：A 股真实费率（佣金万2.5双边 + 印花税万5卖出单边 + 最低佣金5元）；
   * - 未设置：按 commission/slippage 构造对称模型（历史行为）。
   */
  costModel?: 'a_share';
  /**
   * 最新消息情绪叠加层（可选）：
   * - polarity ∈ [−1,1]，聚合极性（展示/旧口径用）；
   * - since（YYYY-MM-DD）：旧口径下姿态自该日起常数生效；
   * - items（严格时序，推荐）：按条给出的 {发布日, 极性}。引擎对每个 bar 只使用
   *   发布日 ≤ bar 日期的新闻、按时效半衰期衰减加权——无未来信息、无前视偏差；
   *   items 存在时优先生效，缺失时退化为旧口径。
   */
  newsOverlay?: { polarity: number; since?: string; items?: NewsSentimentPoint[] };
  /**
   * 组合 alpha 信号叠加层（可选，opt-in）：把量价因子研究产出的方向性组合 alpha
   * 翻成建仓资金缩放系数（posture）。与 newsOverlay 并列、两者取较小值（AND 语义，
   * 任一看空都将压制仓位，避免两层信号相互叠加放大）。long-only 下看空 → posture=0
   * 不建仓（不可做空）。计算失败 / 无显著信号 / 综合方向 neutral 时不注入（降级为基线）。
   */
  factorOverlay?: FactorOverlay;
}

/**
 * 组合 alpha 信号叠加层：方向性组合 alpha 翻成建仓 posture ∈ [0,1]。
 * - direction：综合方向（up/down/neutral），来自 compositeAlpha.overallDirection；
 * - alpha：组合 alpha 数值（∈ [-1,1]），用于推导 posture 的卷积度；
 * - posture：可选显式 posture ∈ [0,1]；缺省由 direction/alpha 推导
 *   posture = clamp(0.5 + 0.5·alpha, 0, 1)（看多满仓、中性半仓、看空 0 空仓）。
 */
export interface FactorOverlay {
  direction: 'up' | 'down' | 'neutral';
  alpha: number;
  posture?: number;
}

/** 单点新闻情绪：发布日（YYYY-MM-DD 或 ISO datetime）+ 确定性极性 ∈ [−1,1] */
export interface NewsSentimentPoint {
  publishedAt: string;
  polarity: number;
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
  totalReturn: number; // 总收益率 %
  annualizedReturn: number; // 年化收益率 %
  sharpeRatio: number; // 夏普比率
  sortinoRatio?: number; // 索提诺比率
  maxDrawdown: number; // 最大回撤 %
  winRate: number; // 胜率 %
  tradeCount: number; // 交易次数
  profitFactor: number; // 盈亏比
  equityCurve: { date: string; value: number }[];
  trades: Trade[];
  benchmark: { date: string; value: number }[]; // 基准（买入持有）曲线
  /** 是否应用了最新消息情绪叠加层 */
  newsAware?: boolean;
  /** 新闻姿态：posture = clamp(0.5 + 0.5·polarity, 0, 1)，用于仓位缩放 */
  newsPosture?: number;
  /** 情绪叠加生效起始日期（YYYY-MM-DD）：仅该日期及之后的建仓按姿态缩放 */
  newsSince?: string;
  /** 是否应用了组合 alpha 信号叠加层（量价因子研究方向性信号 → 仓位缩放） */
  factorAware?: boolean;
  /** 组合 alpha 姿态：posture = clamp(0.5 + 0.5·alpha, 0, 1)，用于仓位缩放 */
  factorPosture?: number;
  /** 组合 alpha 综合方向（up/down/neutral），随报告透出便于审计 */
  factorDirection?: 'up' | 'down' | 'neutral';
}

// 数据质量报告
export interface DataQualityReport {
  overallScore: number; // 0-100 质量评分
  totalRecords: number;
  missingDates: string[]; // 缺失的交易日
  outliers: { date: string; field: string; value: number; expected: string }[];
  duplicates: string[]; // 重复日期
  issues: string[]; // 问题描述列表
  suggestions: string[]; // 预处理建议
  dataRange: { start: string; end: string; tradingDays: number };
}

// 回测审计报告
export interface AuditReport {
  riskScore: number; // 0-100 风险评分（越高越安全）
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
  reliability: string; // 可靠性评估文字
}

// 策略优化报告
export interface OptimizationReport {
  performanceScore: number; // 0-100 性能评分
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
    var95: number; // 95% VaR
    maxConsecutiveLoss: number;
    avgHoldingDays: number;
  };
  iterationDirections: string[]; // 迭代优化方向
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

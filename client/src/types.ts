/**
 * 前端共享类型定义
 * 与后端 server/src/types.ts 对齐，供 App 及各组件复用，消除重复定义。
 */

// 数据质量标记
export interface DataQualityFlags {
  estimatedFields?: string[];
  missingFields?: string[];
}

// 财务数据（多年）
export interface FinancialData {
  years: string[];
  revenue: number[];
  netProfit: number[];
  grossMargin: number[];
  netMargin: number[];
  roe: number[];
  operatingCashFlow: number[];
  eps: number[];
  totalAssets?: number[];
  totalLiabilities?: number[];
  equity?: number[];
  accountsReceivable?: number[];
  inventory?: number[];
  goodwill?: number[];
  debtRatio?: number[];
  capEx?: number[];
  dataQuality?: DataQualityFlags;
}

// 估值数据
export interface ValuationData {
  currentPrice: number;
  pe: number;
  pb: number;
  ps: number;
  marketCap: number;
  historicalPE: { year: string; pe: number; isEstimated?: boolean }[];
  peerComparison: {
    name: string;
    code: string;
    pe: number;
    pb: number;
    roe: number;
    marketCap: number;
  }[];
}

// 数据来源
export interface DataSource {
  name: string;
  description: string;
  confidence: number;
}

// 专家论点
export interface ExpertArgument {
  text: string;
  confidence: number;
  type: 'support' | 'oppose';
  evidenceType?: 'fact' | 'inference' | 'hypothesis';
}

// 专家观点
export interface ExpertOpinion {
  expert: string;
  arguments: ExpertArgument[];
  overallSentiment: 'bullish' | 'neutral' | 'bearish';
  confidence: number;
  keyPoints: string[];
}

// 争议点
export interface ControversyPoint {
  topic: string;
  bullishView: string;
  bearishView: string;
  arbitration: string;
  confidence: number;
}

// 评分详情
export interface ScoreDetail {
  profit_quality: number;
  growth: number;
  valuation: number;
  industry_boom: number;
  risk_deduction: number;
}

// 情景分析结果
export interface ScenarioResult {
  name: '乐观' | '中性' | '悲观';
  probability: number;
  keyAssumptions: string[];
  targetPriceRange: { low: number; high: number };
  supportingArguments: { expert: string; text: string; confidence: number }[];
  preconditions: string[];
}

// 量化策略推荐
export interface StrategyRecommendation {
  strategyType: string;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalReturn: number;
  applicableMarket: string;
  fatalWeakness: string;
  backtestWarning: string;
  /** 含最新消息情绪叠加层的回测对比 */
  newsAware?: {
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    posture: number;
  };
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
  polarity: number; // 加权极性 ∈ [−1,1]
  sentimentZ: number; // 情绪 z 分
  bullishRatio: number; // 看多占比 ∈ [0,1]
  newsCount: number; // 新闻条数
  freshness: number; // 新鲜度 ∈ (0,1]
  weightedImpact: number; // 影响强度 ∈ [0,1]
  items: NewsItem[]; // 按时效排序
  hasNews: boolean;
}

// 自选股批量"含最新消息回测"结果行
export interface WatchlistNewsBacktestRow {
  code: string;
  name: string | null;
  newsSentiment: NewsSignal | null;
  strategyList: StrategyRecommendation[];
  bestStrategy?: {
    strategyType: string;
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    newsAware?: StrategyRecommendation['newsAware'];
  };
  simulatedKline: boolean;
  error?: string;
}

// 自选股批量"含最新消息回测"总报告
export interface WatchlistNewsBacktestReport {
  generatedAt: string;
  count: number;
  withNewsCount: number;
  results: WatchlistNewsBacktestRow[];
}

// 自选股异动预警（与 server/src/services/alerts.ts 对齐）
export interface WatchlistAlert {
  code: string;
  name: string | null;
  level: 'strong-bull' | 'strong-bear' | 'high-impact';
  polarity: number;
  weightedImpact: number;
  detail: string;
}

export interface WatchlistMonitorResult {
  generatedAt: string;
  monitored: number;
  alerts: WatchlistAlert[];
}

// 行情历史单点（与 server/src/types.ts PriceHistoryPoint 对齐）
export interface PricePoint {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 手
  isSimulated?: boolean;
}

// 单只股票的完整研究数据
export interface StockPoolItem {
  stock_code: string;
  stock_name: string;
  industry: string;
  core_summary: string;
  total_score: number;
  rating: string;
  score_detail: ScoreDetail;
  strengths: string[];
  risk_list: string[];
  controversy_points: ControversyPoint[];
  finance_metrics: FinancialData;
  valuation: ValuationData;
  valuation_level: string;
  expert_opinions: ExpertOpinion[];
  reflection_notes: string[];
  follow_up_indicators: string[];
  scenarios?: ScenarioResult[];
  strategyList?: StrategyRecommendation[];
  newsSentiment?: NewsSignal;
  /** 行情历史（日K线，用于走势图渲染；取数失败时为模拟数据） */
  priceHistory?: PricePoint[];
  /** 风险归因：风格因子暴露 + 系统/特异风险分解（可选） */
  riskAttribution?: {
    exposures: {
      size: number;
      value: number;
      momentum: number;
      profitability: number;
      leverage: number;
    };
    decomposition: {
      systematicVol: number;
      specificVol: number;
      totalVol: number;
      explainedRatio: number;
    };
  };
  /** 与上次分析的对比（记忆反思闭环，可选） */
  vs_previous?: {
    previous_date: string;
    previous_rating: string;
    previous_score: number;
    score_delta: number;
    rating_changed: boolean;
  };
}

// 完整分析结果
export interface AnalysisResult {
  stock_pool: StockPoolItem[];
  research_confidence: string;
  limitation_explain: string;
  data_sources?: DataSource[];
}

// === 研究历史记录 ===
// 与 server/src/services/historyService.ts 对齐
export interface HistorySummary {
  id: string;
  stockCode: string;
  stockName: string;
  createdAt: string;
  rating: string;
  totalScore: number;
  industry?: string;
}

export interface HistoryItem extends HistorySummary {
  result: AnalysisResult;
}

// === 模拟盘（paper trading）研究闭环 ===
// 与 server/src/quant/paperTrading.ts 对齐
export type PaperOrderSide = 'buy' | 'sell';
export type PaperOrderType = 'market' | 'limit';
export type PaperOrderStatus = 'pending' | 'filled' | 'expired' | 'rejected';

/** 持仓（单代码一档：最近一次买入日用于 T+1 校验） */
export interface PaperPosition {
  code: string;
  quantity: number; // 股数（100 整数倍）
  avgCost: number; // 摊薄成本（含买入佣金）
  buyDate: string; // 最近一次买入日期 YYYY-MM-DD
}

/** 订单（含成交/过期/拒绝的完整审计记录） */
export interface PaperOrder {
  id: string;
  code: string;
  side: PaperOrderSide;
  type: PaperOrderType;
  price?: number; // 限价单的申报价
  quantity: number; // 委托数量（已按整手取整）
  placedDate: string; // 下单日期 YYYY-MM-DD
  status: PaperOrderStatus;
  fillDate?: string;
  fillPrice?: number;
  filledQuantity?: number;
  commission?: number;
  stampDuty?: number; // 仅卖出产生
  rejectReason?: string;
}

/** 每日净值记录 */
export interface PaperEquityPoint {
  date: string; // YYYY-MM-DD
  value: number; // 现金 + 持仓市值
}

/** GET /api/paper/portfolio 响应 */
export interface PaperPortfolio {
  initialCapital: number;
  cash: number;
  currentDate: string | null;
  positions: PaperPosition[];
  orders: PaperOrder[]; // 最近 50 笔
  equity: PaperEquityPoint[];
}

/** 下单入参（POST /api/paper/order） */
export interface PaperOrderInput {
  code: string;
  side: PaperOrderSide;
  type: PaperOrderType;
  price?: number; // 限价单必填
  quantity: number; // 股数，自动向下取整到整手
  date?: string; // 可选：下单基准交易日
}

/** 账户绩效统计（GET /api/paper/stats） */
export interface PaperStats {
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number | null; // 累计收益率 %
  maxDrawdownPct: number | null; // 最大回撤 %
  sharpeRatio: number | null; // 年化夏普（净值点不足时为 null）
  totalDays: number; // 已结算交易天数（净值点数）
  dailyReturns: number[]; // 逐日收益率
}

// === 合规审计（与 server/src/services/auditLog.ts 对齐） ===
export type AuditCategory =
  'llm_call' | 'tool_call' | 'trade_signal' | 'data_access' | 'user_query' | 'system';

export type AuditRiskLevel = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** 审计条目 */
export interface AuditEntry {
  id: string;
  timestamp: number; // epoch 毫秒
  sessionId: string;
  userId?: string;
  action: string; // 如 "llm.chat" / "tool.run_analysis"
  category: AuditCategory;
  detail: string;
  riskLevel: AuditRiskLevel;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

/** 审计查询过滤条件（GET /api/audit query） */
export interface AuditQueryFilter {
  category?: AuditCategory | AuditCategory[];
  riskLevel?: AuditRiskLevel | AuditRiskLevel[];
  startTime?: number; // epoch 毫秒，含
  endTime?: number; // epoch 毫秒，含
  sessionId?: string;
}

// === 港美股财务估值（与 server/src/quant/intlDataProvider.ts 对齐） ===
export type IntlMarket = 'HK' | 'US';

/** 港美股基础财务估值快照 */
export interface IntlFundamentals {
  code: string;
  market: IntlMarket;
  name: string;
  pe: number;
  pb: number;
  marketCap: number; // 亿元（按本币计）
  revenue: number; // 亿元
  netIncome: number; // 亿元
  totalAssets: number; // 亿元
  totalLiabilities: number; // 亿元
  currency: string; // HK = HKD，US = USD
  dataSource: string;
}

/** 港美股财务估值获取结果（含降级标记） */
export interface IntlFundamentalsResult {
  fundamentals: IntlFundamentals | null;
  degraded: boolean;
  source: string;
  fetchedAt: string;
}

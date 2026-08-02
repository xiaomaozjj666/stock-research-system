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
  polarity: number;       // 加权极性 ∈ [−1,1]
  sentimentZ: number;     // 情绪 z 分
  bullishRatio: number;   // 看多占比 ∈ [0,1]
  newsCount: number;      // 新闻条数
  freshness: number;      // 新鲜度 ∈ (0,1]
  weightedImpact: number; // 影响强度 ∈ [0,1]
  items: NewsItem[];      // 按时效排序
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
}

// 完整分析结果
export interface AnalysisResult {
  stock_pool: StockPoolItem[];
  research_confidence: string;
  limitation_explain: string;
  data_sources?: DataSource[];
}

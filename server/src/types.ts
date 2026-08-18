// 股票基本信息
export interface StockInfo {
  code: string;
  name: string;
  industry: string;
  market: string;
  listingDate: string;
  description: string;
}

// 最新消息情绪信号（来自 quant/newsSignal）
import type { NewsSignal, NewsItem } from './quant/newsSignal.js';
export type { NewsSignal, NewsItem };

// 数据质量标记
export interface DataQualityFlags {
  estimatedFields: string[]; // 估算字段列表
  missingFields: string[]; // 缺失字段列表
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
  totalAssets: number[];
  totalLiabilities: number[];
  equity: number[];
  accountsReceivable: number[];
  inventory: number[];
  goodwill: number[];
  debtRatio: number[];
  capEx?: number[]; // 资本支出（亿元），可选字段
  dataQuality?: DataQualityFlags; // 数据质量标记
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

// 个股完整数据集合（由 dataService.getData 组装，供分析流水线使用）
export interface StockDataSet {
  info: StockInfo;
  financial: FinancialData;
  valuation: ValuationData;
}

// 专家观点
export interface ExpertOpinion {
  expert: string;
  arguments: {
    text: string;
    confidence: number;
    type: 'support' | 'oppose';
    evidenceType: 'fact' | 'inference' | 'hypothesis';
  }[];
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

// 图表配置
export interface ChartConfig {
  type: string;
  title: string;
  config: Record<string, unknown>;
}

// 情景分析结果
export interface ScenarioResult {
  name: '乐观' | '中性' | '悲观';
  probability: number; // 0-1
  keyAssumptions: string[];
  targetPriceRange: { low: number; high: number };
  supportingArguments: { expert: string; text: string; confidence: number }[];
  preconditions: string[]; // 前置条件
}

// 量化策略推荐
export interface StrategyRecommendation {
  strategyType: string; // '均线交叉' | '动量策略' | '均值回归'
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalReturn: number;
  applicableMarket: string; // 适用行情描述
  fatalWeakness: string; // 致命弱点
  backtestWarning: string; // 回测风险提醒
  newsAware?: {
    // 含最新消息情绪叠加层的回测对比
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    posture: number;
  };
}

// 行业轮动信号（来自 quant/sectorRotation，附行业 beta 曝光参考）
export interface SectorRotationSignal {
  sector: string;
  compositeScore: number;
  rank: number;
  recommendation: 'overweight' | 'neutral' | 'underweight';
  prosperity: number;
  trend: number;
  crowding: number;
  /** 行业 beta（杠杆代理估算，非回归结果，仅供 beta 曝光参考） */
  industryBeta: number;
  summary: string;
  date: string;
}

// 自选股批量"含最新消息回测"结果行
export interface WatchlistNewsBacktestRow {
  code: string;
  name: string | null;
  /** 最新消息情绪信号（无新闻为 null） */
  newsSentiment: NewsSignal | null;
  /** 3 种策略的推荐（含 newsAware 对比，仅当有新闻时存在） */
  strategyList: StrategyRecommendation[];
  /** 按夏普排序取最优策略的摘要（便于表格直接展示） */
  bestStrategy?: {
    strategyType: string;
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    newsAware?: StrategyRecommendation['newsAware'];
  };
  /** 该只是否使用了模拟 K 线（网络不可达时的降级） */
  simulatedKline: boolean;
  /** 处理该只时的错误信息（如取数失败） */
  error?: string;
}

// 自选股批量"含最新消息回测"总报告
export interface WatchlistNewsBacktestReport {
  generatedAt: string;
  /** 参与回测的代码数 */
  count: number;
  /** 其中命中最新消息的代码数 */
  withNewsCount: number;
  results: WatchlistNewsBacktestRow[];
}

// 完整分析结果
export interface AnalysisResult {
  stock_pool: {
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
    chart_list: ChartConfig[];
    follow_up_indicators: string[];
    scenarios?: ScenarioResult[];
    strategyList?: StrategyRecommendation[];
    newsSentiment?: NewsSignal; // 最新消息情绪信号
    /** 知识图谱增强上下文（可选；由 analysisPipeline 从个股与同业可比数据构建） */
    knowledgeGraphContext?: string;
    /** 行业轮动信号（可选；股票有行业归属时附加） */
    sectorRotation?: SectorRotationSignal;
    /** 风险归因（可选；风格因子暴露 + 系统/特异风险分解，借鉴 GS Quant RiskModel 轻量版） */
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
    /** MCP 外部工具上下文（可选；仅配置 MCP_SERVER_URL 时附加） */
    mcpContext?: { serverUrl: string; toolCount: number; tools: string[] };
  }[];
  data_sources: DataSource[];
  research_confidence: string;
  limitation_explain: string;
}

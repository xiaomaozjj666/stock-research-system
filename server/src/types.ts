// 股票基本信息
export interface StockInfo {
  code: string;
  name: string;
  industry: string;
  market: string;
  listingDate: string;
  description: string;
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
}

// 估值数据
export interface ValuationData {
  currentPrice: number;
  pe: number;
  pb: number;
  ps: number;
  marketCap: number;
  historicalPE: { year: string; pe: number }[];
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

// 专家观点
export interface ExpertOpinion {
  expert: string;
  arguments: { text: string; confidence: number; type: 'support' | 'oppose' }[];
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
  }[];
  data_sources: DataSource[];
  research_confidence: string;
  limitation_explain: string;
}

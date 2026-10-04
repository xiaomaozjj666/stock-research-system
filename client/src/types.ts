/**
 * 前端共享类型定义
 *
 * 与后端 server/src/types.ts 对齐，供 App 及各组件复用，消除重复定义。
 *
 * 2026-10-05 起：本文件里**描述服务端响应**的类型一律改为从 `./api/generated`
 * re-export，不再手写第二份。手写副本会与契约分叉 —— 实测抓出过 chart_list 必填性、
 * IntlFundamentals 缺 4 个必填字段、DataQualityFlags 必填性等十余处不一致。
 *
 * 仍在本文件手写的是**前端自有模型**（如 DataQualityFlags 的语义说明，以及
 * pages/quant/types.ts 里的页面展示模型），它们不属于 API 契约。
 */

// ---- 契约生成类型（唯一来源：services/openapi.ts → scripts/generate-api-types.mts）----
//
// 分两段写，是因为二者语义不同，缺一不可：
//   · `import type` —— 让本文件内部（下面那些仍手写的前端自有模型）能**引用**这些名字；
//   · `export type { … } from` —— 把它们**导出**给全项目使用，保持本文件原有的公共面。
// 只写后者是不够的：`export … from` 只做转发，不把名字引入本模块作用域，
// 本文件内部引用 NewsSignal / StrategyRecommendation 会报 TS2304。
import type {
  CompareResponse,
  FinancialData,
  ValuationData,
  DataSource,
  ExpertOpinion,
  ScenarioResult,
  StrategyRecommendation,
  NewsSignal,
  WatchlistNewsBacktestReport,
  WatchlistAlert,
  WatchlistMonitorResult,
  StockPoolItem,
  AnalysisResult,
  HistorySummary,
  HistoryItem,
  PaperPosition,
  PaperOrder,
  PaperEquityPoint,
  PaperPortfolio,
  PaperStats,
  AuditEntry,
  IntlFundamentals,
  IntlFundamentalsResult,
  ConsensusSnapshot,
} from './api/generated';

// 保持既有公共面：全项目此前从 '../types' 导入这些名字，改成 import 后必须原样再导出，
// 否则 40+ 个引用点会一起断（而且断得很难看出是这里引起的）。
export type {
  CompareResponse,
  FinancialData,
  ValuationData,
  DataSource,
  ExpertOpinion,
  ScenarioResult,
  StrategyRecommendation,
  NewsSignal,
  WatchlistNewsBacktestReport,
  WatchlistAlert,
  WatchlistMonitorResult,
  StockPoolItem,
  AnalysisResult,
  HistorySummary,
  HistoryItem,
  PaperPosition,
  PaperOrder,
  PaperEquityPoint,
  PaperPortfolio,
  PaperStats,
  AuditEntry,
  IntlFundamentals,
  IntlFundamentalsResult,
  ConsensusSnapshot,
};

// 数据质量标记（server/src/types.ts 的 DataQualityFlags：两个字段都是必填）
export interface DataQualityFlags {
  estimatedFields: string[];
  missingFields: string[];
}

// === 多股对比（POST /api/compare） ===
/** 单只标的的失败项：code 是股票代码，error 是服务端给出的可读中文（不含堆栈/上游 URL） */
export interface CompareFailure {
  code: string;
  error: string;
  /** 机器可读失败原因（如 DATA_UNAVAILABLE / LLM_QUEUE_TIMEOUT）；可缺省 */
  errorCode?: string;
}

/**
 * 对比响应：支持部分成功。
 * - stocks 只含成功项，顺序与请求一致；
 * - failures 为可选字段——服务端在"全部成功"时根本不返回该字段（与旧契约逐字兼容），
 *   因此消费方必须按 `failures ?? []` 处理，不能假定它一定存在。
 */

// 财务数据（多年）
// 字段与 server/src/types.ts 的 FinancialData 对齐：服务端无条件写入这些序列，
// 故此处不再标可选（此前把前 9 项设为必填、后 6 项设为可选，属防御性放宽，
// 会让「契约要求必填、前端以为可缺」的分叉长期存在）。

// 估值数据

// 数据来源

// 专家论点
export interface ExpertArgument {
  text: string;
  confidence: number;
  type: 'support' | 'oppose';
  evidenceType?: 'fact' | 'inference' | 'hypothesis';
}

// 专家观点

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

// 量化策略推荐

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

// 自选股异动预警（与 server/src/services/alerts.ts 对齐）

/**
 * 自选股异动监控结果。
 *
 * requested / skipped 由服务端 routes/watchlist.ts 的 monitor 路由无条件写入：
 * 单次上限 20 只，超出部分不报错而是**如实说明被跳过多少**（monitor 是定时/自治
 * 循环驱动的唯一预警通道，整体报错等于关掉预警）。此前前端类型漏了这两个字段。
 */

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

// 完整分析结果

// === 研究历史记录 ===
// 与 server/src/services/historyService.ts 对齐

// === 模拟盘（paper trading）研究闭环 ===
// 与 server/src/quant/paperTrading.ts 对齐
export type PaperOrderSide = 'buy' | 'sell';
export type PaperOrderType = 'market' | 'limit';
export type PaperOrderStatus = 'pending' | 'filled' | 'expired' | 'rejected';

/** 持仓（单代码一档：最近一次买入日用于 T+1 校验） */

/** 订单（含成交/过期/拒绝的完整审计记录） */

/** 每日净值记录 */

/** GET /api/paper/portfolio 响应 */

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

// === 合规审计（与 server/src/services/auditLog.ts 对齐） ===
export type AuditCategory =
  'llm_call' | 'tool_call' | 'trade_signal' | 'data_access' | 'user_query' | 'system';

export type AuditRiskLevel = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** 审计条目 */

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

/** 港美股财务估值获取结果（含降级标记） */

/** 机构一致预期快照（东财盈利预测 + 北向季度持股；无历史序列，不参与回测） */

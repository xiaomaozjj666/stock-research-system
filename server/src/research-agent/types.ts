/**
 * 多步研究 Agent 规划层 —— 核心数据模型
 * ------------------------------------------------------------------
 * AlphaSense 式四阶段编排（规划 -> 检索 -> 交叉验证 -> 结论编排）的
 * 领域类型定义。所有阶段共享同一套不可变事实：计划(ResearchPlan)、
 * 证据(Evidence)、验证结论(Verification)，编排器据此做迭代与终止决策。
 *
 * 设计原则：
 * 1. 每条证据必须携带来源(SourceRef)与获取路径(AcquisitionPath)，可审计；
 * 2. 可信度 = 来源层级基准分 x 时效衰减，独立于 LLM 自评，避免循环论证；
 * 3. 计划可版本化修订(PlanRevision)，已验证证据永不被丢弃。
 */

// ---------------------------------------------------------------- 来源与可信度

export type SourceType =
  | 'regulatory_filing'
  | 'company_disclosure'
  | 'financial_database'
  | 'academic'
  | 'research_report'
  | 'news_media'
  | 'industry_data'
  | 'internal_doc'
  | 'blog'
  | 'social_ugc'
  | 'unknown';

export interface SourceTierInfo {
  /** 来源层级：1 = 一手权威，4 = UGC/未知 */
  tier: 1 | 2 | 3 | 4;
  /** 该层级来源的可信度基准分（0-1） */
  baseCredibility: number;
  /** 中文名称，用于报告与提示词 */
  label: string;
}

/**
 * 来源层级表：冲突仲裁时按 tier 升序优先采信，
 * 同层级再比时效与交叉印证数。
 */
export const SOURCE_TIER: Record<SourceType, SourceTierInfo> = {
  regulatory_filing: { tier: 1, baseCredibility: 0.95, label: '监管备案' },
  company_disclosure: { tier: 1, baseCredibility: 0.92, label: '公司官方披露' },
  financial_database: { tier: 1, baseCredibility: 0.88, label: '金融数据库' },
  academic: { tier: 1, baseCredibility: 0.85, label: '学术文献' },
  internal_doc: { tier: 2, baseCredibility: 0.75, label: '内部资料' },
  research_report: { tier: 2, baseCredibility: 0.72, label: '研究机构报告' },
  news_media: { tier: 2, baseCredibility: 0.7, label: '权威媒体报道' },
  industry_data: { tier: 2, baseCredibility: 0.68, label: '行业数据平台' },
  blog: { tier: 3, baseCredibility: 0.45, label: '行业博客/聚合' },
  social_ugc: { tier: 4, baseCredibility: 0.3, label: '社交媒体/UGC' },
  unknown: { tier: 4, baseCredibility: 0.25, label: '未知来源' },
};

export interface SourceRef {
  type: SourceType;
  title: string;
  url?: string;
  publisher?: string;
  /** ISO 日期，用于时效衰减 */
  publishedAt?: string;
  /** 通过哪个检索适配器取得 */
  retrievedVia: string;
}

/** 证据获取路径：完整记录「第几轮、用什么查询词、经什么工具、第几次尝试」 */
export interface AcquisitionPath {
  round: number;
  query: string;
  /** 实际成功的适配器名称 */
  adapter: string;
  /** 该适配器内部尝试次数（1 = 首试即中） */
  attempt: number;
  /** 若经历了降级，记录首个失败适配器 */
  fallbackOf?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------- 证据

export interface Evidence {
  id: string;
  subQuestionId: string;
  /** 该证据支持的事实性陈述（抽取自原文） */
  claim: string;
  /** 原文关键摘录，保证可回溯 */
  quote: string;
  source: SourceRef;
  path: AcquisitionPath;
  /** 0-1，来源层级基准分 x 时效衰减 */
  credibility: number;
  retrievedAt: string;
}

// ---------------------------------------------------------------- 检索计划

export type SubQuestionPriority = 'P0' | 'P1' | 'P2';

export type SubQuestionStatus =
  'pending' | 'retrieving' | 'sufficient' | 'insufficient' | 'blocked';

export interface SubQuestion {
  id: string;
  question: string;
  priority: SubQuestionPriority;
  /** 检索关键词（含中英文变体），round 1 直接使用 */
  keywords: string[];
  /** 预期信息来源类型：既指导检索，也用于验证阶段的缺口判断 */
  expectedSources: SourceType[];
  /** 什么算「回答了这个子问题」，验证阶段的判据 */
  successCriteria: string;
  status: SubQuestionStatus;
  /** 已执行的补充检索次数（由验证不足触发） */
  supplementRoundsUsed: number;
  /** 验证阶段产出的补充检索方向，供下一轮检索消费 */
  supplementHints: string[];
  /** replan 新增的子问题来源于哪个旧子问题 */
  derivedFrom?: string;
}

export interface PlanRevision {
  version: number;
  round: number;
  reason: string;
  added: string[];
  removed: string[];
  adjusted: string[];
  at: string;
}

export interface ScopeConstraints {
  timeRange?: string;
  region?: string;
  industry?: string;
  language?: string;
  extraRequirements?: string[];
}

export interface ResearchPlan {
  id: string;
  originalQuestion: string;
  scope: ScopeConstraints;
  subQuestions: SubQuestion[];
  version: number;
  revisions: PlanRevision[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- 交叉验证

export type ConsistencyLevel = 'consistent' | 'partial_conflict' | 'contradictory' | 'insufficient';

export type ConflictDimension = 'numeric' | 'temporal' | 'causal' | 'factual' | 'caliber';

export type ConflictResolution = 'a_wins' | 'b_wins' | 'both_partially_true' | 'unresolved';

export interface EvidenceConflict {
  evidenceIds: [string, string];
  dimension: ConflictDimension;
  description: string;
  resolution: ConflictResolution;
  resolutionReason?: string;
}

export interface Verification {
  subQuestionId: string;
  consistency: ConsistencyLevel;
  /** 基于已验证证据的阶段性结论 */
  verdict: string;
  /** 0-1，LLM 自评与证据强度加权各占一半 */
  confidence: number;
  supportingEvidenceIds: string[];
  conflicts: EvidenceConflict[];
  /** 是否需要下一轮补充检索（受补充轮次上限约束） */
  needsSupplement: boolean;
  supplementHints: string[];
  checkedAt: string;
}

// ---------------------------------------------------------------- 研究报告

export type ConfidenceLabel = '高' | '中' | '低';

export interface ReportCitation {
  evidenceId: string;
  claim: string;
  sourceTitle: string;
  sourceType: SourceType;
  publisher?: string;
  publishedAt?: string;
  url?: string;
  path: AcquisitionPath;
}

export interface ReportSection {
  subQuestionId: string;
  question: string;
  conclusion: string;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  citations: ReportCitation[];
  conflictNotes: string[];
  /** consistent / partial_conflict / contradictory / insufficient / blocked */
  status: string;
}

export interface ReportMethodology {
  rounds: number;
  adaptersUsed: string[];
  evidenceCount: number;
  sourceCount: number;
  planVersions: number;
  conflictsFound: number;
}

export interface ResearchReport {
  title: string;
  executiveSummary: string;
  overallConfidence: number;
  confidenceLabel: ConfidenceLabel;
  sections: ReportSection[];
  methodology: ReportMethodology;
  conflicts: EvidenceConflict[];
  /** 明确声明：哪些子问题证据不足/检索失败/未能验证 */
  limitations: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------- 运行状态与事件

export type StopReason = 'all_p0_sufficient' | 'max_rounds' | 'no_progress' | 'no_pending_work';

export interface RunStats {
  rounds: number;
  totalRetrievalTasks: number;
  succeededTasks: number;
  failedTasks: number;
  fallbacksUsed: number;
  evidenceCount: number;
  conflictsFound: number;
  supplementRounds: number;
  planVersions: number;
  startedAt: string;
  finishedAt?: string;
  stopReason?: StopReason;
}

export type AgentEventType =
  | 'run_started'
  | 'plan_created'
  | 'plan_revised'
  | 'replan_triggered'
  | 'retrieval_started'
  | 'retrieval_succeeded'
  | 'retrieval_failed'
  | 'retrieval_fallback'
  | 'evidence_extracted'
  | 'verification_completed'
  | 'supplement_triggered'
  | 'synthesis_started'
  | 'synthesis_completed'
  | 'run_finished'
  | 'run_error';

export interface AgentEvent {
  /** 单调递增序号，可用于 UI 排序 */
  seq: number;
  type: AgentEventType;
  round: number;
  at: string;
  message: string;
  data?: Record<string, unknown>;
}

/** 各阶段向编排器回报中间执行状态的回调 */
export type AgentEventEmitter = (
  type: AgentEventType,
  message: string,
  data?: Record<string, unknown>,
) => void;

// ---------------------------------------------------------------- 配置

export interface ResearchConfig {
  /** 最大编排轮数（1 轮 = 检索 + 验证一次） */
  maxRounds: number;
  /** 计划拆解的子问题上限 */
  maxSubQuestions: number;
  /** 每个子问题达到「证据充分」所需的最少独立证据条数 */
  minEvidencePerSubQuestion: number;
  /** 每个检索适配器的最大尝试次数（退避重试）；全次失败后降级到下一适配器 */
  maxRetrievalAttempts: number;
  /** 每个子问题允许的补充检索轮数上限 */
  maxSupplementRoundsPerSubQuestion: number;
  /** 每次检索取前 N 条结果 */
  resultsPerQuery: number;
  /** 每条检索结果最多抽取的证据条数 */
  maxDocsPerQuery: number;
  /** 连续 N 轮无新增证据则强制收敛 */
  noProgressRoundLimit: number;
  /** 子问题置信度低于该值视为需补充检索 */
  sufficiencyConfidence: number;
  /** 单轮最大检索任务数（成本护栏） */
  maxRetrievalTasksPerRound: number;
  /** 重试退避基础毫秒数（测试可注入 sleep 规避真实等待） */
  retryBackoffMs: number;
}

export const DEFAULT_CONFIG: ResearchConfig = {
  maxRounds: 3,
  maxSubQuestions: 8,
  minEvidencePerSubQuestion: 2,
  maxRetrievalAttempts: 3,
  maxSupplementRoundsPerSubQuestion: 2,
  resultsPerQuery: 5,
  maxDocsPerQuery: 3,
  noProgressRoundLimit: 2,
  sufficiencyConfidence: 0.65,
  maxRetrievalTasksPerRound: 12,
  retryBackoffMs: 800,
};

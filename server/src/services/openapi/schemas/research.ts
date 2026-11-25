/**
 * 深度研究（Deep Research）契约
 * ----------------------------------------------------------------------------
 * 字段逐条对齐 research-agent/types.ts 与 orchestrator 的 AgentRunResult。
 * 契约为前端的唯一类型来源：页面消费的每条证据、每个冲突、每条事件都从这里
 * 生成 TS 类型，避免「前端各写一份、字段慢慢分叉」。
 */

const sourceTypeEnum = [
  'regulatory_filing',
  'company_disclosure',
  'financial_database',
  'academic',
  'internal_doc',
  'research_report',
  'news_media',
  'industry_data',
  'blog',
  'social_ugc',
  'unknown',
];

/** 证据获取路径：哪一轮、用什么查询、走哪个适配器、第几次尝试、是否降级而来 */
const acquisitionPathSchema = {
  type: 'object',
  properties: {
    round: { type: 'integer', description: '第几轮检索' },
    query: { type: 'string', description: '实际使用的检索词' },
    adapter: { type: 'string', description: '命中的适配器（公告 / 新闻 / 知识库）' },
    attempt: { type: 'integer', description: '该适配器的第几次尝试（含退避重试）' },
    fallbackOf: { type: 'string', description: '降级来源适配器；主通道直接命中时缺省' },
    durationMs: { type: 'number', description: '本次抓取耗时（毫秒）' },
  },
  required: ['round', 'query', 'adapter', 'attempt'],
};

const sourceRefSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: sourceTypeEnum, description: '来源类型（决定可信度基准分）' },
    title: { type: 'string' },
    url: { type: 'string', description: '原文地址或自定义协议（em-ann:// / em-news:// / kb://）' },
    publisher: { type: 'string' },
    publishedAt: { type: 'string' },
    retrievedVia: { type: 'string', description: '抓取时使用的适配器名' },
  },
  required: ['type', 'title', 'retrievedVia'],
};

const researchEvidenceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    subQuestionId: { type: 'string' },
    claim: { type: 'string', description: '从原文抽取的可引用陈述' },
    quote: { type: 'string', description: '支撑该陈述的原文片段（可逐字核验）' },
    source: { $ref: '#/components/schemas/ResearchSourceRef' },
    path: { $ref: '#/components/schemas/ResearchAcquisitionPath' },
    credibility: { type: 'number', description: '可信度 0-1（来源层级 × 时效衰减）' },
    retrievedAt: { type: 'string' },
  },
  required: [
    'id',
    'subQuestionId',
    'claim',
    'quote',
    'source',
    'path',
    'credibility',
    'retrievedAt',
  ],
};

const researchConflictSchema = {
  type: 'object',
  properties: {
    evidenceIds: {
      type: 'array',
      items: { type: 'string' },
      description: '冲突的两条证据 id',
    },
    dimension: {
      type: 'string',
      enum: ['numeric', 'temporal', 'causal', 'factual', 'caliber'],
      description: '冲突维度：数值 / 时点 / 因果 / 事实 / 口径',
    },
    description: { type: 'string' },
    resolution: {
      type: 'string',
      enum: ['a_wins', 'b_wins', 'both_partially_true', 'unresolved'],
    },
    resolutionReason: { type: 'string' },
  },
  required: ['evidenceIds', 'dimension', 'description', 'resolution'],
};

const researchVerificationSchema = {
  type: 'object',
  properties: {
    subQuestionId: { type: 'string' },
    consistency: {
      type: 'string',
      enum: ['consistent', 'partial_conflict', 'contradictory', 'insufficient'],
    },
    verdict: { type: 'string' },
    confidence: { type: 'number' },
    supportingEvidenceIds: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { $ref: '#/components/schemas/ResearchEvidenceConflict' } },
    needsSupplement: { type: 'boolean' },
    supplementHints: { type: 'array', items: { type: 'string' } },
    checkedAt: { type: 'string' },
  },
  required: [
    'subQuestionId',
    'consistency',
    'verdict',
    'confidence',
    'supportingEvidenceIds',
    'conflicts',
    'needsSupplement',
    'supplementHints',
    'checkedAt',
  ],
};

const researchCitationSchema = {
  type: 'object',
  properties: {
    evidenceId: { type: 'string' },
    claim: { type: 'string' },
    sourceTitle: { type: 'string' },
    sourceType: { type: 'string', enum: sourceTypeEnum },
    publisher: { type: 'string' },
    publishedAt: { type: 'string' },
    url: { type: 'string' },
    path: { $ref: '#/components/schemas/ResearchAcquisitionPath' },
  },
  required: ['evidenceId', 'claim', 'sourceTitle', 'sourceType', 'path'],
};

const researchReportSectionSchema = {
  type: 'object',
  properties: {
    subQuestionId: { type: 'string' },
    question: { type: 'string' },
    conclusion: { type: 'string' },
    confidence: { type: 'number' },
    confidenceLabel: { type: 'string', enum: ['高', '中', '低'] },
    citations: { type: 'array', items: { $ref: '#/components/schemas/ResearchReportCitation' } },
    conflictNotes: { type: 'array', items: { type: 'string' } },
    status: { type: 'string' },
  },
  required: [
    'subQuestionId',
    'question',
    'conclusion',
    'confidence',
    'confidenceLabel',
    'citations',
    'conflictNotes',
    'status',
  ],
};

const researchSubQuestionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    question: { type: 'string' },
    priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
    keywords: { type: 'array', items: { type: 'string' } },
    expectedSources: { type: 'array', items: { type: 'string', enum: sourceTypeEnum } },
    successCriteria: { type: 'string' },
    status: {
      type: 'string',
      enum: ['pending', 'retrieving', 'sufficient', 'insufficient', 'blocked'],
    },
    supplementRoundsUsed: { type: 'integer' },
    supplementHints: { type: 'array', items: { type: 'string' } },
    derivedFrom: { type: 'string' },
  },
  required: [
    'id',
    'question',
    'priority',
    'keywords',
    'expectedSources',
    'successCriteria',
    'status',
    'supplementRoundsUsed',
    'supplementHints',
  ],
};

const researchPlanRevisionSchema = {
  type: 'object',
  properties: {
    version: { type: 'integer' },
    round: { type: 'integer' },
    reason: { type: 'string' },
    added: { type: 'array', items: { type: 'string' } },
    removed: { type: 'array', items: { type: 'string' } },
    adjusted: { type: 'array', items: { type: 'string' } },
    at: { type: 'string' },
  },
  required: ['version', 'round', 'reason', 'added', 'removed', 'adjusted', 'at'],
};

const researchScopeSchema = {
  type: 'object',
  properties: {
    timeRange: { type: 'string', description: '时间范围，如「近 2 年」' },
    region: { type: 'string' },
    industry: { type: 'string' },
    language: { type: 'string' },
    extraRequirements: { type: 'array', items: { type: 'string' } },
  },
};

const researchPlanSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    originalQuestion: { type: 'string' },
    scope: { $ref: '#/components/schemas/ResearchScope' },
    subQuestions: { type: 'array', items: { $ref: '#/components/schemas/ResearchSubQuestion' } },
    version: { type: 'integer', description: '计划版本号（每轮重规划 +1）' },
    revisions: { type: 'array', items: { $ref: '#/components/schemas/ResearchPlanRevision' } },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: [
    'id',
    'originalQuestion',
    'scope',
    'subQuestions',
    'version',
    'revisions',
    'createdAt',
    'updatedAt',
  ],
};

const researchReportSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    executiveSummary: { type: 'string' },
    overallConfidence: { type: 'number' },
    confidenceLabel: { type: 'string', enum: ['高', '中', '低'] },
    sections: { type: 'array', items: { $ref: '#/components/schemas/ResearchReportSection' } },
    methodology: {
      type: 'object',
      properties: {
        rounds: { type: 'integer' },
        adaptersUsed: { type: 'array', items: { type: 'string' } },
        evidenceCount: { type: 'integer' },
        sourceCount: { type: 'integer' },
        planVersions: { type: 'integer' },
        conflictsFound: { type: 'integer' },
      },
      required: [
        'rounds',
        'adaptersUsed',
        'evidenceCount',
        'sourceCount',
        'planVersions',
        'conflictsFound',
      ],
    },
    conflicts: { type: 'array', items: { $ref: '#/components/schemas/ResearchEvidenceConflict' } },
    limitations: { type: 'array', items: { type: 'string' } },
    generatedAt: { type: 'string' },
  },
  required: [
    'title',
    'executiveSummary',
    'overallConfidence',
    'confidenceLabel',
    'sections',
    'methodology',
    'conflicts',
    'limitations',
    'generatedAt',
  ],
};

const researchAgentEventSchema = {
  type: 'object',
  properties: {
    seq: { type: 'integer', description: '单调递增序号，供 UI 排序' },
    type: {
      type: 'string',
      enum: [
        'run_started',
        'plan_created',
        'plan_revised',
        'replan_triggered',
        'retrieval_started',
        'retrieval_succeeded',
        'retrieval_failed',
        'retrieval_fallback',
        'evidence_extracted',
        'verification_completed',
        'supplement_triggered',
        'synthesis_started',
        'synthesis_completed',
        'run_finished',
        'run_error',
      ],
    },
    round: { type: 'integer' },
    at: { type: 'string' },
    message: { type: 'string' },
    data: { type: 'object', description: '事件附加数据（子问题 id、查询词、条数等）' },
  },
  required: ['seq', 'type', 'round', 'at', 'message'],
};

const researchRunStatsSchema = {
  type: 'object',
  properties: {
    rounds: { type: 'integer' },
    totalRetrievalTasks: { type: 'integer' },
    succeededTasks: { type: 'integer' },
    failedTasks: { type: 'integer' },
    fallbacksUsed: { type: 'integer' },
    evidenceCount: { type: 'integer' },
    conflictsFound: { type: 'integer' },
    supplementRounds: { type: 'integer' },
    planVersions: { type: 'integer' },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
    stopReason: {
      type: 'string',
      enum: ['all_p0_sufficient', 'max_rounds', 'no_progress', 'no_pending_work'],
    },
  },
  required: [
    'rounds',
    'totalRetrievalTasks',
    'succeededTasks',
    'failedTasks',
    'fallbacksUsed',
    'evidenceCount',
    'conflictsFound',
    'supplementRounds',
    'planVersions',
    'startedAt',
  ],
};

const researchRunResultSchema = {
  type: 'object',
  properties: {
    report: { $ref: '#/components/schemas/ResearchReport' },
    reportMarkdown: { type: 'string', description: 'Markdown 渲染版（可直接导出）' },
    plan: { $ref: '#/components/schemas/ResearchPlan' },
    evidence: { type: 'array', items: { $ref: '#/components/schemas/ResearchEvidence' } },
    verifications: {
      type: 'array',
      items: { $ref: '#/components/schemas/ResearchVerification' },
    },
    events: { type: 'array', items: { $ref: '#/components/schemas/ResearchAgentEvent' } },
    stats: { $ref: '#/components/schemas/ResearchRunStats' },
  },
  required: ['report', 'reportMarkdown', 'plan', 'evidence', 'verifications', 'events', 'stats'],
};

const researchScopeInputSchema = {
  type: 'object',
  properties: {
    timeRange: { type: 'string', description: '时间范围（最长 100 字）' },
    region: { type: 'string', description: '地域（最长 100 字）' },
    industry: { type: 'string', description: '行业限定（最长 100 字）' },
    language: { type: 'string', description: '证据语言偏好（最长 100 字）' },
    extraRequirements: {
      type: 'array',
      items: { type: 'string' },
      description: '附加要求，最多 5 条、每条最长 200 字',
    },
  },
};

const researchConfigInputSchema = {
  type: 'object',
  properties: {
    maxRounds: { type: 'integer', minimum: 1, maximum: 4 },
    maxSubQuestions: { type: 'integer', minimum: 3, maximum: 10 },
    resultsPerQuery: { type: 'integer', minimum: 1, maximum: 10 },
    maxDocsPerQuery: { type: 'integer', minimum: 1, maximum: 5 },
  },
};

/** 研究库摘要：列表页字段，刻意不含报告正文（避免列表卡在一次完整报告的解析上） */
const researchRunSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '研究记录 id（小写字母/数字/连字符）' },
    question: { type: 'string', description: '原始研究问题' },
    createdAt: { type: 'string', description: '报告生成时间（ISO）' },
    title: { type: 'string', description: '报告标题' },
    overallConfidence: { type: 'number', description: '整体置信度 0-1' },
    confidenceLabel: { type: 'string', enum: ['高', '中', '低'] },
    rounds: { type: 'integer', description: '实际检索轮次' },
    evidenceCount: { type: 'integer' },
    sectionCount: { type: 'integer' },
    conflictCount: { type: 'integer' },
    stopReason: {
      type: 'string',
      enum: ['all_p0_sufficient', 'max_rounds', 'no_progress', 'no_pending_work'],
      description: '终止原因（早期记录可能缺省）',
    },
  },
  required: [
    'id',
    'question',
    'createdAt',
    'title',
    'overallConfidence',
    'confidenceLabel',
    'rounds',
    'evidenceCount',
    'sectionCount',
    'conflictCount',
  ],
};

/** 研究库单条完整记录 */
const savedResearchRunSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    question: { type: 'string' },
    scope: { $ref: '#/components/schemas/ResearchScope' },
    createdAt: { type: 'string' },
    result: { $ref: '#/components/schemas/ResearchRunResult' },
  },
  required: ['id', 'question', 'scope', 'createdAt', 'result'],
};

const researchRunListSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: '#/components/schemas/ResearchRunSummary' } },
  },
  required: ['items'],
};

/** 可续跑断点摘要：只暴露续跑入口需要的字段，不含计划/证据正文 */
const researchCheckpointSummarySchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', description: '续跑用的研究 id（小写字母/数字/连字符）' },
    question: { type: 'string', description: '原始研究问题' },
    createdAt: { type: 'string', description: '首次落断点时间（ISO）' },
    updatedAt: { type: 'string', description: '最近一次落断点时间（ISO）' },
    roundsCompleted: { type: 'integer', description: '已完成轮次（续跑从下一轮开始）' },
    evidenceCount: { type: 'integer', description: '断点中已落盘、续跑可复用的证据条数' },
  },
  required: ['runId', 'question', 'createdAt', 'updatedAt', 'roundsCompleted', 'evidenceCount'],
};

const researchCheckpointListSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { $ref: '#/components/schemas/ResearchCheckpointSummary' },
    },
  },
  required: ['items'],
};

export const researchSchemas = {
  ResearchSourceRef: sourceRefSchema,
  ResearchAcquisitionPath: acquisitionPathSchema,
  ResearchEvidence: researchEvidenceSchema,
  ResearchEvidenceConflict: researchConflictSchema,
  ResearchVerification: researchVerificationSchema,
  ResearchReportCitation: researchCitationSchema,
  ResearchReportSection: researchReportSectionSchema,
  ResearchSubQuestion: researchSubQuestionSchema,
  ResearchPlanRevision: researchPlanRevisionSchema,
  ResearchScope: researchScopeSchema,
  ResearchPlan: researchPlanSchema,
  ResearchReport: researchReportSchema,
  ResearchAgentEvent: researchAgentEventSchema,
  ResearchRunStats: researchRunStatsSchema,
  ResearchRunResult: researchRunResultSchema,
  ResearchScopeInput: researchScopeInputSchema,
  ResearchConfigInput: researchConfigInputSchema,
  ResearchRunSummary: researchRunSummarySchema,
  SavedResearchRun: savedResearchRunSchema,
  ResearchRunList: researchRunListSchema,
  ResearchCheckpointSummary: researchCheckpointSummarySchema,
  ResearchCheckpointList: researchCheckpointListSchema,
};

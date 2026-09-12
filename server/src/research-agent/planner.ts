/**
 * 阶段一：规划（Planner）
 * ------------------------------------------------------------------
 * 将用户研究问题拆解为子问题 + 检索关键词 + 预期来源 + 成功判据，
 * 形成可执行的检索计划（ResearchPlan）。
 *
 * 关键约束：
 * - P0 = 结论必需子问题，是终止条件的一部分，任何情况下不允许被 replan 丢弃；
 * - 关键词为空时回退为子问题文本，保证检索计划永远可执行；
 * - 计划版本化：replan 只增改，不删已验证证据，修订历史完整留痕。
 */
import type {
  AgentEventEmitter,
  ResearchPlan,
  ScopeConstraints,
  SourceType,
  SubQuestion,
  SubQuestionPriority,
} from './types.js';
import { DEFAULT_CONFIG, type ResearchConfig } from './types.js';
import type { LLMAdapter } from './llm.js';
import { completeJson } from './llm.js';
import { newId } from './utils.js';

const SOURCE_TYPE_VALUES: SourceType[] = [
  'regulatory_filing',
  'company_disclosure',
  'financial_database',
  'academic',
  'research_report',
  'news_media',
  'industry_data',
  'internal_doc',
  'blog',
  'social_ugc',
  'unknown',
];

const PRIORITY_VALUES: SubQuestionPriority[] = ['P0', 'P1', 'P2'];

// ---------------------------------------------------------------- Schema

interface SubQuestionDraft {
  question: string;
  priority: string;
  keywords: string[];
  expectedSources: string[];
  successCriteria: string;
  /** replan 新增子问题时可注明所替代的旧子问题 */
  derivedFrom?: string;
}

const SUB_QUESTION_DRAFT_SCHEMA = {
  type: 'object' as const,
  properties: {
    question: { type: 'string' as const },
    priority: { type: 'string' as const, enum: PRIORITY_VALUES },
    keywords: { type: 'array' as const, items: { type: 'string' as const } },
    expectedSources: { type: 'array' as const, items: { type: 'string' as const } },
    successCriteria: { type: 'string' as const },
  },
  required: ['question', 'priority', 'keywords'],
};

const PLAN_SCHEMA = {
  type: 'object' as const,
  properties: {
    subQuestions: {
      type: 'array' as const,
      items: SUB_QUESTION_DRAFT_SCHEMA,
      minItems: 1,
    },
  },
  required: ['subQuestions'],
};

interface PlanRevisionDraft {
  action: string;
  reason: string;
  add: SubQuestionDraft[];
  adjust: { id: string; keywords: string[]; reason: string }[];
  drop: { id: string; reason: string }[];
}

const REVISE_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: { type: 'string' as const, enum: ['adjust', 'no_change'] },
    reason: { type: 'string' as const },
    add: { type: 'array' as const, items: SUB_QUESTION_DRAFT_SCHEMA },
    adjust: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const },
          keywords: { type: 'array' as const, items: { type: 'string' as const } },
          reason: { type: 'string' as const },
        },
        required: ['id', 'reason'],
      },
    },
    drop: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const },
          reason: { type: 'string' as const },
        },
        required: ['id', 'reason'],
      },
    },
  },
  required: ['action', 'reason', 'add', 'adjust', 'drop'],
};

// ---------------------------------------------------------------- 提示词

function buildPlannerPrompt(
  question: string,
  scope: ScopeConstraints,
  config: ResearchConfig,
): string {
  const scopeLines = [
    scope.timeRange && `- 时间范围: ${scope.timeRange}`,
    scope.region && `- 地域: ${scope.region}`,
    scope.industry && `- 行业: ${scope.industry}`,
    scope.language && `- 语言: ${scope.language}`,
    ...(scope.extraRequirements ?? []).map((r) => `- 附加要求: ${r}`),
  ]
    .filter(Boolean)
    .join('\n');

  return [
    '你是研究规划专家。请把下面的研究问题拆解为可独立检索与验证的子问题，形成检索计划。',
    '',
    `研究问题: ${question}`,
    scopeLines ? `\n范围约束:\n${scopeLines}` : '',
    '',
    '拆解要求:',
    `1. 子问题数量 2~${config.maxSubQuestions} 个，覆盖"事实层(是什么)"与"判断层(意味着什么)"；`,
    '2. 每个子问题标注优先级: P0(结论必需) / P1(增强论证) / P2(锦上添花)，P0 至少 1 个；',
    '3. keywords 提供 3~6 个检索关键词，必须包含中英文变体与同义词；',
    `4. expectedSources 从以下类型中选择最可能出证据的 1~3 种: ${SOURCE_TYPE_VALUES.join(', ')}；`,
    '5. successCriteria 写清楚"看到什么样的证据就算回答了该子问题"；',
    '6. 只输出 JSON，结构: {"subQuestions":[{"question","priority","keywords","expectedSources","successCriteria"}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- 草稿归一化

function normalizeDraft(
  draft: SubQuestionDraft,
  fallbackQuestion: string,
  config: ResearchConfig,
): SubQuestion | null {
  const question = String(draft.question ?? '').trim();
  if (!question) return null;

  const keywords = (Array.isArray(draft.keywords) ? draft.keywords : [])
    .map((k) => String(k).trim())
    .filter(Boolean)
    .slice(0, 6);
  // 关键词为空时回退为子问题文本，保证计划永远可执行
  const finalKeywords = keywords.length > 0 ? keywords : [question || fallbackQuestion];

  const expectedSources = (Array.isArray(draft.expectedSources) ? draft.expectedSources : [])
    .map((s) => String(s).trim())
    .filter((s): s is SourceType => (SOURCE_TYPE_VALUES as string[]).includes(s))
    .slice(0, 3);

  const priority = (PRIORITY_VALUES as string[]).includes(draft.priority)
    ? (draft.priority as SubQuestionPriority)
    : 'P1';

  return {
    id: newId('SQ'),
    question,
    priority,
    keywords: finalKeywords,
    expectedSources: expectedSources.length > 0 ? expectedSources : ['news_media'],
    successCriteria: String(draft.successCriteria ?? '').trim() || '获得可交叉印证的相关证据',
    status: 'pending',
    supplementRoundsUsed: 0,
    supplementHints: [],
    derivedFrom:
      typeof draft.derivedFrom === 'string' && draft.derivedFrom.trim()
        ? draft.derivedFrom.trim()
        : undefined,
  };
}

const PRIORITY_ORDER: Record<SubQuestionPriority, number> = { P0: 0, P1: 1, P2: 2 };

// ---------------------------------------------------------------- 创建计划

export async function createPlan(
  llm: LLMAdapter,
  question: string,
  scope: ScopeConstraints,
  config: ResearchConfig,
  emit: AgentEventEmitter,
): Promise<ResearchPlan> {
  const now = new Date().toISOString();
  const result = await completeJson<{ subQuestions: SubQuestionDraft[] }>(llm, {
    prompt: buildPlannerPrompt(question, scope, config),
    schema: PLAN_SCHEMA,
    label: '研究计划拆解',
    system: '你是严谨的研究助理，只输出符合要求的 JSON，不要输出任何解释性文字。',
  });

  const seen = new Set<string>();
  const subQuestions: SubQuestion[] = [];
  for (const draft of result.subQuestions) {
    const sq = normalizeDraft(draft, question, config);
    if (!sq || seen.has(sq.question)) continue;
    seen.add(sq.question);
    subQuestions.push(sq);
    if (subQuestions.length >= config.maxSubQuestions) break;
  }
  if (subQuestions.length === 0) {
    // 兜底：LLM 完全不可用时，把原问题作为唯一 P0 子问题
    subQuestions.push(
      normalizeDraft(
        {
          question,
          priority: 'P0',
          keywords: [question],
          expectedSources: ['news_media'],
          successCriteria: '获得可交叉印证的相关证据',
        },
        question,
        config,
      )!,
    );
  }
  // 确定性护栏：计划必须含至少一个 P0，否则 all_p0_sufficient 收敛门永远无法触发
  if (!subQuestions.some((sq) => sq.priority === 'P0')) {
    subQuestions[0]!.priority = 'P0';
  }
  subQuestions.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  emit('plan_created', `检索计划 v1: 拆解出 ${subQuestions.length} 个子问题`, {
    subQuestions: subQuestions.map((sq) => ({
      id: sq.id,
      question: sq.question,
      priority: sq.priority,
    })),
  });

  return {
    id: newId('PLAN'),
    originalQuestion: question,
    scope,
    subQuestions,
    version: 1,
    revisions: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------- 计划修订（动态调整）

export interface ReplanProblem {
  kind: 'retrieval_failed' | 'persistently_insufficient' | 'blocked';
  subQuestionId: string;
  detail: string;
}

/**
 * 基于上一轮暴露的问题（检索失败 / 持续证据不足）请求 LLM 修订计划。
 * 确定性护栏：P0 不可丢弃；子问题总数不超过上限；版本号递增并留痕。
 * 返回 null 表示无可执行修订（LLM 认为 no_change 或输出均为无效项）。
 */
export async function revisePlan(
  llm: LLMAdapter,
  plan: ResearchPlan,
  problems: ReplanProblem[],
  round: number,
  config: ResearchConfig,
  emit: AgentEventEmitter,
): Promise<ResearchPlan | null> {
  const byId = new Map(plan.subQuestions.map((sq) => [sq.id, sq]));
  const problemText = problems
    .map((p) => {
      const sq = byId.get(p.subQuestionId);
      return `- [${p.kind}] ${sq ? `"${sq.question}"(${p.subQuestionId})` : p.subQuestionId}: ${p.detail}`;
    })
    .join('\n');

  const result = await completeJson<PlanRevisionDraft>(llm, {
    prompt: [
      '你是检索计划修订专家。以下子问题在上一轮执行中出现问题，请决定如何调整检索计划：',
      problemText,
      '',
      '当前计划的所有子问题:',
      ...plan.subQuestions.map(
        (sq) => `- ${sq.id} [${sq.priority}] ${sq.question} | 关键词: ${sq.keywords.join(', ')}`,
      ),
      '',
      '修订规则:',
      `1. 可 add 新子问题（换渠道/换口径，可注明 derivedFrom 指向被替代的旧子问题 id），总数不超过 ${config.maxSubQuestions}；`,
      '2. 可 adjust 现有子问题的 keywords；',
      '3. 只允许 drop 非关键字问题（P1/P2），P0 必须保留，改用 add 换路径解决；',
      '4. 若现有计划已无改进空间，返回 action="no_change"。',
      '只输出 JSON: {"action","reason","add":[...],"adjust":[{"id","keywords","reason"}],"drop":[{"id","reason"}]}',
    ].join('\n'),
    schema: REVISE_SCHEMA,
    label: '检索计划修订',
    system: '你是严谨的研究助理，只输出符合要求的 JSON。',
  });

  if (result.action === 'no_change') {
    emit('replan_triggered', `计划修订评估完成: 无需调整（${result.reason}）`, { round });
    return null;
  }

  const added: string[] = [];
  const adjusted: string[] = [];
  const removed: string[] = [];

  // adjust：换关键词意味着换检索路径，重置补充轮次预算，否则已耗尽预算的
  // 子问题永远不可再执行，adjust 形同虚设
  for (const adj of result.adjust) {
    const sq = byId.get(adj.id);
    if (!sq) continue;
    const keywords = (adj.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
    if (keywords.length > 0) {
      sq.keywords = keywords.slice(0, 6);
      sq.status = 'pending';
      sq.supplementRoundsUsed = 0;
      sq.supplementHints = [];
      adjusted.push(sq.id);
    }
  }

  // drop：P0 保护
  for (const d of result.drop) {
    const sq = byId.get(d.id);
    if (!sq || sq.priority === 'P0') continue;
    plan.subQuestions = plan.subQuestions.filter((s) => s.id !== d.id);
    removed.push(sq.id);
  }

  // add：受总数上限与查重约束（不与现有子问题重复）
  for (const draft of result.add) {
    if (plan.subQuestions.length >= config.maxSubQuestions) break;
    const sq = normalizeDraft(draft, plan.originalQuestion, config);
    if (!sq) continue;
    const dup = plan.subQuestions.some(
      (s) => s.question.toLowerCase() === sq.question.toLowerCase(),
    );
    if (dup) continue;
    sq.derivedFrom =
      sq.derivedFrom ?? problems.find((p) => p.kind !== 'persistently_insufficient')?.subQuestionId;
    plan.subQuestions.push(sq);
    added.push(sq.id);
  }

  if (added.length === 0 && adjusted.length === 0 && removed.length === 0) return null;

  plan.version += 1;
  plan.updatedAt = new Date().toISOString();
  plan.revisions.push({
    version: plan.version,
    round,
    reason: result.reason,
    added,
    removed,
    adjusted,
    at: plan.updatedAt,
  });

  emit(
    'plan_revised',
    `检索计划修订为 v${plan.version}: 新增 ${added.length} / 调整 ${adjusted.length} / 移除 ${removed.length}`,
    {
      round,
      version: plan.version,
      reason: result.reason,
    },
  );
  return plan;
}

export { DEFAULT_CONFIG };

/**
 * 阶段三：交叉验证（Verifier）
 * ------------------------------------------------------------------
 * 对同一子问题的多源证据做一致性比对：
 * 1. 数量与独立性门槛：证据不足 minEvidence 条、或全部来自同一出版方，
 *    直接判 insufficient 并生成补充检索方向（不浪费 LLM 调用）；
 * 2. 一致性分析：LLM 对证据做两两比对，识别数值/时间/因果/事实/口径冲突，
 *    并给出仲裁（谁可信、为什么）；输出经过 Schema 门禁与 ID 合法性校验；
 * 3. 置信度 = 0.5 x LLM 自评 + 0.5 x 证据强度（可信度加权均值 x 交叉印证加成
 *    x 未决冲突惩罚），防止模型过度自信；
 * 4. 证据不足时产出确定性补充提示（未使用的预期来源类型、冲突维度建议），
 *    交由下一轮检索消费——这是「自动触发补充检索」的落点。
 */
import type {
  AgentEventEmitter,
  ConflictDimension,
  ConflictResolution,
  ConsistencyLevel,
  Evidence,
  EvidenceConflict,
  SubQuestion,
  Verification,
} from './types.js';
import { SOURCE_TIER } from './types.js';
import type { ResearchConfig } from './types.js';
import type { LLMAdapter } from './llm.js';
import { completeJson } from './llm.js';
import { clamp01, round2 } from './utils.js';

const CONSISTENCY_VALUES: ConsistencyLevel[] = [
  'consistent',
  'partial_conflict',
  'contradictory',
  'insufficient',
];

const DIMENSION_VALUES: ConflictDimension[] = [
  'numeric',
  'temporal',
  'causal',
  'factual',
  'caliber',
];

const RESOLUTION_VALUES: ConflictResolution[] = [
  'a_wins',
  'b_wins',
  'both_partially_true',
  'unresolved',
];

interface VerificationLLM {
  consistency: string;
  verdict: string;
  confidence: number;
  supportingEvidenceIds: string[];
  conflicts: {
    evidenceIds: string[];
    dimension: string;
    description: string;
    resolution: string;
    resolutionReason?: string;
  }[];
  supplementHints?: string[];
}

const VERIFICATION_SCHEMA = {
  type: 'object' as const,
  properties: {
    consistency: { type: 'string' as const, enum: CONSISTENCY_VALUES },
    verdict: { type: 'string' as const },
    confidence: { type: 'number' as const },
    supportingEvidenceIds: { type: 'array' as const, items: { type: 'string' as const } },
    conflicts: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          evidenceIds: { type: 'array' as const, items: { type: 'string' as const } },
          dimension: { type: 'string' as const, enum: DIMENSION_VALUES },
          description: { type: 'string' as const },
          resolution: { type: 'string' as const, enum: RESOLUTION_VALUES },
          resolutionReason: { type: 'string' as const },
        },
        required: ['evidenceIds', 'dimension', 'description', 'resolution'],
      },
    },
    supplementHints: { type: 'array' as const, items: { type: 'string' as const } },
  },
  required: ['consistency', 'verdict', 'confidence', 'supportingEvidenceIds', 'conflicts'],
};

/** 证据强度：可信度加权均值 x 交叉印证加成 x 未决冲突惩罚 */
export function computeEvidenceStrength(evidence: Evidence[], unresolvedConflicts: number): number {
  if (evidence.length === 0) return 0;
  const totalWeight = evidence.reduce((sum, e) => sum + e.credibility, 0);
  const weighted =
    evidence.reduce((sum, e) => sum + e.credibility * e.credibility, 0) / totalWeight;
  const distinctPublishers = new Set(
    evidence.map((e) => e.source.publisher ?? e.source.url ?? e.source.title),
  ).size;
  const corroborationBonus = Math.min(1.2, 1 + 0.1 * (distinctPublishers - 1));
  const conflictPenalty = unresolvedConflicts > 0 ? 0.85 : 1;
  return clamp01(weighted * corroborationBonus * conflictPenalty);
}

export function confidenceLabel(confidence: number): '高' | '中' | '低' {
  if (confidence >= 0.75) return '高';
  if (confidence >= 0.5) return '中';
  return '低';
}

/** 确定性补充检索提示：基于来源缺口与冲突维度，不依赖额外 LLM 调用 */
export function buildSupplementHints(
  sq: SubQuestion,
  evidence: Evidence[],
  conflicts: EvidenceConflict[],
  llmHints: string[] = [],
): string[] {
  const hints: string[] = [];
  const usedTypes = new Set(evidence.map((e) => e.source.type));
  for (const t of sq.expectedSources) {
    if (!usedTypes.has(t)) hints.push(`补充检索${SOURCE_TIER[t].label}类来源`);
  }
  if (conflicts.some((c) => c.dimension === 'numeric')) {
    hints.push('优先从监管备案/公司官方披露获取权威数值口径');
  }
  if (conflicts.some((c) => c.dimension === 'temporal')) {
    hints.push('补充最新时点的数据与表述以消除时间口径差');
  }
  if (conflicts.some((c) => c.resolution === 'unresolved')) {
    hints.push('寻找独立第三方来源对冲突陈述进行仲裁');
  }
  if (hints.length === 0) {
    hints.push(`换用关键词变体检索: ${(sq.keywords[1] ?? sq.question).slice(0, 30)}`);
  }
  for (const h of llmHints) {
    const text = String(h).trim();
    if (text && !hints.some((existing) => existing.includes(text))) hints.push(text);
  }
  return hints.slice(0, 5);
}

/**
 * 验证单个子问题。无证据时也会产出一条 insufficient 验证记录，
 * 保证编排器始终有完整的验证视图。
 */
export async function verifySubQuestion(
  llm: LLMAdapter,
  sq: SubQuestion,
  evidence: Evidence[],
  config: ResearchConfig,
  emit: AgentEventEmitter,
): Promise<Verification> {
  const now = new Date().toISOString();

  // ---- 门槛检查：证据数量与来源独立性 ----
  const publishers = new Set(
    evidence.map((e) => e.source.publisher ?? e.source.url ?? e.source.title),
  );
  if (evidence.length === 0) {
    return {
      subQuestionId: sq.id,
      consistency: 'insufficient',
      verdict: '未获得任何相关证据，无法形成结论。',
      confidence: 0,
      supportingEvidenceIds: [],
      conflicts: [],
      needsSupplement: true,
      supplementHints: buildSupplementHints(sq, [], []),
      checkedAt: now,
    };
  }
  if (evidence.length < config.minEvidencePerSubQuestion || publishers.size < 2) {
    const reason =
      evidence.length < config.minEvidencePerSubQuestion
        ? `证据仅 ${evidence.length} 条（要求 >= ${config.minEvidencePerSubQuestion}）`
        : '全部证据来自同一出版方，缺乏独立交叉印证';
    return {
      subQuestionId: sq.id,
      consistency: 'insufficient',
      verdict: `证据不足以交叉验证: ${reason}。`,
      confidence: round2(computeEvidenceStrength(evidence, 0) * 0.6),
      supportingEvidenceIds: evidence.map((e) => e.id),
      conflicts: [],
      needsSupplement: true,
      supplementHints: buildSupplementHints(sq, evidence, []),
      checkedAt: now,
    };
  }

  // ---- LLM 一致性分析 ----
  const evidenceLines = evidence
    .map(
      (e, i) =>
        `[${e.id}] (来源: ${SOURCE_TIER[e.source.type].label}${e.source.publisher ? `/${e.source.publisher}` : ''}${e.source.publishedAt ? `/${e.source.publishedAt.slice(0, 10)}` : ''}, 可信度 ${round2(e.credibility)}) ${e.claim}`,
    )
    .join('\n');

  const result = await completeJson<VerificationLLM>(llm, {
    prompt: [
      '你是证据交叉验证专家。对同一子问题的多条证据做一致性比对。',
      '',
      `子问题: ${sq.question}`,
      `成功判据: ${sq.successCriteria}`,
      '',
      '证据清单:',
      evidenceLines,
      '',
      '验证要求:',
      '1. consistency 取值: consistent(相互印证) / partial_conflict(部分出入) / contradictory(直接矛盾)；',
      '2. 逐条检查证据两两之间在数值/时间/因果/事实/口径维度是否冲突，冲突写入 conflicts（evidenceIds 填两条证据的 ID）；',
      '3. 对每处冲突给出仲裁: 比较来源层级、时效性与交叉印证情况，resolution 取 a_wins/b_wins/both_partially_true/unresolved，并说明理由；',
      '4. supportingEvidenceIds 列出你采信为结论依据的证据 ID；',
      '5. confidence 为 0~1 的置信度；verdict 用一两句话给出该子问题的阶段性结论；',
      `6. 若证据仍不足以支撑结论，在 supplementHints 中给出具体的补充检索方向（不超过 3 条）。`,
      '只输出 JSON。',
    ].join('\n'),
    schema: VERIFICATION_SCHEMA,
    label: `交叉验证[${sq.id}]`,
    system: '你是严谨的研究助理，只输出符合要求的 JSON。',
  });

  // ---- 后处理：ID 合法性校验 + 冲突结构化 ----
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const supporting = result.supportingEvidenceIds.filter((id) => evidenceById.has(id));
  if (supporting.length === 0) {
    // LLM 引用了不存在的证据或留空：回退为全部证据
    supporting.push(...evidence.map((e) => e.id));
  }

  const conflicts: EvidenceConflict[] = [];
  for (const c of result.conflicts) {
    const [a, b] = c.evidenceIds ?? [];
    if (!a || !b || !evidenceById.has(a) || !evidenceById.has(b) || a === b) continue;
    conflicts.push({
      evidenceIds: [a, b],
      dimension: (DIMENSION_VALUES as string[]).includes(c.dimension)
        ? (c.dimension as ConflictDimension)
        : 'factual',
      description: String(c.description ?? '').trim() || '证据表述存在出入',
      resolution: (RESOLUTION_VALUES as string[]).includes(c.resolution)
        ? (c.resolution as ConflictResolution)
        : 'unresolved',
      resolutionReason: c.resolutionReason,
    });
  }

  const unresolved = conflicts.filter((c) => c.resolution === 'unresolved').length;
  let consistency = (CONSISTENCY_VALUES as string[]).includes(result.consistency)
    ? (result.consistency as ConsistencyLevel)
    : 'partial_conflict';
  if (consistency !== 'insufficient' && conflicts.length > 0 && consistency === 'consistent') {
    consistency = 'partial_conflict';
  }

  // 置信度 = LLM 自评与证据强度各占一半
  const strength = computeEvidenceStrength(evidence, unresolved);
  const confidence = round2(clamp01(0.5 * clamp01(result.confidence) + 0.5 * strength));

  const needsSupplement =
    consistency === 'insufficient' || unresolved > 0 || confidence < config.sufficiencyConfidence;

  const hints = needsSupplement
    ? buildSupplementHints(sq, evidence, conflicts, result.supplementHints ?? [])
    : [];

  const verification: Verification = {
    subQuestionId: sq.id,
    consistency,
    verdict: String(result.verdict ?? '').trim() || '证据已收集，结论待定。',
    confidence,
    supportingEvidenceIds: supporting,
    conflicts,
    needsSupplement,
    supplementHints: hints,
    checkedAt: now,
  };

  emit(
    'verification_completed',
    `验证完成 [${sq.id}]: ${consistency} / 置信度 ${confidence}${needsSupplement ? '（需补充检索）' : ''}`,
    {
      subQuestionId: sq.id,
      consistency,
      confidence,
      conflicts: conflicts.length,
      needsSupplement,
    },
  );
  if (needsSupplement && hints.length > 0) {
    emit('supplement_triggered', `触发补充检索 [${sq.id}]: ${hints[0]}`, {
      subQuestionId: sq.id,
      hints,
    });
  }
  return verification;
}

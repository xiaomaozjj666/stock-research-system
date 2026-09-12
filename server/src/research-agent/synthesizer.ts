/**
 * 阶段四：结论编排（Synthesizer）
 * ------------------------------------------------------------------
 * 基于验证后的证据生成结构化研究报告：
 * 1. 每个报告分节对应一个子问题，结论必须挂接真实存在的证据 ID
 *    （引用完整性校验：LLM 编造的引用一律剔除，杜绝幻觉引用）；
 * 2. 置信度分级（高/中/低）沿用验证阶段的输出，总体置信度按
 *    P0 权重 1 / P1 权重 0.5 / P2 权重 0.25 加权；
 * 3. limitations 由确定性规则生成：insufficient / blocked 的子问题、
 *    检索彻底失败的任务、未决冲突，全部如实声明，不粉饰。
 */
import type {
  AgentEventEmitter,
  ConfidenceLabel,
  Evidence,
  ReportCitation,
  ResearchConfig,
  ResearchPlan,
  ResearchReport,
  ReportSection,
  SubQuestionPriority,
  Verification,
} from './types.js';
import type { LLMAdapter } from './llm.js';
import { completeJson } from './llm.js';
import type { FailedTask } from './retriever.js';
import { confidenceLabel } from './verifier.js';
import { round2 } from './utils.js';

interface SynthesisLLM {
  title: string;
  executiveSummary: string;
  sections: { subQuestionId: string; conclusion: string; keyEvidenceIds: string[] }[];
}

const SYNTHESIS_SCHEMA = {
  type: 'object' as const,
  properties: {
    title: { type: 'string' as const },
    executiveSummary: { type: 'string' as const },
    sections: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          subQuestionId: { type: 'string' as const },
          conclusion: { type: 'string' as const },
          keyEvidenceIds: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['subQuestionId', 'conclusion', 'keyEvidenceIds'],
      },
    },
  },
  required: ['title', 'executiveSummary', 'sections'],
};

const WEIGHT: Record<SubQuestionPriority, number> = { P0: 1, P1: 0.5, P2: 0.25 };

export async function synthesize(
  llm: LLMAdapter,
  plan: ResearchPlan,
  verifications: Map<string, Verification>,
  evidence: Evidence[],
  failedTasks: FailedTask[],
  config: ResearchConfig,
  emit: AgentEventEmitter,
): Promise<ResearchReport> {
  emit('synthesis_started', '开始编排结构化结论', {
    evidenceCount: evidence.length,
    subQuestions: plan.subQuestions.length,
  });

  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const verdictLines = plan.subQuestions
    .map((sq) => {
      const v = verifications.get(sq.id);
      if (!v) return `- [${sq.id}] (${sq.priority}) ${sq.question}: 未完成验证`;
      const cited =
        v.supportingEvidenceIds.length > 0
          ? ` / 采信证据: ${v.supportingEvidenceIds.join(', ')}`
          : '';
      return `- [${sq.id}] (${sq.priority}) ${sq.question}: ${v.consistency} / 置信度 ${v.confidence}${cited} / ${v.verdict}`;
    })
    .join('\n');

  const result = await completeJson<SynthesisLLM>(llm, {
    prompt: [
      '你是研究报告撰写专家。基于以下已验证的子问题结论，编排一份结构化研究报告的骨架。',
      '',
      `研究问题: ${plan.originalQuestion}`,
      '',
      '子问题验证结论:',
      verdictLines,
      '',
      '要求:',
      '1. title 概括研究主题；executiveSummary 汇总各 P0 子问题的结论（150 字以内）；',
      '2. 每个 section 对应一个 subQuestionId，conclusion 依据该子问题的验证结论撰写，不得引入验证结论之外的新事实；',
      '3. keyEvidenceIds 从该子问题验证结论采信的证据 ID 中选择关键依据（验证结论给出的范围），不得编造 ID；',
      '4. 结论措辞必须与置信度匹配：低置信度使用"初步显示/待进一步验证"等限定语。',
      '只输出 JSON。',
    ].join('\n'),
    schema: SYNTHESIS_SCHEMA,
    label: '结论编排',
    system: '你是严谨的研究助理，只输出符合要求的 JSON。',
  });

  // ---- 组装报告分节（引用完整性校验） ----
  const llmBySq = new Map(result.sections.map((s) => [s.subQuestionId, s]));
  const sections: ReportSection[] = [];
  const allConflicts: ResearchReport['conflicts'] = [];

  for (const sq of plan.subQuestions) {
    const v = verifications.get(sq.id);
    const drafted = llmBySq.get(sq.id);
    const status = v
      ? v.consistency === 'insufficient'
        ? sq.supplementRoundsUsed >= config.maxSupplementRoundsPerSubQuestion
          ? 'blocked'
          : 'insufficient'
        : v.consistency
      : 'not_verified';

    // 引用完整性：只允许真实存在的证据 ID 进入报告
    const citedIds = (drafted?.keyEvidenceIds ?? []).filter(
      (id) => evidenceById.has(id) && evidenceById.get(id)!.subQuestionId === sq.id,
    );
    const fallbackIds = v ? v.supportingEvidenceIds.filter((id) => evidenceById.has(id)) : [];
    const finalIds = citedIds.length > 0 ? citedIds : fallbackIds;

    const citations: ReportCitation[] = finalIds.map((id) => {
      const ev = evidenceById.get(id)!;
      return {
        evidenceId: ev.id,
        claim: ev.claim,
        sourceTitle: ev.source.title,
        sourceType: ev.source.type,
        publisher: ev.source.publisher,
        publishedAt: ev.source.publishedAt,
        url: ev.source.url,
        path: ev.path,
      };
    });

    const conflictNotes =
      v?.conflicts.map(
        (c) => `${c.description}（${c.resolution === 'unresolved' ? '未决' : '已仲裁'}）`,
      ) ?? [];
    if (v) allConflicts.push(...v.conflicts);

    sections.push({
      subQuestionId: sq.id,
      question: sq.question,
      conclusion: drafted?.conclusion ?? v?.verdict ?? '该子问题未能完成检索与验证，见局限性说明。',
      confidence: v?.confidence ?? 0,
      confidenceLabel: confidenceLabel(v?.confidence ?? 0),
      citations,
      conflictNotes,
      status,
    });
  }

  // ---- 总体置信度：按优先级加权 ----
  let weightSum = 0;
  let weightedSum = 0;
  for (const sq of plan.subQuestions) {
    const v = verifications.get(sq.id);
    if (!v) continue;
    const w = WEIGHT[sq.priority];
    weightSum += w;
    weightedSum += w * v.confidence;
  }
  const overallConfidence = weightSum > 0 ? round2(weightedSum / weightSum) : 0;

  // ---- 局限性：确定性规则生成，如实声明 ----
  const limitations: string[] = [];
  for (const section of sections) {
    if (section.status === 'insufficient') {
      limitations.push(
        `子问题「${section.question}」证据不足（置信度 ${section.confidence}），结论仅供参考。`,
      );
    } else if (section.status === 'blocked') {
      limitations.push(
        `子问题「${section.question}」经 ${config.maxSupplementRoundsPerSubQuestion} 轮补充检索仍未获得充分证据，视为受阻。`,
      );
    } else if (section.status === 'not_verified') {
      limitations.push(`子问题「${section.question}」未能完成验证。`);
    }
  }
  // 失败任务按（子问题 × 查询词）去重，避免多轮重复失败刷屏
  const seenFailures = new Set<string>();
  for (const task of failedTasks) {
    const key = `${task.subQuestionId}|${task.query}`;
    if (seenFailures.has(key)) continue;
    seenFailures.add(key);
    limitations.push(
      `检索任务失败: ${task.detail}（子问题 ${task.subQuestionId}，查询词"${task.query}"）。`,
    );
  }
  const unresolvedConflicts = allConflicts.filter((c) => c.resolution === 'unresolved');
  for (const c of unresolvedConflicts) {
    limitations.push(`存在未决证据冲突: ${c.description}`);
  }
  if (limitations.length === 0) {
    limitations.push('无重大局限；所有 P0 子问题均获得多源一致的证据支持。');
  }

  const adaptersUsed = [...new Set(evidence.map((e) => e.path.adapter))].filter(Boolean);
  const report: ResearchReport = {
    title: String(result.title ?? '').trim() || `研究报告: ${plan.originalQuestion}`,
    executiveSummary: String(result.executiveSummary ?? '').trim(),
    overallConfidence,
    confidenceLabel: confidenceLabel(overallConfidence),
    sections,
    methodology: {
      rounds: 0, // 由编排器回填
      adaptersUsed,
      evidenceCount: evidence.length,
      sourceCount: new Set(evidence.map((e) => e.source.url ?? e.source.title)).size,
      planVersions: plan.version,
      conflictsFound: allConflicts.length,
    },
    conflicts: allConflicts,
    limitations,
    generatedAt: new Date().toISOString(),
  };

  emit(
    'synthesis_completed',
    `结构化结论编排完成: ${sections.length} 个分节，总体置信度 ${overallConfidence}`,
    {
      sections: sections.length,
      overallConfidence,
    },
  );
  return report;
}

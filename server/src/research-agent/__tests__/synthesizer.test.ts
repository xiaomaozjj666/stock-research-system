/**
 * synthesizer 单元测试：字段兜底 / 引用完整性 / 冲突标注 / 局限性去重 /
 * 无 url 证据的来源计数 / 全未验证时的总体置信度
 */
import { describe, it, expect } from 'vitest';
import { synthesize } from '../synthesizer.js';
import type { LLMAdapter, LLMRequest } from '../llm.js';
import type {
  AgentEventEmitter,
  Evidence,
  EvidenceConflict,
  ResearchConfig,
  ResearchPlan,
  SubQuestion,
  Verification,
} from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const emit: AgentEventEmitter = () => {};
const config: ResearchConfig = { ...DEFAULT_CONFIG, maxSupplementRoundsPerSubQuestion: 2 };

const makeSq = (id: string, priority: SubQuestion['priority']): SubQuestion => ({
  id,
  question: `问题-${id}`,
  priority,
  keywords: ['k'],
  expectedSources: ['news_media'],
  successCriteria: 'x',
  status: 'pending',
  supplementRoundsUsed: 0,
  supplementHints: [],
});

const makePlan = (sqs: SubQuestion[]): ResearchPlan => ({
  id: 'PLAN-1',
  originalQuestion: '研究问题',
  scope: {},
  subQuestions: sqs,
  version: 2,
  revisions: [],
  createdAt: '',
  updatedAt: '',
});

const makeEv = (id: string, sqId: string, withUrl = true): Evidence => ({
  id,
  subQuestionId: sqId,
  claim: `陈述-${id}`,
  quote: '引文',
  source: {
    type: 'news_media',
    title: `来源-${id}`,
    ...(withUrl ? { url: `https://site.com/${id}` } : {}),
    retrievedVia: 'test',
  },
  path: { round: 1, query: 'q', adapter: 'test', attempt: 1 },
  credibility: 0.8,
  retrievedAt: new Date().toISOString(),
});

const makeVerification = (sqId: string, conflicts: EvidenceConflict[] = []): Verification => ({
  subQuestionId: sqId,
  consistency: 'consistent',
  verdict: `结论-${sqId}`,
  confidence: 0.8,
  supportingEvidenceIds: [],
  conflicts,
  needsSupplement: false,
  supplementHints: [],
  checkedAt: new Date().toISOString(),
});

describe('synthesize 结论编排兜底', () => {
  it('空 title/摘要兜底、跨子问题引用剔除、未决冲突标注、失败任务去重、无 url 来源计数', async () => {
    const p0 = makeSq('SQ-A', 'P0');
    const p2 = makeSq('SQ-B', 'P2');
    const evA1 = makeEv('EV-A1', 'SQ-A');
    const evA2 = makeEv('EV-A2', 'SQ-A', false); // 无 url
    const evB1 = makeEv('EV-B1', 'SQ-B');

    const llm: LLMAdapter = {
      name: 'scripted',
      async complete(_req: LLMRequest): Promise<string> {
        return JSON.stringify({
          title: '', // 空 → 兜底标题
          executiveSummary: '', // 空 → 渲染层占位
          sections: [
            {
              subQuestionId: 'SQ-A',
              conclusion: '结论A',
              keyEvidenceIds: ['EV-幻觉', 'EV-B1', 'EV-A1'], // 幻觉剔除 + 跨子问题剔除
            },
            // SQ-B 缺席 → conclusion 回退验证结论
          ],
        });
      },
    };

    const conflicts: EvidenceConflict[] = [
      {
        evidenceIds: ['EV-A1', 'EV-A2'],
        dimension: 'numeric',
        description: '数值不一致',
        resolution: 'unresolved',
      },
      {
        evidenceIds: ['EV-A1', 'EV-A2'],
        dimension: 'temporal',
        description: '时点不同',
        resolution: 'a_wins',
      },
    ];
    const verifications = new Map<string, Verification>([
      [
        'SQ-A',
        { ...makeVerification('SQ-A', conflicts), supportingEvidenceIds: ['EV-A1', 'EV-A2'] },
      ],
      ['SQ-B', makeVerification('SQ-B')],
    ]);

    const report = await synthesize(
      llm,
      makePlan([p0, p2]),
      verifications,
      [evA1, evA2, evB1],
      [
        { subQuestionId: 'SQ-B', query: '同词', adaptersTried: ['x'], detail: '失败' },
        { subQuestionId: 'SQ-B', query: '同词', adaptersTried: ['x'], detail: '失败' }, // 重复 → 去重
      ],
      config,
      emit,
    );

    expect(report.title).toBe('研究报告: 研究问题');
    const secA = report.sections.find((s) => s.subQuestionId === 'SQ-A')!;
    expect(secA.citations.map((c) => c.evidenceId)).toEqual(['EV-A1']); // 幻觉 + 跨子问题被剔除
    expect(secA.conflictNotes.some((n) => n.includes('未决'))).toBe(true);
    expect(secA.conflictNotes.some((n) => n.includes('已仲裁'))).toBe(true);
    const secB = report.sections.find((s) => s.subQuestionId === 'SQ-B')!;
    expect(secB.conclusion).toBe('结论-SQ-B'); // LLM 缺席 → 回退验证结论
    expect(report.conflicts).toHaveLength(2);
    // 同 (子问题×查询词) 失败去重
    expect(report.limitations.filter((l) => l.includes('检索任务失败'))).toHaveLength(1);
    expect(report.methodology.sourceCount).toBe(3); // 2 个 url + 1 个无 url 证据按 title 计数
    expect(report.methodology.planVersions).toBe(2);
    // P0 置信 0.8 权重 1 + P2 置信 0.8 权重 0.25 → 0.8
    expect(report.overallConfidence).toBe(0.8);
  });

  it('全部子问题未验证：总体置信度为 0，结论与局限性如实声明', async () => {
    const llm: LLMAdapter = {
      name: 'scripted',
      async complete(): Promise<string> {
        return JSON.stringify({ title: 'T', executiveSummary: 'S', sections: [] });
      },
    };
    const report = await synthesize(
      llm,
      makePlan([makeSq('SQ-A', 'P0')]),
      new Map(),
      [],
      [],
      config,
      emit,
    );
    expect(report.overallConfidence).toBe(0);
    expect(report.confidenceLabel).toBe('低');
    expect(report.sections[0]!.conclusion).toContain('未能完成检索与验证');
    expect(report.limitations.join('\n')).toContain('未能完成验证');
  });
});

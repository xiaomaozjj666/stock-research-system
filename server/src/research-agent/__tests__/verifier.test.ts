/**
 * verifier 单元测试：证据强度合成 / 补充提示生成 / 置信度分级 /
 * verifySubQuestion 对 LLM 非法输出的清洗兜底
 */
import { describe, it, expect } from 'vitest';
import {
  computeEvidenceStrength,
  buildSupplementHints,
  confidenceLabel,
  verifySubQuestion,
} from '../verifier.js';
import type { Evidence, EvidenceConflict, ResearchConfig, SubQuestion } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import type { LLMAdapter, LLMRequest } from '../llm.js';

const ev = (id: string, cred: number, publisher: string): Evidence => ({
  id,
  subQuestionId: 'SQ-x',
  claim: `c-${id}`,
  quote: 'q',
  source: { type: 'news_media', title: `t-${id}`, publisher, retrievedVia: 'test' },
  path: { round: 1, query: 'q', adapter: 'test', attempt: 1 },
  credibility: cred,
  retrievedAt: new Date().toISOString(),
});

const sq: SubQuestion = {
  id: 'SQ-x',
  question: '问题',
  priority: 'P0',
  keywords: ['k1', 'k2', 'k3'],
  expectedSources: ['company_disclosure'],
  successCriteria: 'x',
  status: 'insufficient',
  supplementRoundsUsed: 0,
  supplementHints: [],
};

const conflict = (overrides?: Partial<EvidenceConflict>): EvidenceConflict => ({
  evidenceIds: ['a', 'b'],
  dimension: 'numeric',
  description: 'x',
  resolution: 'unresolved',
  ...overrides,
});

describe('computeEvidenceStrength', () => {
  it('空证据为 0，单证据即自身可信度', () => {
    expect(computeEvidenceStrength([], 0)).toBe(0);
    expect(computeEvidenceStrength([ev('a', 0.8, 'P1')], 0)).toBeCloseTo(0.8, 5);
  });

  it('独立出版方交叉印证加成，同一出版方无加成', () => {
    expect(computeEvidenceStrength([ev('a', 0.7, 'P1'), ev('b', 0.7, 'P2')], 0)).toBeCloseTo(
      0.77,
      5,
    );
    expect(computeEvidenceStrength([ev('a', 0.7, 'P1'), ev('b', 0.7, 'P1')], 0)).toBeCloseTo(
      0.7,
      5,
    );
  });

  it('未决冲突触发 0.85 惩罚', () => {
    expect(computeEvidenceStrength([ev('a', 0.8, 'P1')], 2)).toBeCloseTo(0.8 * 0.85, 5);
  });
});

describe('buildSupplementHints', () => {
  it('来源缺口 + LLM 建议合并', () => {
    const hints = buildSupplementHints(sq, [ev('a', 0.7, 'P1')], [], ['模型建议的方向']);
    expect(hints[0]).toContain('公司官方披露'); // 预期来源未使用
    expect(hints).toContain('模型建议的方向');
  });

  it('数值冲突与未决冲突分别给出针对性方向', () => {
    const hints = buildSupplementHints(sq, [], [conflict()], []);
    expect(hints.some((h) => h.includes('权威数值'))).toBe(true);
    expect(hints.some((h) => h.includes('仲裁'))).toBe(true);
  });

  it('合并后上限 5 条', () => {
    const hints = buildSupplementHints(sq, [], [], ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    expect(hints).toHaveLength(5);
  });
});

describe('confidenceLabel', () => {
  it('三分级边界', () => {
    expect(confidenceLabel(0.8)).toBe('高');
    expect(confidenceLabel(0.75)).toBe('高');
    expect(confidenceLabel(0.6)).toBe('中');
    expect(confidenceLabel(0.5)).toBe('中');
    expect(confidenceLabel(0.3)).toBe('低');
  });
});

// ---------------------------------------------------------------- verifySubQuestion 清洗兜底

const emit = () => {};
const verifySq: SubQuestion = {
  id: 'SQ-x',
  question: '问题',
  priority: 'P0',
  keywords: ['只有一个关键词'],
  expectedSources: ['company_disclosure', 'research_report'],
  successCriteria: 'x',
  status: 'retrieving',
  supplementRoundsUsed: 0,
  supplementHints: [],
};

class ScriptedLLM implements LLMAdapter {
  readonly name = 'scripted';
  calls = 0;
  constructor(private readonly handler: (call: number) => string) {}
  async complete(_req: LLMRequest): Promise<string> {
    this.calls += 1;
    return this.handler(this.calls);
  }
}

describe('verifySubQuestion LLM 输出清洗', () => {
  const config: ResearchConfig = { ...DEFAULT_CONFIG, minEvidencePerSubQuestion: 2 };

  it('编造 ID/自引用冲突被剔除，空 verdict/空描述被兜底（非法枚举由 Schema 门禁拦截）', async () => {
    const llm = new ScriptedLLM(() =>
      JSON.stringify({
        consistency: 'contradictory',
        verdict: '', // 空 verdict → 兜底文案
        confidence: 0.9,
        supportingEvidenceIds: ['EV-编造的'], // 全部非法 → 回退全量证据
        conflicts: [
          { evidenceIds: ['a', 'a'], dimension: 'numeric', description: 'd', resolution: 'a_wins' }, // 自引用 → 剔除
          {
            evidenceIds: ['a', 'EV-编造的'],
            dimension: 'numeric',
            description: 'd',
            resolution: 'a_wins',
          }, // 引用不存在的证据 → 剔除
          {
            evidenceIds: ['a', 'b'],
            dimension: 'numeric',
            description: '   ', // 空白描述 → 兜底文案
            resolution: 'a_wins',
          }, // 合法保留
        ],
      }),
    );

    const v = await verifySubQuestion(
      llm,
      verifySq,
      [ev('a', 0.7, 'P1'), ev('b', 0.7, 'P2')],
      config,
      emit,
    );

    expect(v.consistency).toBe('contradictory');
    expect(v.verdict).toBe('证据已收集，结论待定。');
    expect(v.supportingEvidenceIds.sort()).toEqual(['a', 'b']); // 回退为全量
    expect(v.conflicts).toHaveLength(1); // 自引用与编造 ID 被剔除
    expect(v.conflicts[0]).toMatchObject({
      evidenceIds: ['a', 'b'],
      dimension: 'numeric',
      description: '证据表述存在出入', // 空白描述兜底
      resolution: 'a_wins',
    });
    // 冲突已仲裁且置信度达标 → 不触发补充检索
    expect(v.needsSupplement).toBe(false);
    expect(v.supplementHints).toEqual([]);
  });

  it('证据全部来自同一出版方：不经 LLM 直接判缺乏交叉印证', async () => {
    const llm = new ScriptedLLM(() => {
      throw new Error('不应调用 LLM');
    });
    const v = await verifySubQuestion(
      llm,
      verifySq,
      [ev('a', 0.7, '同一出版方'), ev('b', 0.7, '同一出版方')],
      config,
      emit,
    );
    expect(v.consistency).toBe('insufficient');
    expect(v.verdict).toContain('缺乏独立交叉印证');
    expect(v.needsSupplement).toBe(true);
    expect(llm.calls).toBe(0);
  });

  it('无 publisher 的证据回退用 url 判定来源独立性', async () => {
    const noPublisher = (id: string): Evidence => ({
      ...ev(id, 0.7, ''),
      source: {
        type: 'news_media',
        title: `t-${id}`,
        url: `https://site${id}.com/x`,
        retrievedVia: 'test',
      },
    });
    const llm = new ScriptedLLM(() =>
      JSON.stringify({
        consistency: 'consistent',
        verdict: '相互印证',
        confidence: 0.9,
        supportingEvidenceIds: ['a', 'b'],
        conflicts: [],
      }),
    );
    const v = await verifySubQuestion(
      llm,
      { ...verifySq, keywords: ['唯一词'], expectedSources: ['company_disclosure'] },
      [noPublisher('a'), noPublisher('b')],
      config,
      emit,
    );
    expect(v.consistency).toBe('consistent'); // url 独立 → 走 LLM 验证
    expect(v.needsSupplement).toBe(false);
    expect(llm.calls).toBe(1);
  });
});

/**
 * planner 单元测试：拆解护栏与修订护栏
 * 覆盖：P0 确定性保障、关键词回退、去重、数量上限；
 * replan 的 P0 保护、add 查重、adjust 预算重置、修订留痕。
 */
import { describe, it, expect } from 'vitest';
import { createPlan, revisePlan } from '../planner.js';
import type { LLMAdapter, LLMRequest } from '../llm.js';
import type { AgentEventEmitter, ResearchConfig, ScopeConstraints } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

class FakeLLM implements LLMAdapter {
  readonly name = 'fake-llm';
  constructor(private readonly respond: (prompt: string) => string) {}
  async complete(req: LLMRequest): Promise<string> {
    return this.respond(req.prompt);
  }
}

const emit: AgentEventEmitter = () => {};
const SCOPE: ScopeConstraints = {};

describe('createPlan 拆解护栏', () => {
  it('P0 确定性保障 + 关键词回退 + 去重 + 数量上限', async () => {
    const llm = new FakeLLM(() =>
      JSON.stringify({
        subQuestions: [
          { question: 'Q1', priority: 'P1', keywords: [] },
          { question: 'Q1', priority: 'P1', keywords: ['a'] },
          { question: 'Q2', priority: 'P2', keywords: ['b'] },
          { question: 'Q3', priority: 'P1', keywords: ['c'] },
        ],
      }),
    );
    const config: ResearchConfig = { ...DEFAULT_CONFIG, maxSubQuestions: 2 };
    const plan = await createPlan(llm, '研究问题', SCOPE, config, emit);

    expect(plan.subQuestions).toHaveLength(2); // 上限截断 + 重复剔除
    expect(plan.subQuestions[0]!.priority).toBe('P0'); // 无 P0 → 首个提升
    expect(plan.subQuestions[0]!.keywords).toEqual(['Q1']); // 空关键词回退为问题文本
    expect(plan.version).toBe(1);
  });
});

describe('revisePlan 修订护栏', () => {
  it('P0 不可 drop、add 查重与 derivedFrom、adjust 重置补充预算', async () => {
    const planLlm = new FakeLLM(() =>
      JSON.stringify({
        subQuestions: [
          { question: '营收增速', priority: 'P0', keywords: ['营收'] },
          { question: '增长驱动', priority: 'P1', keywords: ['驱动'] },
        ],
      }),
    );
    const plan = await createPlan(planLlm, 'A公司研究', SCOPE, DEFAULT_CONFIG, emit);
    const p0 = plan.subQuestions[0]!;
    const p1 = plan.subQuestions[1]!;
    p0.supplementRoundsUsed = 2; // 模拟预算已耗尽
    p1.supplementRoundsUsed = 1;

    const reviseLlm = new FakeLLM(() =>
      JSON.stringify({
        action: 'adjust',
        reason: '换权威口径',
        add: [
          { question: '增长驱动', priority: 'P2', keywords: ['x'] }, // 与现有重复 → 跳过
          { question: '同业对照', priority: 'P1', keywords: ['同业'], derivedFrom: p0.id },
        ],
        adjust: [{ id: p0.id, keywords: ['官方披露', '年报'], reason: '换权威口径' }],
        drop: [
          { id: p0.id, reason: '试图丢弃 P0' },
          { id: p1.id, reason: '丢弃 P1' },
        ],
      }),
    );
    const revised = await revisePlan(
      reviseLlm,
      plan,
      [{ kind: 'persistently_insufficient', subQuestionId: p0.id, detail: 'x' }],
      2,
      DEFAULT_CONFIG,
      emit,
    );

    expect(revised).not.toBeNull();
    expect(revised!.version).toBe(2);
    expect(revised!.subQuestions.some((s) => s.id === p0.id)).toBe(true); // P0 保留
    expect(revised!.subQuestions.some((s) => s.id === p1.id)).toBe(false); // P1 已移除
    const adjustedSq = revised!.subQuestions.find((s) => s.id === p0.id)!;
    expect(adjustedSq.keywords).toEqual(['官方披露', '年报']);
    expect(adjustedSq.status).toBe('pending');
    expect(adjustedSq.supplementRoundsUsed).toBe(0); // adjust 重置预算
    const added = revised!.subQuestions.find((s) => s.question === '同业对照')!;
    expect(added.derivedFrom).toBe(p0.id);
    expect(revised!.revisions).toHaveLength(1);
    expect(revised!.revisions[0]!.removed).toEqual([p1.id]);
  });

  it('全部修订项无效时不升版本', async () => {
    const planLlm = new FakeLLM(() =>
      JSON.stringify({
        subQuestions: [{ question: '营收增速', priority: 'P0', keywords: ['营收'] }],
      }),
    );
    const plan = await createPlan(planLlm, 'A公司研究', SCOPE, DEFAULT_CONFIG, emit);
    const p0 = plan.subQuestions[0]!;

    const reviseLlm = new FakeLLM(() =>
      JSON.stringify({
        action: 'adjust',
        reason: '无效修订',
        add: [{ question: '营收增速', priority: 'P1', keywords: ['x'] }], // 与现有重复
        adjust: [{ id: p0.id, keywords: [], reason: '空关键词无效' }],
        drop: [{ id: 'SQ-不存在', reason: '无效 id' }],
      }),
    );
    const revised = await revisePlan(
      reviseLlm,
      plan,
      [{ kind: 'retrieval_failed', subQuestionId: p0.id, detail: 'x' }],
      2,
      DEFAULT_CONFIG,
      emit,
    );
    expect(revised).toBeNull();
    expect(plan.version).toBe(1);
  });

  it('LLM 返回全无效拆解时兜底为单子问题计划', async () => {
    // 空数组会被 Schema 门禁（minItems）拦截并重试；空 question（Schema 放行）
    // 的条目全部被 normalizeDraft 剔除 → 走兜底路径
    const llm = new FakeLLM(() =>
      JSON.stringify({ subQuestions: [{ question: '', priority: 'P0', keywords: [] }] }),
    );
    const plan = await createPlan(llm, '原问题', SCOPE, DEFAULT_CONFIG, emit);
    expect(plan.subQuestions).toHaveLength(1);
    expect(plan.subQuestions[0]!.question).toBe('原问题');
    expect(plan.subQuestions[0]!.priority).toBe('P0');
    expect(plan.subQuestions[0]!.keywords).toEqual(['原问题']);
  });

  it('完整 scope 约束进入规划提示词', async () => {
    let captured = '';
    const llm = new FakeLLM((prompt) => {
      captured = prompt;
      return JSON.stringify({
        subQuestions: [{ question: 'Q1', priority: 'P0', keywords: ['a'] }],
      });
    });
    await createPlan(
      llm,
      'Q',
      {
        timeRange: '2025-2026',
        region: '中国',
        industry: '消费电子',
        language: '中文',
        extraRequirements: ['需给出数据来源'],
      },
      DEFAULT_CONFIG,
      emit,
    );
    for (const part of ['2025-2026', '中国', '消费电子', '中文', '需给出数据来源']) {
      expect(captured).toContain(part);
    }
  });

  it('revisePlan 对缺失字段 draft/无效 id 的归一化与跳过（非法值由 Schema 门禁拦截）', async () => {
    const planLlm = new FakeLLM(() =>
      JSON.stringify({
        subQuestions: [{ question: '营收增速', priority: 'P0', keywords: ['营收'] }],
      }),
    );
    const config: ResearchConfig = { ...DEFAULT_CONFIG, maxSubQuestions: 2 };
    const plan = await createPlan(planLlm, 'A公司研究', SCOPE, config, emit);
    const p0 = plan.subQuestions[0]!;

    const reviseLlm = new FakeLLM(() =>
      JSON.stringify({
        action: 'adjust',
        reason: '混合有效性修订',
        add: [
          { question: '', priority: 'P1', keywords: ['x'] }, // 空 question → normalize 剔除
          { question: '新子问题一', priority: 'P1', keywords: [] }, // 空 keywords → 回退为问题文本
          { question: '新子问题二', priority: 'P2', keywords: ['y'] }, // 超上限 → 截断
        ],
        adjust: [
          { id: 'SQ-不存在', keywords: ['x'], reason: '无效 id → 跳过' },
          { id: p0.id, keywords: [], reason: '空 keywords → 跳过' },
          { id: p0.id, keywords: ['官方披露'], reason: '有效调整' },
        ],
        drop: [],
      }),
    );
    const revised = await revisePlan(
      reviseLlm,
      plan,
      [
        // 问题引用不存在的子问题 id → 展示层兜底
        { kind: 'retrieval_failed', subQuestionId: 'SQ-幽灵', detail: 'x' },
      ],
      2,
      config,
      emit,
    );

    expect(revised).not.toBeNull();
    expect(revised!.subQuestions.find((s) => s.id === p0.id)!.keywords).toEqual(['官方披露']);
    expect(revised!.subQuestions.filter((s) => s.question.startsWith('新子问题'))).toHaveLength(1); // 上限 2，只加了第一个
    const added = revised!.subQuestions.find((s) => s.question === '新子问题一')!;
    expect(added.priority).toBe('P1'); // 缺失优先级归一
    expect(added.keywords).toEqual(['新子问题一']); // 缺失 keywords 回退为问题文本
    expect(added.expectedSources).toEqual(['news_media']); // 缺失来源类型归一
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runExpertWithLLM, type ExpertRunOptions } from '../expertRunner.js';
import { QueueTimeoutError, QUEUE_TIMEOUT_CODE } from '../../utils/limitGate.js';
import { isLLMAvailable, chatJSON } from '../index.js';
import type { ExpertOpinion } from '../../types.js';

/**
 * LLM 专家运行器的降级可观测性。
 *
 * 缺陷背景：runExpertWithLLM 原本用 `catch { return ruleFallback() }` 吞掉全部 LLM 错误
 * （含闸门排队超时 QueueTimeoutError，其语义是 429），于是
 *  1) 429/上游不可用的语义在专家层消失，路由层再也看不到"系统繁忙"；
 *  2) 报告把规则引擎结论当成"专家研判"呈现，用户无从分辨结论来源。
 * 修复后：降级仍不抛错（管道稳定），但返回的 opinion 带上 _degraded / _degradeReason，
 * 由报告层如实披露。
 *
 * 网络隔离：整个模块的 LLM 依赖被替换为替身，不发任何真实请求。
 */
vi.mock('../index.js', () => ({
  isLLMAvailable: vi.fn(() => true),
  chatJSON: vi.fn(),
}));

/** 规则引擎替身：返回一个可辨识的观点对象 */
function ruleOpinion(): ExpertOpinion {
  return {
    expert: '基本面财务专家',
    arguments: [
      { text: '规则论点：平均毛利率高', confidence: 80, type: 'support', evidenceType: 'fact' },
    ],
    overallSentiment: 'neutral',
    confidence: 80,
    keyPoints: ['规则要点'],
  };
}

function makeOptions(): ExpertRunOptions {
  return {
    expertName: '基本面财务专家',
    systemPrompt: '你是基本面财务专家',
    context: '财务数据上下文',
    ruleFallback: ruleOpinion,
  };
}

/** LLM 正常返回（含 support 与 oppose，避免触发 prompts.ts 的 _incomplete 标记） */
function normalLLMOutput() {
  return {
    arguments: [
      { text: 'LLM 支持论点', confidence: 75, type: 'support', evidenceType: 'fact' },
      { text: 'LLM 反对论点', confidence: 60, type: 'oppose', evidenceType: 'inference' },
    ],
    overallSentiment: 'bullish',
    confidence: 78,
    keyPoints: ['LLM 要点'],
  };
}

describe('runExpertWithLLM：降级原因可被上层看见', () => {
  beforeEach(() => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(chatJSON).mockReset();
  });

  it('未配置 LLM → 标记 _degraded + _degradeReason=llm_unavailable，且不发起 LLM 调用', async () => {
    vi.mocked(isLLMAvailable).mockReturnValue(false);

    const opinion = await runExpertWithLLM(makeOptions());

    expect(opinion._degraded).toBe(true);
    expect(opinion._degradeReason).toBe('llm_unavailable');
    expect(opinion.arguments[0].text).toContain('规则论点'); // 确实是规则引擎结论
    expect(vi.mocked(chatJSON)).not.toHaveBeenCalled();
  });

  it('闸门排队超时（QueueTimeoutError，429 语义）→ _degradeReason=queue_timeout', async () => {
    vi.mocked(chatJSON).mockRejectedValue(new QueueTimeoutError('llm', 31_000, 30_000));

    const opinion = await runExpertWithLLM(makeOptions());

    expect(opinion._degraded).toBe(true);
    expect(opinion._degradeReason).toBe('queue_timeout');
  });

  it('排队超时错误跨模块实例（只有 code=LLM_QUEUE_TIMEOUT）也判为 queue_timeout', async () => {
    const duckTyped = Object.assign(new Error('排队超时'), { code: QUEUE_TIMEOUT_CODE });
    vi.mocked(chatJSON).mockRejectedValue(duckTyped);

    const opinion = await runExpertWithLLM(makeOptions());

    expect(opinion._degradeReason).toBe('queue_timeout');
  });

  it('其它 LLM 错误 → _degradeReason=llm_error，且绝不抛错（既有契约）', async () => {
    vi.mocked(chatJSON).mockRejectedValue(new Error('upstream 502'));

    const opinion = await runExpertWithLLM(makeOptions());

    expect(opinion._degraded).toBe(true);
    expect(opinion._degradeReason).toBe('llm_error');
  });

  it('反断言：全 LLM 成功时不得出现任何降级标记', async () => {
    vi.mocked(chatJSON).mockResolvedValue(normalLLMOutput());

    const opinion = await runExpertWithLLM(makeOptions());

    expect(opinion.expert).toBe('基本面财务专家');
    expect(opinion.overallSentiment).toBe('bullish');
    expect(opinion).not.toHaveProperty('_degraded');
    expect(opinion).not.toHaveProperty('_degradeReason');
    expect(opinion._degraded).toBeUndefined();
  });
});

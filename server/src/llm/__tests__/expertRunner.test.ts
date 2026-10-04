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

/**
 * 结构化响应为空时的「重问一次」回路。
 *
 * 缺陷背景：chatJSON<T> 的泛型只是编译期断言，JSON.parse 成功即原样返回，运行期
 * 不校验结构。模型完全可能回一个合法但空的壳（`{"arguments":[],"keyPoints":[]}`），
 * 这类响应**不抛错**，于是被 normalizeExpertOpinion 补上默认值后变成一条
 * 「自信度 60、情绪 neutral、零论点」的伪研判——比明确降级更糟：报告不会标注降级，
 * 用户看到的是一份看起来正常、实则没有内容的专家意见。
 * 修复后：识别退化响应并把「你哪里不对 + 原文」回灌重问一次；仍退化才按原路径降级。
 */
describe('runExpertWithLLM：空结构化响应的重问回路', () => {
  beforeEach(() => {
    vi.mocked(isLLMAvailable).mockReturnValue(true);
    vi.mocked(chatJSON).mockReset();
  });

  it('首轮返回空壳 → 重问一次并采用第二次的有效研判', async () => {
    vi.mocked(chatJSON)
      .mockResolvedValueOnce({ arguments: [], overallSentiment: 'neutral', keyPoints: [] })
      .mockResolvedValueOnce(normalLLMOutput());

    const opinion = await runExpertWithLLM(makeOptions());

    expect(vi.mocked(chatJSON)).toHaveBeenCalledTimes(2);
    expect(opinion.overallSentiment).toBe('bullish');
    expect(opinion.arguments[0].text).toBe('LLM 支持论点');
    expect(opinion._degraded).toBeUndefined(); // 重问成功就不算降级
  });

  it('有效响应不触发重问（不多烧一次 token）', async () => {
    vi.mocked(chatJSON).mockResolvedValue(normalLLMOutput());

    await runExpertWithLLM(makeOptions());

    expect(vi.mocked(chatJSON)).toHaveBeenCalledTimes(1);
  });

  it('只有 keyPoints、arguments 为空 → 视为有内容，不重问', async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      arguments: [],
      overallSentiment: 'bullish',
      confidence: 70,
      keyPoints: ['只有要点没有论点'],
    });

    const opinion = await runExpertWithLLM(makeOptions());

    expect(vi.mocked(chatJSON)).toHaveBeenCalledTimes(1);
    expect(opinion.keyPoints).toEqual(['只有要点没有论点']);
  });

  it('重问最多一次：第二次仍为空则不再追问，按原路径产出（不无限烧 token）', async () => {
    vi.mocked(chatJSON).mockResolvedValue({ arguments: [], keyPoints: [] });

    const opinion = await runExpertWithLLM(makeOptions());

    expect(vi.mocked(chatJSON)).toHaveBeenCalledTimes(2);
    // 与修复前一致：空壳会被 normalizeExpertOpinion 补默认值，不抛错
    expect(opinion.arguments).toEqual([]);
    expect(opinion.confidence).toBe(60); // clampInt 的 fallback
    expect(opinion._degraded).toBeUndefined();
  });

  it('重问时把失败原文与 schema 一并回灌给模型', async () => {
    vi.mocked(chatJSON)
      .mockResolvedValueOnce({ arguments: [], keyPoints: [] })
      .mockResolvedValueOnce(normalLLMOutput());

    await runExpertWithLLM(makeOptions());

    const repairTurn = vi.mocked(chatJSON).mock.calls[1][0];
    const last = repairTurn[repairTurn.length - 1] as { role: string; content: string };
    expect(repairTurn.length).toBeGreaterThan(2); // 追加了 assistant 回放 + user 纠正
    expect(last.role).toBe('user');
    expect(last.content).toContain('无法解析成研判结果');
    expect(last.content).toContain('"arguments"'); // 回灌了模型实际返回的内容
    expect(last.content).toContain('overallSentiment'); // 并重述 schema
  });

  it('重问自身抛错 → 不掩盖首轮结果的处理，仍不向外抛', async () => {
    vi.mocked(chatJSON)
      .mockResolvedValueOnce({ arguments: [], keyPoints: [] })
      .mockRejectedValueOnce(new Error('重问时上游 502'));

    const opinion = await runExpertWithLLM(makeOptions());

    expect(vi.mocked(chatJSON)).toHaveBeenCalledTimes(2);
    expect(opinion._degraded).toBeUndefined();
    expect(opinion.arguments).toEqual([]);
  });

  it('首轮直接抛错（闸门超时）→ 不触发重问，直接按 queue_timeout 降级', async () => {
    vi.mocked(chatJSON).mockRejectedValue(new QueueTimeoutError('llm', 31_000, 30_000));

    const opinion = await runExpertWithLLM(makeOptions());

    expect(vi.mocked(chatJSON)).toHaveBeenCalledTimes(1);
    expect(opinion._degradeReason).toBe('queue_timeout');
  });
});

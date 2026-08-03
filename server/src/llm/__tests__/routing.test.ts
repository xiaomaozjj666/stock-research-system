import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectModel, modelSpec, getEmbedModel } from '../config.js';
import { recordUsage, getCostReport, resetCostTracker } from '../cost.js';

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('多模型路由', () => {
  beforeEach(() => resetCostTracker());

  it('无路由配置时回退主模型', () => {
    setEnv('DEEPSEEK_MODEL', 'deepseek-chat');
    setEnv('LLM_MODEL_CHEAP', undefined);
    setEnv('LLM_MODEL_REASONING', undefined);
    expect(selectModel('chat')).toBe('deepseek-chat');
  });

  it('cheap 模型在支持 chat 的任务上优先（成本更低）', () => {
    setEnv('DEEPSEEK_MODEL', 'premium');
    setEnv('LLM_MODEL_CHEAP', 'cheap');
    setEnv('LLM_COST_IN_CHEAP', '0.0001');
    setEnv('LLM_COST_OUT_CHEAP', '0.0002');
    setEnv('LLM_COST_IN_PREMIUM', '0.01');
    setEnv('LLM_COST_OUT_PREMIUM', '0.03');
    expect(selectModel('chat')).toBe('cheap');
  });

  it('reasoning 任务路由到推理模型', () => {
    setEnv('DEEPSEEK_MODEL', 'premium');
    setEnv('LLM_MODEL_REASONING', 'reason');
    setEnv('LLM_COST_IN_REASON', '0.005');
    setEnv('LLM_COST_OUT_REASON', '0.015');
    setEnv('LLM_COST_IN_PREMIUM', '0.01');
    setEnv('LLM_COST_OUT_PREMIUM', '0.03');
    expect(selectModel('reasoning')).toBe('reason');
  });

  it('未知模型返回 0 成本规格', () => {
    const s = modelSpec('nope');
    expect(s.id).toBe('nope');
    expect(s.costPer1kInput).toBe(0);
  });

  it('嵌入模型默认主模型，可被覆盖', () => {
    setEnv('DEEPSEEK_MODEL', 'm');
    setEnv('LLM_EMBED_MODEL', undefined);
    expect(getEmbedModel()).toBe('m');
    setEnv('LLM_EMBED_MODEL', 'emb');
    expect(getEmbedModel()).toBe('emb');
  });
});

describe('成本治理', () => {
  beforeEach(() => resetCostTracker());
  afterEach(() => resetCostTracker());

  it('记账与按模型汇总，reset 清空', () => {
    recordUsage('m', 1000, 500, { cost: 0.01, task: 'chat' });
    recordUsage('m', 2000, 0, { cost: 0.02, task: 'embedding' });
    const r = getCostReport();
    expect(r.callCount).toBe(2);
    expect(r.totalPromptTokens).toBe(3000);
    expect(r.totalCompletionTokens).toBe(500);
    expect(Math.abs(r.totalCost - 0.03)).toBeLessThan(1e-9);
    expect(r.byModel['m'].calls).toBe(2);
    resetCostTracker();
    expect(getCostReport().callCount).toBe(0);
  });
});

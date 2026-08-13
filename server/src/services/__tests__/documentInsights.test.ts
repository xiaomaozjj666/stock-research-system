import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractDocumentInsights } from '../documentInsights.js';

const origFetch = global.fetch;
const origKey = process.env.DEEPSEEK_API_KEY;
const origOpenaiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  // 同时清空 OPENAI：isLLMAvailable 只要任一 key 存在即 true，宿主有 OPENAI_API_KEY
  // 时"无 LLM 回退词典法"用例会打真实网络
  process.env.OPENAI_API_KEY = '';
});
afterEach(() => {
  global.fetch = origFetch;
  if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = origKey;
  if (origOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = origOpenaiKey;
});

describe('文档洞察抽取', () => {
  it('LLM 抽取结构化要点', async () => {
    const payload = {
      summary: '业绩超预期',
      positives: ['营收增长'],
      risks: ['毛利承压'],
      catalysts: ['新产能'],
      confidence: 'high',
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }) as unknown as typeof fetch;

    const r = await extractDocumentInsights('某公司的年报显示营收增长');
    expect(r.source).toBe('llm');
    expect(r.summary).toBe('业绩超预期');
    expect(r.positives).toContain('营收增长');
    expect(r.confidence).toBe('high');
  });

  it('LLM 失败回退词典法', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
    const r = await extractDocumentInsights('公司营收增长，但面临监管风险');
    expect(r.source).toBe('heuristic');
    expect(r.positives.length).toBeGreaterThan(0);
    expect(r.risks.length).toBeGreaterThan(0);
  });

  it('无 LLM 时直接走词典法兜底', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const r = await extractDocumentInsights('公司营收增长，但面临监管风险与退市警示');
    expect(r.source).toBe('heuristic');
    expect(r.positives.length).toBeGreaterThan(0);
    expect(r.risks.length).toBeGreaterThan(0);
  });
});

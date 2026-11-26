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

  it('LLM 返回缺字段/非数组/未知置信度：逐项降级而不抛错', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: '',
                positives: 'not-an-array',
                risks: null,
                confidence: 'unknown',
              }),
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const r = await extractDocumentInsights('某公司发布年度报告，营收增长。');
    expect(r.source).toBe('llm');
    // summary 为空时回退原文前 200 字
    expect(r.summary).toBe('某公司发布年度报告，营收增长。');
    expect(r.positives).toEqual([]);
    expect(r.risks).toEqual([]);
    expect(r.catalysts).toEqual([]);
    expect(r.confidence).toBe('medium');
  });

  it('置信度大小写与中文均能识别（HIGH/低）', async () => {
    const payloads = ['HIGH', '低'];
    for (const confidence of payloads) {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '摘要',
                  positives: [],
                  risks: [],
                  catalysts: [],
                  confidence,
                }),
              },
            },
          ],
        }),
      }) as unknown as typeof fetch;
      const r = await extractDocumentInsights('文本');
      expect(r.confidence).toBe(confidence === '低' ? 'low' : 'high');
    }
  });

  it('超长文本：只取前 6000 字做词典扫描，summary 截断到 200', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const long = `${'铺垫'.repeat(3500)}增长`; // 增长出现在 6000 字之后
    const r = await extractDocumentInsights(long);
    expect(r.source).toBe('heuristic');
    expect(r.summary).toHaveLength(200);
    expect(r.positives).not.toContain('提及「增长」'); // 6000 字窗口外的关键词不计入
  });
});

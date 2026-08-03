import { describe, it, expect } from 'vitest';
import { scoreNewsWithLLM, extractNewsSignal } from '../newsSignal.js';

describe('newsSignal LLM enhancement', () => {
  it('scoreNewsWithLLM returns null (or safe array) when LLM unavailable', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const r = await scoreNewsWithLLM([{ id: '1', title: '利好', publishedAt: new Date().toISOString() }]);
    expect(r === null || (Array.isArray(r) && r.length === 1)).toBe(true);
  });

  it('extractNewsSignal degrades to neutral when no live news (sandbox)', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // 沙箱可访问 datacenter.eastmoney.com，需显式让 fetch 失败，才能验证"无实时新闻→中性"分支
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    try {
      const { signal, source } = await extractNewsSignal('600519');
      expect(signal.hasNews).toBe(false);
      expect(source).toBe('none');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

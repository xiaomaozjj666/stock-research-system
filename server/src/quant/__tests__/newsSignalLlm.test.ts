import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scoreNewsWithLLM, extractNewsSignal } from '../newsSignal.js';

describe('newsSignal LLM enhancement', () => {
  beforeEach(() => {
    // 双 key 清空 + afterEach 还原：此前只 delete 不还原，会污染同 worker 后续用例
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('scoreNewsWithLLM 在 LLM 不可用时返回 null', async () => {
    const r = await scoreNewsWithLLM([
      { id: '1', title: '利好', publishedAt: new Date().toISOString() },
    ]);
    // 收紧：LLM 不可用 → 恒 null（此前"null 或数组"双分支宽断言，数组分支是死代码）
    expect(r).toBeNull();
  });

  it('extractNewsSignal degrades to neutral when no live news (sandbox)', async () => {
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

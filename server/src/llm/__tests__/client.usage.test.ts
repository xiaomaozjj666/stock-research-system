import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chat } from '../client.js';
import { getCostReport, resetCostTracker } from '../cost.js';

const origFetch = global.fetch;
const origKey = process.env.DEEPSEEK_API_KEY;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  resetCostTracker();
});
afterEach(() => {
  global.fetch = origFetch;
  if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = origKey;
});

describe('chat 用量与成本捕获', () => {
  it('调用后记录 token 用量', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await chat([{ role: 'user', content: 'hi' }], { task: 'chat' });
    expect(out).toBe('hi');

    const r = getCostReport();
    expect(r.callCount).toBe(1);
    expect(r.totalPromptTokens).toBe(120);
    expect(r.totalCompletionTokens).toBe(30);
  });

  it('无 usage 时安全跳过记账', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await chat([{ role: 'user', content: 'hi' }]);
    expect(getCostReport().callCount).toBe(0);
  });
});

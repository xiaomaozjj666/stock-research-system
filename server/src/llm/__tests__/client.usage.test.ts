import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chat, chatStream } from '../client.js';
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

// 构造一个流式 Response：按顺序 enqueue SSE 片段，最后 close
function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    text: async () => '',
  } as unknown as Response;
}

describe('chatStream 用量与超时', () => {
  it('请求体携带 stream_options.include_usage，并解析末尾 usage 记账', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":20}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue(makeStreamResponse(chunks));
    global.fetch = fetchMock as unknown as typeof fetch;

    const tokens: string[] = [];
    const full = await chatStream([{ role: 'user', content: 'hi' }], (t) => tokens.push(t), {
      task: 'chat',
    });

    expect(full).toBe('你好');
    expect(tokens).toEqual(['你好']);
    // 请求体应显式请求 include_usage（修复前缺失，导致流式调用完全不记账）
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.stream_options).toEqual({ include_usage: true });
    // 末尾 usage 应被捕获并记入成本治理
    const r = getCostReport();
    expect(r.callCount).toBe(1);
    expect(r.totalPromptTokens).toBe(50);
    expect(r.totalCompletionTokens).toBe(20);
  });

  it('流式响应无 usage 时安全跳过记账', async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'];
    const fetchMock = vi.fn().mockResolvedValue(makeStreamResponse(chunks));
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatStream([{ role: 'user', content: 'hi' }], () => {});
    expect(getCostReport().callCount).toBe(0);
  });

  it('options.timeout 生效：超时触发 abort（修复前无超时会永久挂起）', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          const sig = init?.signal;
          const onAbort = () => reject(new Error('The operation was aborted'));
          if (sig?.aborted) onAbort();
          else sig?.addEventListener('abort', onAbort, { once: true });
        });
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      chatStream([{ role: 'user', content: 'hi' }], () => {}, { timeout: 30 }),
    ).rejects.toThrow(/abort/i);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

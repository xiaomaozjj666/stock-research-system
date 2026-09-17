import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 回归：响应头到达 ≠ 请求结束。
 * 此前 fetchWithRetry 在拿到响应头时就 clearTimeout，body 读取因此裸奔：
 * 上游在头之后卡住（连接不断、数据不来）时该请求永不结束，而它占着的
 * llmGate 配额只在 finally 归还——累积到并发上限，全站 LLM 调用都会排队超时 429。
 * 现在非流式路径把 body 读取纳入同一次尝试的超时窗口。
 */
const ENV_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    process.env[k] = k === 'DEEPSEEK_API_KEY' ? 'test-key' : 'http://upstream.invalid/v1';
  }
  process.env.DEEPSEEK_MODEL = 'test-model';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

/** 伪造上游：响应头正常返回，body 永不产出；仅在 signal 中止时失败 */
function stubStalledBodyFetch() {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    const stall = () =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
        );
      });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: stall,
      json: stall,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('LLM 非流式调用：body 读取受超时保护', () => {
  it('上游返回头后卡住不产出 body → 超时失败，而不是永久挂起', async () => {
    stubStalledBodyFetch();
    const { chat } = await import('../client.js');

    const started = Date.now();
    await expect(chat([{ role: 'user', content: 'hi' }], { timeout: 80 })).rejects.toBeTruthy();
    // 关键：能返回（此前这里会一直挂着），且大致落在超时窗口附近
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('超时后闸门配额被归还（否则 8 次僵尸请求就能占满并发）', async () => {
    stubStalledBodyFetch();
    const { chat } = await import('../client.js');
    const { llmGate } = await import('../../utils/limitGate.js');

    const inflightBefore = llmGate.snapshot().inFlight;
    await chat([{ role: 'user', content: 'hi' }], { timeout: 80 }).catch(() => undefined);

    expect(llmGate.snapshot().inFlight).toBe(inflightBefore);
  });

  it('body 正常返回时仍按原样解析出内容', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const payload = {
          choices: [{ message: { content: '答案' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        };
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify(payload),
          json: async () => payload,
        } as unknown as Response;
      }),
    );
    const { chat } = await import('../client.js');
    await expect(chat([{ role: 'user', content: 'hi' }], { timeout: 2000 })).resolves.toBe('答案');
  });
});

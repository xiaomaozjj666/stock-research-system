import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chat, chatStream, chatWithTools } from '../client.js';
import { llmGate, isQueueTimeoutError, QueueTimeoutError } from '../../utils/limitGate.js';

/**
 * 闸门集成测试：真 client + mock 全局 fetch。
 * 这些用例在修复前都会失败（此前没有任何全局并发上限）：
 *  - 并发峰值会等于调用数而不是上限；
 *  - 排队超时不存在，第二次调用只会一直挂着。
 */

const origFetch = global.fetch;
const origKey = process.env.DEEPSEEK_API_KEY;
const origMax = process.env.LLM_MAX_CONCURRENCY;
const origTimeout = process.env.LLM_QUEUE_TIMEOUT_MS;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function okResponse(content = 'hi'): Response {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

function errResponse(status: number): Response {
  return {
    ok: false,
    status,
    text: async () => 'bad request',
    json: async () => ({}),
  } as unknown as Response;
}

function toolsResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'call_1', function: { name: 'run_analysis', arguments: '{"code":"600519"}' } },
            ],
          },
        },
      ],
    }),
  } as unknown as Response;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, 1));
  }
}

const msg = [{ role: 'user' as const, content: 'hi' }];

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  llmGate.resetStats();
});

afterEach(async () => {
  global.fetch = origFetch;
  for (const [key, value] of [
    ['DEEPSEEK_API_KEY', origKey],
    ['LLM_MAX_CONCURRENCY', origMax],
    ['LLM_QUEUE_TIMEOUT_MS', origTimeout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // 每个用例结束都必须把配额还清：留一个在途就说明释放路径漏了
  await waitUntil(() => llmGate.inFlight === 0 && llmGate.queued === 0, 2000);
});

describe('chat 经过全局并发闸门', () => {
  it('并发峰值 = LLM_MAX_CONCURRENCY（既不超过上限，也不退化为串行）', async () => {
    process.env.LLM_MAX_CONCURRENCY = '2';
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let active = 0;
    let peak = 0;
    global.fetch = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      active--;
      return okResponse();
    }) as unknown as typeof fetch;

    const calls = Array.from({ length: 5 }, () => chat(msg, { task: 'chat' }));
    // 未释放任何配额前，只允许 2 个请求到达 fetch
    await waitUntil(() => gates.length === 2);
    expect(peak).toBe(2);
    expect(llmGate.queued).toBe(3);

    // 逐个放行：每次放行才有下一个请求进入 fetch
    for (let i = 0; i < 5; i++) {
      await waitUntil(() => gates.length > i);
      gates[i].resolve();
    }
    await expect(Promise.all(calls)).resolves.toHaveLength(5);
    expect(peak).toBe(2); // 全程峰值就是上限
    expect(llmGate.inFlight).toBe(0);
    expect(llmGate.snapshot().acquired).toBe(5);
  });

  it('异常路径归还配额：一次失败后（上限=1）下一次调用立刻能拿到配额', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    let fail = true;
    global.fetch = vi.fn(async () =>
      fail ? errResponse(400) : okResponse('ok'),
    ) as unknown as typeof fetch;

    await expect(chat(msg)).rejects.toThrow(/LLM 请求失败 \(400\)/);
    expect(llmGate.inFlight).toBe(0);

    fail = false;
    // 若配额泄漏（inFlight 停在 1），这里会排队到默认 30s 超时
    await expect(chat(msg)).resolves.toBe('ok');
    expect(llmGate.inFlight).toBe(0);
  });

  it('排队超时抛出 429 语义错误（LLM_QUEUE_TIMEOUT + retryAfterMs）', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    process.env.LLM_QUEUE_TIMEOUT_MS = '30';
    const hold = deferred<void>();
    global.fetch = vi.fn(async () => {
      await hold.promise;
      return okResponse();
    }) as unknown as typeof fetch;

    const first = chat(msg);
    await waitUntil(() => llmGate.inFlight === 1);

    const err = await chat(msg).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isQueueTimeoutError(err)).toBe(true);
    expect(err).toBeInstanceOf(QueueTimeoutError);
    expect(err).toMatchObject({ code: 'LLM_QUEUE_TIMEOUT', statusCode: 429, retryAfterMs: 30 });
    expect((err as QueueTimeoutError).retryAfterSeconds).toBe(1);
    expect(llmGate.snapshot()).toMatchObject({ timeouts: 1, inFlight: 1 });

    hold.resolve();
    await expect(first).resolves.toBe('hi');
    expect(llmGate.inFlight).toBe(0);
  });

  it('排队期间被取消：立刻以取消原因 reject（不占配额、不等于排队超时）', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    process.env.LLM_QUEUE_TIMEOUT_MS = '5000';
    const hold = deferred<void>();
    global.fetch = vi.fn(async () => {
      await hold.promise;
      return okResponse();
    }) as unknown as typeof fetch;

    const first = chat(msg);
    await waitUntil(() => llmGate.inFlight === 1);
    const controller = new AbortController();
    const queued = chat(msg, { signal: controller.signal });
    await waitUntil(() => llmGate.queued === 1);
    controller.abort(new Error('客户端已断开'));

    await expect(queued).rejects.toThrow('客户端已断开');
    expect(llmGate.queued).toBe(0);
    expect(llmGate.snapshot().timeouts).toBe(0); // 取消不是超时

    hold.resolve();
    await expect(first).resolves.toBe('hi');
  });
});

describe('chatStream / chatWithTools 同样经过闸门', () => {
  it('流式调用占用配额，读完即释放（期间其他调用排队）', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
    });
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, status: 200, body: stream, text: async () => '' } as unknown as Response;
      }
      return okResponse('second');
    }) as unknown as typeof fetch;

    const tokens: string[] = [];
    const streaming = chatStream(msg, (t) => tokens.push(t), { timeout: 5000 });
    // 流还没结束：配额已被流式调用占住
    await waitUntil(() => llmGate.inFlight === 1);
    const waiting = chat(msg);
    await waitUntil(() => llmGate.queued === 1);

    streamController.enqueue(
      encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'),
    );
    streamController.enqueue(encoder.encode('data: [DONE]\n\n'));
    streamController.close();

    await expect(streaming).resolves.toBe('你好');
    expect(tokens).toEqual(['你好']);
    await expect(waiting).resolves.toBe('second');
    expect(llmGate.inFlight).toBe(0);
  });

  it('工具执行期间不占 LLM 配额（配额在拿到响应后即归还）', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    process.env.LLM_QUEUE_TIMEOUT_MS = '300';
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? toolsResponse() : okResponse('工具回答');
    }) as unknown as typeof fetch;

    const toolGate = deferred<void>();
    let toolStarted = false;
    const withTools = chatWithTools(
      msg,
      [{ type: 'function', function: { name: 'run_analysis' } }],
      async () => {
        toolStarted = true;
        await toolGate.promise;
        return '工具结果';
      },
    );
    await waitUntil(() => toolStarted);

    // 上限=1 且排队超时 300ms：若工具执行期间仍占着配额，这次调用会排队超时
    await expect(chat(msg)).resolves.toBe('工具回答');

    toolGate.resolve();
    await expect(withTools).resolves.toMatchObject({ content: '工具回答' });
    expect(llmGate.inFlight).toBe(0);
  });
});

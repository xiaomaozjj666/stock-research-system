import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatWithTools } from '../client.js';

// 该测试直接验证 function-calling 回路是否正确构造对话消息：
// 1) 带回 tool_calls 的 assistant 消息必须保留 tool_calls 字段；
// 2) tool 结果消息必须带 tool_call_id + name，否则 OpenAI 兼容接口会报
//    "missing field `tool_call_id`"（曾导致线上 400 / 500）。
// 通过 mock 全局 fetch 模拟两轮对话，断言第二轮请求体中的消息结构正确。

function makeResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => json,
  } as unknown as Response;
}

describe('chatWithTools 工具调用回路', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let fetchMock: ReturnType<typeof vi.fn>;
  let captured: { messages: unknown[] }[] = [];

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    captured = [];
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });

  it('把 tool_call_id / name 写入 tool 消息，并保留 assistant.tool_calls', async () => {
    const callId = 'call_abc123';
    const tools = [
      {
        type: 'function',
        function: {
          name: 'run_analysis',
          description: '运行分析',
          parameters: { type: 'object', properties: { code: { type: 'string' } } },
        },
      },
    ];

    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      if (init?.body) captured.push(JSON.parse(init.body));
      // 第一轮：模型请求调用 run_analysis
      if (captured.length === 1) {
        return makeResponse({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: callId, function: { name: 'run_analysis', arguments: '{"code":"600519"}' } },
                ],
              },
            },
          ],
        });
      }
      // 第二轮：基于工具结果给出最终回答
      return makeResponse({ choices: [{ message: { content: '分析完成', tool_calls: [] } }] });
    });

    const res = await chatWithTools(
      [{ role: 'user', content: '分析 600519' }],
      tools,
      async (name, args) => {
        expect(name).toBe('run_analysis');
        expect(args).toEqual({ code: '600519' });
        return JSON.stringify({ summary: 'ok' });
      },
    );

    expect(res.content).toBe('分析完成');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe('run_analysis');

    // 第二轮请求应包含：user + assistant(tool_calls) + tool
    const secondReq = captured[1];
    const msgs = secondReq.messages as Array<Record<string, unknown>>;
    const assistantMsg = msgs.find((m) => m.role === 'assistant');
    const toolMsg = msgs.find((m) => m.role === 'tool');

    expect(assistantMsg).toBeDefined();
    expect(Array.isArray(assistantMsg!.tool_calls)).toBe(true);
    expect((assistantMsg!.tool_calls as unknown[]).length).toBeGreaterThan(0);

    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe(callId);
    expect(toolMsg!.name).toBe('run_analysis');
    expect(typeof toolMsg!.content).toBe('string');
  });

  it('无工具调用时直接返回文本', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      if (init?.body) captured.push(JSON.parse(init.body));
      return makeResponse({ choices: [{ message: { content: '直接回答', tool_calls: [] } }] });
    });
    const res = await chatWithTools(
      [{ role: 'user', content: '你好' }],
      [],
      async () => 'never',
    );
    expect(res.content).toBe('直接回答');
    expect(res.toolCalls).toHaveLength(0);
  });

  it('options.timeout 生效：超时触发 abort，不再静默忽略', async () => {
    // 模拟永不返回的 fetch，仅在 signal abort 时 reject。
    // 修复前：options.timeout 被忽略，fetch 永远 pending，测试会挂到 vitest 超时。
    // 修复后：30ms 后 controller.abort() 触发，promise 很快 reject。
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
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
      chatWithTools(
        [{ role: 'user', content: 'hi' }],
        [],
        async () => 'never',
        { timeout: 30 },
      ),
    ).rejects.toThrow(/abort/i);
    // 确认是超时触发（远小于 vitest 默认 5s 测试超时），而非挂死
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

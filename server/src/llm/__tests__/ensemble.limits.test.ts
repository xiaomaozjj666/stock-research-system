import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { runEnsemble } from '../ensemble.js';
import { chat } from '../client.js';
import { llmGate, isQueueTimeoutError } from '../../utils/limitGate.js';

/**
 * 集合投票的两处 P1 修复回归测试（真 client + mock 全局 fetch）：
 *  1. 多模型扇出经进程级闸门排队（修复前 3 个模型 = 3 个并发请求，无上限）；
 *  2. temperature / maxTokens 不再原样透传上游（修复前 maxTokens=999999 直接出网）。
 */

const origFetch = global.fetch;
const origKey = process.env.DEEPSEEK_API_KEY;
const origMax = process.env.LLM_MAX_CONCURRENCY;
const origTimeout = process.env.LLM_QUEUE_TIMEOUT_MS;
const origCalibration = process.env.MODEL_CALIBRATION_FILE;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function okResponse(content = '看多'): Response {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, 1));
  }
}

const msg = [{ role: 'user' as const, content: '看多还是看空？' }];

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  // 绝对路径：避免校准文件落到项目目录污染工作树
  process.env.MODEL_CALIBRATION_FILE = path.join(
    os.tmpdir(),
    `model-calibration-gate-${process.pid}.json`,
  );
  llmGate.resetStats();
});

afterEach(async () => {
  global.fetch = origFetch;
  for (const [key, value] of [
    ['DEEPSEEK_API_KEY', origKey],
    ['LLM_MAX_CONCURRENCY', origMax],
    ['LLM_QUEUE_TIMEOUT_MS', origTimeout],
    ['MODEL_CALIBRATION_FILE', origCalibration],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await waitUntil(() => llmGate.inFlight === 0 && llmGate.queued === 0, 2000);
});

describe('runEnsemble — 多模型扇出经全局闸门', () => {
  it('3 个模型的扇出并发峰值被钉在 LLM_MAX_CONCURRENCY=2（不退化为串行）', async () => {
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

    const running = runEnsemble(msg, { models: ['model-a', 'model-b', 'model-c'] });
    // 修复前：3 个模型各自直接 fetch，峰值 = 3
    await waitUntil(() => gates.length === 2);
    expect(peak).toBe(2);
    expect(llmGate.queued).toBe(1);

    for (let i = 0; i < 3; i++) {
      await waitUntil(() => gates.length > i);
      gates[i].resolve();
    }
    const result = await running;
    expect(result.effectiveModels).toBe(3);
    expect(peak).toBe(2);
    expect(llmGate.inFlight).toBe(0);
  });

  it('全部模型排队超时时抛出的仍是闸门错误（429 语义不会在集成层丢失）', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    process.env.LLM_QUEUE_TIMEOUT_MS = '30';
    const hold = deferred<void>();
    global.fetch = vi.fn(async () => {
      await hold.promise;
      return okResponse();
    }) as unknown as typeof fetch;

    // 先占住唯一配额，模拟上游堵塞
    const blocker = chat(msg);
    await waitUntil(() => llmGate.inFlight === 1);

    const err = await runEnsemble(msg, { models: ['model-a'] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isQueueTimeoutError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'LLM_QUEUE_TIMEOUT', statusCode: 429 });

    hold.resolve();
    await blocker;
  });
});

describe('runEnsemble — 参数夹紧（不再原样透传上游）', () => {
  it('temperature>2 与 maxTokens 超上限都被夹紧后才会出网', async () => {
    const bodies: Record<string, unknown>[] = [];
    global.fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return okResponse();
    }) as unknown as typeof fetch;

    await runEnsemble(msg, { models: ['model-a'], temperature: 5, maxTokens: 999_999 });

    expect(bodies).toHaveLength(1);
    // 修复前：temperature=5、max_tokens=999999 原样出网
    expect(bodies[0].temperature).toBe(2);
    expect(bodies[0].max_tokens).toBe(4096);
  });

  it('负数 temperature 夹紧到 0，maxTokens=0 夹紧到 1（内部调用方绝不透传非法值）', async () => {
    const bodies: Record<string, unknown>[] = [];
    global.fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return okResponse();
    }) as unknown as typeof fetch;

    await runEnsemble(msg, { models: ['model-a'], temperature: -3, maxTokens: 0 });

    expect(bodies[0].temperature).toBe(0);
    expect(bodies[0].max_tokens).toBe(1);
  });
});

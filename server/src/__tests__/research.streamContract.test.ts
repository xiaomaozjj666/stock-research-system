/**
 * /api/research/deep/stream 的 SSE 帧契约（此前零断言）
 * ----------------------------------------------------------------------------
 * 审查结论指出的盲区：服务端改 phase 名或漏掉 done 帧，全部服务端测试照绿，
 * 客户端到运行时才炸。本文件把帧结构（phase 取值、agent_event 的事件字段、
 * done 携带 result）钉在测试里——改协议必须同步改这里与客户端。
 */
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX_ANALYZE = '200';
  process.env.DEEPSEEK_API_KEY = 'test-key-for-stream-contract';
});

// 慢/快编排器都可控；这里只要它按协议发一条过程事件并返回合法结果
vi.mock('../research-agent/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../research-agent/index.js')>();
  const { makeRunResult } = await import('../test/researchFixture.js');
  return {
    ...actual,
    ResearchOrchestrator: class {
      private readonly deps: { onEvent?: (event: unknown) => void };
      constructor(deps: { onEvent?: (event: unknown) => void }) {
        this.deps = deps;
      }
      async run() {
        // 与真实编排器同一形状的事件（seq/type/round/at/message）
        this.deps.onEvent?.({
          seq: 1,
          type: 'run_started',
          round: 0,
          at: '2026-11-19T00:00:00.000Z',
          message: '研究任务启动',
        });
        return makeRunResult();
      }
    },
  };
});

import { app as rawApp } from '../index.js';
import { withContract } from '../test/contractSupertest.js';

const app = withContract(rawApp);

/** 把 SSE 响应体解析为 data 帧数组 */
function parseFrames(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

describe('GET /api/research/deep/stream SSE 帧契约', () => {
  beforeEach(() => {
    delete process.env.RESEARCH_LIBRARY_DIR;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('先推 agent_event（事件含 seq/type/round/at/message），最后推 done（含 result）', async () => {
    const res = await request(app).get(
      '/api/research/deep/stream?question=白酒行业竞争格局与集中度趋势',
    );
    expect(res.status).toBe(200);

    const frames = parseFrames(res.text);
    expect(frames.length).toBeGreaterThanOrEqual(2);

    // 第一帧：过程事件——phase 与事件字段形状是客户端的解析契约
    expect(frames[0].phase).toBe('agent_event');
    const event = frames[0].event as Record<string, unknown>;
    expect(event).toMatchObject({
      seq: 1,
      type: 'run_started',
      round: 0,
      at: '2026-11-19T00:00:00.000Z',
      message: '研究任务启动',
    });
    expect(typeof event.seq).toBe('number');

    // 末帧：done 携带完整 result（客户端以 result 作为 done promise 的解析值）
    const last = frames.at(-1)!;
    expect(last.phase).toBe('done');
    const result = last.result as Record<string, unknown>;
    expect(result).toHaveProperty('report');
    expect(result).toHaveProperty('plan');
    expect(result).toHaveProperty('stats');
  });
});

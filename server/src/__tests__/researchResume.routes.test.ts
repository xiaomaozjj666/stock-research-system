/**
 * 深度研究断点续跑（路由层）
 * ----------------------------------------------------------------------------
 * 审查定位的长期缺口：SSE 断开即整次研究作废。路由层新增三件事，这里逐条钉住：
 *   1. runId 续跑入口：只传 runId 也能跑（问题/范围/参数以断点为准），
 *      传了不一致的 question 显式 400（不静默混跑）；
 *   2. 首帧 run_meta 下发 runId（客户端断线后凭它续跑）；
 *   3. 同一研究不允许并发续跑（409），成功完成后断点清理。
 * 编排器整体被 mock：本文件验的是路由契约与断点生命周期，不是研究算法本身。
 */
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockDeps = {
  resume?: { roundsCompleted?: number };
  onCheckpoint?: (snapshot: unknown) => void;
};

// 可变控制面：mock 类通过它把 deps 交给用例、按需阻塞 run（并发 409 用例）
const ctl = vi.hoisted(() => ({
  lastDeps: null as MockDeps | null,
  gate: null as Promise<void> | null,
  markStarted: null as (() => void) | null,
}));

vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX_ANALYZE = '200';
  process.env.DEEPSEEK_API_KEY = 'test-key-for-resume';
});

vi.mock('../research-agent/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../research-agent/index.js')>();
  const { makeRunResult } = await import('../test/researchFixture.js');
  return {
    ...actual,
    ResearchOrchestrator: class {
      constructor(deps: MockDeps) {
        ctl.lastDeps = deps;
      }
      async run() {
        if (ctl.gate) {
          ctl.markStarted?.();
          await ctl.gate;
        }
        return makeRunResult();
      }
    },
  };
});

import { app as rawApp } from '../index.js';
import {
  clearResearchCheckpoint,
  loadResearchCheckpoint,
  saveResearchCheckpoint,
} from '../services/researchCheckpoint.js';
import { makeRunResult } from '../test/researchFixture.js';
import { withContract } from '../test/contractSupertest.js';

const app = withContract(rawApp);

let dir = '';
const origTtl = process.env.RESEARCH_CHECKPOINT_TTL_MS;
const origCheckpointDir = process.env.RESEARCH_CHECKPOINT_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-research-resume-route-'));
  process.env.RESEARCH_CHECKPOINT_DIR = dir;
  ctl.lastDeps = null;
  ctl.gate = null;
  ctl.markStarted = null;
});

afterEach(() => {
  if (origCheckpointDir === undefined) delete process.env.RESEARCH_CHECKPOINT_DIR;
  else process.env.RESEARCH_CHECKPOINT_DIR = origCheckpointDir;
  if (origTtl === undefined) delete process.env.RESEARCH_CHECKPOINT_TTL_MS;
  else process.env.RESEARCH_CHECKPOINT_TTL_MS = origTtl;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一条「已完成 1 轮」的断点 */
function seedCheckpoint(runId: string, question = '白酒行业竞争格局与风险') {
  const result = makeRunResult();
  expect(
    saveResearchCheckpoint({
      runId,
      question,
      scope: { industry: '白酒' },
      config: { maxRounds: 3 },
      snapshot: {
        plan: result.plan,
        evidence: result.evidence,
        verifications: result.verifications,
        events: result.events,
        stats: result.stats,
        roundsCompleted: 1,
        consecutiveNoProgress: 0,
        failedTasks: [],
      },
    }),
  ).toBe(true);
  return runId;
}

/** 解析 SSE 响应体为 data 帧 */
function parseFrames(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

describe('续跑入参校验', () => {
  it('POST：不存在的 runId 返回 404（不是「从头跑一遍」）', async () => {
    const res = await request(app).post('/api/research/deep').send({ runId: 'run-missing' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('断点不存在');
  });

  it('POST：runId 格式非法（路径穿越形态）返回 400', async () => {
    const res = await request(app).post('/api/research/deep').send({ runId: '../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('格式非法');
  });

  it('GET stream：runId 格式非法返回 400', async () => {
    const res = await request(app).get('/api/research/deep/stream').query({ runId: 'Bad_Id' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('格式非法');
  });

  it('GET stream：runId 与 question 不一致返回 400（不静默混跑旧证据与新问题）', async () => {
    seedCheckpoint('run-mismatch', '白酒行业竞争格局');
    const res = await request(app)
      .get('/api/research/deep/stream')
      .query({ runId: 'run-mismatch', question: '完全不同的问题表述' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('不一致');
  });

  it('GET stream：scope 与原研究不一致返回 400', async () => {
    seedCheckpoint('run-scope');
    const res = await request(app)
      .get('/api/research/deep/stream')
      .query({ runId: 'run-scope', scope: JSON.stringify({ industry: '光伏' }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('不一致');
  });
});

describe('SSE 续跑契约', () => {
  it('全新研究首帧 run_meta 下发 runId；完成后断点被清理（不再可续跑）', async () => {
    const res = await request(app)
      .get('/api/research/deep/stream')
      .query({ question: '白酒行业竞争格局与风险' });
    expect(res.status).toBe(200);

    const frames = parseFrames(res.text);
    expect(frames[0].phase).toBe('run_meta');
    expect(frames[0].resumed).toBe(false);
    expect(frames[0].resumedFromRound).toBe(0);
    const runId = frames[0].runId as string;
    expect(runId).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(frames.at(-1)!.phase).toBe('done');

    // 已完成的断点不留在磁盘上：避免「已完成的研究还能续跑」的歧义
    expect(loadResearchCheckpoint(runId)).toBeNull();
  });

  it('带 runId 续跑：run_meta 标记 resumed，且编排器拿到上一轮的断点状态', async () => {
    seedCheckpoint('run-resume1');

    const res = await request(app).get('/api/research/deep/stream').query({ runId: 'run-resume1' });
    expect(res.status).toBe(200);

    const frames = parseFrames(res.text);
    expect(frames[0]).toMatchObject({
      phase: 'run_meta',
      runId: 'run-resume1',
      resumed: true,
      resumedFromRound: 1,
    });
    expect(frames.at(-1)!.phase).toBe('done');

    // 编排器确实收到断点（而不是被当成新研究）：轮次与计划来自断点
    expect(ctl.lastDeps?.resume?.roundsCompleted).toBe(1);
    // 成功后断点清理
    expect(loadResearchCheckpoint('run-resume1')).toBeNull();
  });

  it('同一 runId 并发续跑：第二个请求 409（拒绝重复付费）', async () => {
    seedCheckpoint('run-busy');
    let release!: () => void;
    ctl.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ctl.markStarted = resolve;
    });

    const first = request(app).get('/api/research/deep/stream').query({ runId: 'run-busy' });
    const firstPromise = first.then((r) => r);
    await started;

    const second = await request(app).get('/api/research/deep/stream').query({ runId: 'run-busy' });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('仍在进行中');

    release();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(200);
  });

  it('同步接口同样支持只传 runId 续跑', async () => {
    seedCheckpoint('run-sync1');
    const res = await request(app).post('/api/research/deep').send({ runId: 'run-sync1' });
    expect(res.status).toBe(200);
    expect(res.body.report).toBeTruthy();
    expect(ctl.lastDeps?.resume?.roundsCompleted).toBe(1);
  });
});

describe('可续跑列表（/api/research/deep/resumable）', () => {
  it('返回未完成研究的摘要（runId / 问题 / 已完成轮次 / 可复用证据数）', async () => {
    seedCheckpoint('run-list1');
    const res = await request(app).get('/api/research/deep/resumable');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      runId: 'run-list1',
      question: '白酒行业竞争格局与风险',
      roundsCompleted: 1,
    });
    expect(typeof res.body.items[0].evidenceCount).toBe('number');
  });

  it('完成后（断点已清理）不再出现在列表里', async () => {
    seedCheckpoint('run-list2');
    clearResearchCheckpoint('run-list2');
    const res = await request(app).get('/api/research/deep/resumable');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('limit 越界返回 400', async () => {
    const res = await request(app).get('/api/research/deep/resumable').query({ limit: 0 });
    expect(res.status).toBe(400);
  });
});

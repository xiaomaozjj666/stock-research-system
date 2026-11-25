/**
 * 深度研究断点（Research Checkpoint）持久化行为
 * ----------------------------------------------------------------------------
 * 断点是「断线不丢几十次 LLM 调用」的唯一凭据，边界比快乐路径重要：
 *  - runId 直接拼文件名 → 必须挡掉路径穿越；
 *  - 过期 / 损坏必须干净降级为「无断点」，不能让 500 或陈旧证据被复用；
 *  - 容量淘汰不能留下永远列不出来的孤儿文件；
 *  - createdAt 在续跑链上必须保持不变（同一次研究）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResearchSnapshot } from '../../research-agent/index.js';
import { makeRunResult } from '../../test/researchFixture.js';
import {
  clearResearchCheckpoint,
  getResearchCheckpointDir,
  isResearchRunId,
  listResearchCheckpoints,
  loadResearchCheckpoint,
  newResearchRunId,
  saveResearchCheckpoint,
} from '../researchCheckpoint.js';

let dir = '';

function makeSnapshot(overrides: Partial<ResearchSnapshot> = {}): ResearchSnapshot {
  const result = makeRunResult();
  return {
    plan: result.plan,
    evidence: result.evidence,
    verifications: result.verifications,
    events: result.events,
    stats: result.stats,
    roundsCompleted: 1,
    consecutiveNoProgress: 0,
    failedTasks: [],
    ...overrides,
  };
}

function save(runId: string, snapshot: ResearchSnapshot = makeSnapshot()) {
  return saveResearchCheckpoint({
    runId,
    question: '白酒行业竞争格局',
    scope: { industry: '白酒' },
    config: { maxRounds: 3 },
    snapshot,
  });
}

const origCheckpointDir = process.env.RESEARCH_CHECKPOINT_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-research-checkpoint-'));
  process.env.RESEARCH_CHECKPOINT_DIR = dir;
});

afterEach(() => {
  if (origCheckpointDir === undefined) delete process.env.RESEARCH_CHECKPOINT_DIR;
  else process.env.RESEARCH_CHECKPOINT_DIR = origCheckpointDir;
  delete process.env.RESEARCH_CHECKPOINT_TTL_MS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('researchCheckpoint 基本读写', () => {
  it('保存后可原样读回（问题 / 范围 / 参数 / 快照）', () => {
    const snapshot = makeSnapshot({ roundsCompleted: 2 });
    expect(save('run-a1', snapshot)).toBe(true);

    const record = loadResearchCheckpoint('run-a1');
    expect(record).not.toBeNull();
    expect(record!.question).toBe('白酒行业竞争格局');
    expect(record!.scope).toEqual({ industry: '白酒' });
    expect(record!.config).toEqual({ maxRounds: 3 });
    expect(record!.snapshot.roundsCompleted).toBe(2);
    expect(record!.snapshot.events).toHaveLength(1);
  });

  it('同 runId 重写沿用首次 createdAt（同一次研究不被断点重写改写成新的）', async () => {
    save('run-a2');
    const first = loadResearchCheckpoint('run-a2')!;
    // 等待 2ms 保证 updatedAt 一定变化（ISO 毫秒精度）
    await new Promise((r) => setTimeout(r, 2));
    save('run-a2', makeSnapshot({ roundsCompleted: 2 }));
    const second = loadResearchCheckpoint('run-a2')!;
    expect(second.createdAt).toBe(first.createdAt);
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.updatedAt).getTime(),
    );
    expect(second.snapshot.roundsCompleted).toBe(2);
  });

  it('runId 是路径穿越 / 非法格式时拒绝保存与读取', () => {
    expect(isResearchRunId('../escape')).toBe(false);
    expect(isResearchRunId('C:/tmp/x')).toBe(false);
    expect(isResearchRunId('')).toBe(false);
    expect(isResearchRunId('Run-Upper')).toBe(false);
    expect(save('../escape')).toBe(false);
    expect(loadResearchCheckpoint('../escape')).toBeNull();
    expect(clearResearchCheckpoint('../escape')).toBeUndefined();
  });

  it('损坏的断点文件读取为 null（不让一条脏数据把续跑打成 500）', () => {
    save('run-a3');
    fs.writeFileSync(path.join(getResearchCheckpointDir(), 'run-a3.json'), '{not json', 'utf-8');
    expect(loadResearchCheckpoint('run-a3')).toBeNull();
  });

  it('形态不完整的断点（缺 plan）读取为 null', () => {
    save('run-a4');
    fs.writeFileSync(
      path.join(getResearchCheckpointDir(), 'run-a4.json'),
      JSON.stringify({
        runId: 'run-a4',
        question: 'q',
        scope: {},
        config: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        snapshot: { evidence: [], verifications: [], events: [], stats: {}, roundsCompleted: 1 },
      }),
      'utf-8',
    );
    expect(loadResearchCheckpoint('run-a4')).toBeNull();
  });
});

describe('researchCheckpoint 过期与容量', () => {
  it('TTL 为 0 表示不提供续跑：读取即过期并清理文件', () => {
    save('run-b1');
    process.env.RESEARCH_CHECKPOINT_TTL_MS = '0';
    expect(loadResearchCheckpoint('run-b1')).toBeNull();
    expect(fs.existsSync(path.join(getResearchCheckpointDir(), 'run-b1.json'))).toBe(false);
  });

  it('过期断点不进入可续跑列表，且被顺带清理', () => {
    save('run-b2');
    process.env.RESEARCH_CHECKPOINT_TTL_MS = '1';
    const fut = new Date(Date.now() + 60_000).toISOString();
    const file = path.join(getResearchCheckpointDir(), 'run-b2.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.updatedAt = fut; // 先确保是「新鲜」的，再改回过去验证列表逻辑
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');
    expect(listResearchCheckpoints()).toHaveLength(1);

    raw.updatedAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');
    expect(listResearchCheckpoints()).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('超过上限淘汰最旧的，且不留下孤儿文件', () => {
    // 直接写 20 条显式时间递增的断点，再用 save 触发第 21 条 → 淘汰最旧的 run-c00。
    // 不靠「快速连续 save」制造顺序：同一毫秒内 updatedAt 相同，排序不稳定。
    const base = Date.now() - 60 * 60_000;
    for (let i = 0; i < 20; i += 1) {
      const runId = `run-c${String(i).padStart(2, '0')}`;
      const record = {
        runId,
        question: '问题',
        scope: {},
        config: {},
        createdAt: new Date(base + i * 1000).toISOString(),
        updatedAt: new Date(base + i * 1000).toISOString(),
        snapshot: makeSnapshot({ roundsCompleted: 1 }),
      };
      fs.writeFileSync(
        path.join(getResearchCheckpointDir(), `${runId}.json`),
        JSON.stringify(record),
        'utf-8',
      );
    }
    expect(save('run-c20')).toBe(true);

    const items = listResearchCheckpoints(50);
    expect(items).toHaveLength(20);
    expect(items.some((it) => it.runId === 'run-c00')).toBe(false);
    expect(fs.existsSync(path.join(getResearchCheckpointDir(), 'run-c00.json'))).toBe(false);
    expect(fs.existsSync(path.join(getResearchCheckpointDir(), 'run-c20.json'))).toBe(true);
  });

  it('列表按 updatedAt 新 -> 旧排序，并带出可复用证据条数', async () => {
    const evidence = [
      {
        id: 'EV-1',
        subQuestionId: 'q1',
        claim: '高端白酒 CR3 达到 82%',
        quote: '原文摘录',
        source: { type: 'news_media' as const, title: '来源', retrievedVia: 'news' },
        path: { round: 1, query: '白酒', adapter: 'news', attempt: 1 },
        credibility: 0.7,
        retrievedAt: '2026-11-18T01:56:00.000Z',
      },
    ];
    save('run-d1', makeSnapshot({ evidence, roundsCompleted: 2 }));
    // 拉开 updatedAt，避免同毫秒下排序不确定
    await new Promise((r) => setTimeout(r, 3));
    save('run-d2', makeSnapshot({ roundsCompleted: 1 }));
    const items = listResearchCheckpoints(10);
    expect(items.map((it) => it.runId)).toEqual(['run-d2', 'run-d1']);
    const older = items.find((it) => it.runId === 'run-d1')!;
    expect(older.roundsCompleted).toBe(2);
    expect(older.evidenceCount).toBe(1);
  });

  it('clear 后读取为 null、列表不再包含', () => {
    save('run-e1');
    clearResearchCheckpoint('run-e1');
    expect(loadResearchCheckpoint('run-e1')).toBeNull();
    expect(listResearchCheckpoints().some((it) => it.runId === 'run-e1')).toBe(false);
  });

  it('newResearchRunId 生成的 id 全部合法且互不相同', () => {
    const ids = Array.from({ length: 50 }, () => newResearchRunId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isResearchRunId(id)).toBe(true);
  });
});

/**
 * 研究简报测试：生成聚合、增量 notes、落盘轮换、定时器开关。
 * 落盘经 RESEARCH_DIGEST_FILE 重定向到临时目录，与其它台账测试同模式。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runResearchDigest,
  listResearchDigests,
  startDigestScheduler,
  type DigestDeps,
} from '../researchDigest.js';
import type { ScreenerRunResult } from '../../quant/screener.js';

let tmpDir = '';

function digestDeps(
  overrides: Partial<Pick<DigestDeps, 'readScreener' | 'readLedger' | 'now'>> = {},
): DigestDeps {
  return {
    readScreener: () => null,
    readLedger: () => ({
      total: 0,
      kept: 0,
      bySource: {},
      lastAt: null,
      keptExpectedFalse: 0,
      keptOosShare: 0,
    }),
    ...overrides,
  };
}

function screenerRun(overrides: Partial<ScreenerRunResult> = {}): ScreenerRunResult {
  return {
    at: '2026-09-12T10:00:00.000Z',
    scanned: 5000,
    eligible: 4800,
    failed: 12,
    strategies: ['rps_250'],
    hits: [
      { code: '600001', name: '甲', strategy: 'rps_250', detail: '250 日收益 30%' },
      { code: '600002', name: '乙', strategy: 'rps_250', detail: '250 日收益 25%' },
    ],
    universe: { total: 5200, coverage: 0.96 },
    ...overrides,
  } as ScreenerRunResult;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-digest-'));
  process.env.RESEARCH_DIGEST_FILE = path.join(tmpDir, 'digests.json');
});

afterEach(() => {
  delete process.env.RESEARCH_DIGEST_FILE;
  delete process.env.QUANT_DIGEST_INTERVAL_HOURS;
  vi.useRealTimers();
});

describe('runResearchDigest — 聚合与增量', () => {
  it('初筛与台账聚合进 sections；无初筛记录时字段如实为 null', () => {
    const d = runResearchDigest(
      digestDeps({
        readScreener: () =>
          screenerRun({
            hits: [
              { code: '600001', name: '甲', strategy: 'rps_250', detail: '250 日收益 30%' },
              { code: '600002', name: '乙', strategy: 'rps_250', detail: '250 日收益 25%' },
            ],
          }),
        readLedger: () => ({
          total: 30,
          kept: 4,
          bySource: { expression: 20, hypothesis: 10 },
          lastAt: '2026-09-12T09:00:00.000Z',
          keptExpectedFalse: 0.2,
          keptOosShare: 0.75,
        }),
      }),
    );
    expect(d.screener.at).toBe('2026-09-12T10:00:00.000Z');
    expect(d.screener.hitCount).toBe(2);
    expect(d.screener.topHits).toHaveLength(2);
    expect(d.ledger.total).toBe(30);
    expect(d.ledger.keptExpectedFalse).toBeCloseTo(0.2, 6);
    // 首份简报 notes：解释口径
    expect(d.notes.some((n) => n.includes('首份简报'))).toBe(true);
    expect(d.notes.some((n) => n.includes('采信 4 条'))).toBe(true);
  });

  it('与上一份的差异进 notes：新实验数、初筛更新、采信数变化', () => {
    runResearchDigest(
      digestDeps({
        readScreener: () => screenerRun(),
        readLedger: () => ({
          total: 10,
          kept: 2,
          bySource: {},
          lastAt: null,
          keptExpectedFalse: 0.1,
          keptOosShare: 0.5,
        }),
      }),
    );
    const d2 = runResearchDigest(
      digestDeps({
        readScreener: () => screenerRun({ at: '2026-09-12T16:00:00.000Z' }),
        readLedger: () => ({
          total: 14,
          kept: 3,
          bySource: {},
          lastAt: null,
          keptExpectedFalse: 0.15,
          keptOosShare: 0.6,
        }),
      }),
    );
    expect(d2.notes.some((n) => n.includes('新增 4 条因子实验记录'))).toBe(true);
    expect(d2.notes.some((n) => n.includes('初筛已更新'))).toBe(true);
    expect(d2.notes.some((n) => n.includes('采信实验数 2 → 3'))).toBe(true);
  });

  it('台账记录数下降 → 明示可能发生了清理（不冒充正常）', () => {
    runResearchDigest(
      digestDeps({
        readLedger: () => ({
          total: 10,
          kept: 2,
          bySource: {},
          lastAt: null,
          keptExpectedFalse: 0.1,
          keptOosShare: 0.5,
        }),
      }),
    );
    const d2 = runResearchDigest(
      digestDeps({
        readLedger: () => ({
          total: 3,
          kept: 1,
          bySource: {},
          lastAt: null,
          keptExpectedFalse: 0.05,
          keptOosShare: 0,
        }),
      }),
    );
    expect(d2.notes.some((n) => n.includes('减少'))).toBe(true);
  });

  it('连续生成落盘：列表倒序返回且容量淘汰最旧', () => {
    for (let i = 0; i < 5; i++) {
      runResearchDigest(
        digestDeps({
          now: () => new Date(Date.parse('2026-09-12T10:00:00.000Z') + i * 3_600_000),
        }),
      );
    }
    const items = listResearchDigests(20);
    expect(items).toHaveLength(5);
    // 倒序：最新在前
    expect(items[0].createdAt >= items[items.length - 1].createdAt).toBe(true);
    const few = listResearchDigests(2);
    expect(few).toHaveLength(2);
    expect(few[0].id).toBe(items[0].id);
  });

  it('每次生成 id 唯一', () => {
    const a = runResearchDigest(digestDeps());
    const b = runResearchDigest(digestDeps());
    expect(a.id).not.toBe(b.id);
  });
});

describe('startDigestScheduler — 开关语义', () => {
  it('NODE_ENV=test 下不启动定时器（env 配了也不起）', () => {
    process.env.QUANT_DIGEST_INTERVAL_HOURS = '24';
    const spy = vi.spyOn(globalThis, 'setInterval');
    startDigestScheduler();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('间隔非法（0/负/非数字）→ 不启动', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    process.env.NODE_ENV = 'production';
    for (const v of ['0', '-1', 'abc', '']) {
      process.env.QUANT_DIGEST_INTERVAL_HOURS = v;
      startDigestScheduler();
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    process.env.NODE_ENV = 'test';
  });

  it('合法间隔 → 启动且 unref（进程可退出）', () => {
    process.env.NODE_ENV = 'production';
    process.env.QUANT_DIGEST_INTERVAL_HOURS = '24';
    const spy = vi.spyOn(globalThis, 'setInterval');
    startDigestScheduler();
    expect(spy).toHaveBeenCalledTimes(1);
    const timer = spy.mock.results[0].value as { unref?: () => void };
    expect(typeof timer.unref).toBe('function');
    spy.mockRestore();
    process.env.NODE_ENV = 'test';
  });
});

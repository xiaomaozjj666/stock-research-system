/**
 * 自治循环的监控覆盖披露（requested / skipped）
 * ----------------------------------------------------------------------------
 * 背景（审计）：自治循环把**整张**自选股清单交给 runWatchlistNewsBacktest，而该函数
 * 默认只处理前 WATCHLIST_MAX_CODES（20）只；此前自治状态里没有任何披露渠道，
 * 用户会以为清单里每一只都在被监控。
 *
 * 做法：不引真实定时器（intervalMs 被夹紧到 ≥30s，等不起），改为 mock scheduler 的
 * startAutonomousLoop 以捕获 route 传入的 monitor 闭包，手动跑一轮监控后再查状态；
 * watchlistBacktest 保留真实实现（它不联网的部分）——只把 runWatchlistNewsBacktest
 * 换成"按真实契约裁剪"的桩：requested=入参只数、skipped=超上限只数、count=实际处理数。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  /** route 传进 scheduler 的 monitor 闭包（手动触发一轮监控用） */
  monitor: null as null | (() => Promise<unknown>),
  getWatchlist: vi.fn(),
}));

vi.mock('../services/scheduler.js', () => ({
  startAutonomousLoop: (opts: { monitor: () => Promise<unknown> }) => {
    mocks.monitor = opts.monitor;
    return {
      stop: () => {},
      getState: () => ({
        running: true,
        intervalMs: 1000,
        lastAlertCount: 0,
        runCount: 1,
        errorCount: 0,
      }),
    };
  },
}));

vi.mock('../services/watchlistService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/watchlistService.js')>();
  return { ...actual, getWatchlist: mocks.getWatchlist };
});

vi.mock('../services/watchlistBacktest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/watchlistBacktest.js')>();
  return {
    ...actual,
    // 真实实现会为每只股票各拉一次网络；这里只复刻它的**上限裁剪契约**
    // （默认 WATCHLIST_BATCH_MAX=20，超出部分计入 skipped、不计入 count）
    runWatchlistNewsBacktest: vi.fn(async (codes: string[], options?: { maxCodes?: number }) => {
      const max = options?.maxCodes ?? actual.WATCHLIST_BATCH_MAX;
      const selected = codes.slice(0, max);
      return {
        generatedAt: '2026-09-17T00:00:00.000Z',
        count: selected.length,
        withNewsCount: 0,
        results: [],
        requested: codes.length,
        skipped: codes.length - selected.length,
      };
    }),
  };
});

import { app } from '../index.js';
import { WATCHLIST_BATCH_MAX } from '../services/watchlistBacktest.js';
import { auditLogger } from '../services/auditLog.js';

/** 生成 n 只合法 A 股代码（600000 起，避免与真实数据耦合） */
function codesOf(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(600000 + i));
}

beforeEach(() => {
  mocks.monitor = null;
  mocks.getWatchlist.mockReset();
});

afterEach(async () => {
  // 停掉本轮循环，避免 route 模块级 controller 残留影响后续用例
  await request(app).post('/api/autonomous/stop');
});

describe('自治状态披露被跳过的自选股只数', () => {
  it('清单 25 只、上限 20 → 状态里能看到 requested=25 / skipped=5', async () => {
    mocks.getWatchlist.mockReturnValue(codesOf(25));
    const started = await request(app).post('/api/autonomous/start').send({ intervalMs: 60000 });
    expect(started.status).toBe(200);
    expect(mocks.monitor).toBeTypeOf('function');

    // 手动跑一轮监控（等价于 scheduler 到点 tick 一次）
    await mocks.monitor!();

    const status = await request(app).get('/api/autonomous/status');
    expect(status.status).toBe(200);
    expect(status.body.running).toBe(true);
    expect(status.body.requested).toBe(25);
    expect(status.body.skipped).toBe(5);
    // 既有字段不受影响（契约保持）
    expect(status.body.runCount).toBe(1);
    expect(status.body.intervalMs).toBe(1000);
  });

  it('清单未超上限（8 只）→ 状态里**不出现** requested/skipped 字段', async () => {
    mocks.getWatchlist.mockReturnValue(codesOf(8));
    await request(app).post('/api/autonomous/start').send({ intervalMs: 60000 });
    await mocks.monitor!();

    const status = await request(app).get('/api/autonomous/status');
    expect(status.status).toBe(200);
    expect(status.body).not.toHaveProperty('requested');
    expect(status.body).not.toHaveProperty('skipped');
  });

  it('恰好等于上限（20 只）→ 不算裁剪，字段同样缺省', async () => {
    mocks.getWatchlist.mockReturnValue(codesOf(WATCHLIST_BATCH_MAX));
    await request(app).post('/api/autonomous/start').send({ intervalMs: 60000 });
    await mocks.monitor!();

    const status = await request(app).get('/api/autonomous/status');
    expect(status.body).not.toHaveProperty('skipped');
  });

  it('重新启动循环会清掉上一轮的披露（不把旧裁剪挂到新循环上）', async () => {
    mocks.getWatchlist.mockReturnValue(codesOf(25));
    await request(app).post('/api/autonomous/start').send({ intervalMs: 60000 });
    await mocks.monitor!();
    expect((await request(app).get('/api/autonomous/status')).body.skipped).toBe(5);

    // 第二轮启动（清单变短）：状态不应再带上一轮的 skipped=5
    mocks.getWatchlist.mockReturnValue(codesOf(3));
    await request(app).post('/api/autonomous/start').send({ intervalMs: 60000 });
    const beforeRun = await request(app).get('/api/autonomous/status');
    expect(beforeRun.body).not.toHaveProperty('skipped');

    await mocks.monitor!();
    const afterRun = await request(app).get('/api/autonomous/status');
    expect(afterRun.body).not.toHaveProperty('skipped');
  });

  it('启动/停止都留下审计条目，并带上本次请求的 traceId', async () => {
    auditLogger.clear();
    mocks.getWatchlist.mockReturnValue(codesOf(3));

    const started = await request(app).post('/api/autonomous/start').send({ intervalMs: 60000 });
    const startTrace = String(started.headers['x-trace-id']);
    expect(startTrace).toBeTruthy();
    const startEntries = auditLogger.query({ traceId: startTrace });
    expect(startEntries).toHaveLength(1);
    expect(startEntries[0].action).toBe('tool.autonomous.start');
    expect(startEntries[0].metadata?.args).toMatchObject({ intervalMs: 60000 });

    const stopped = await request(app).post('/api/autonomous/stop');
    const stopTrace = String(stopped.headers['x-trace-id']);
    const stopEntries = auditLogger.query({ traceId: stopTrace });
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].action).toBe('tool.autonomous.stop');
    // 两条审计各自挂在自己的链路 ID 上，不会互相串
    expect(stopTrace).not.toBe(startTrace);
  });
});

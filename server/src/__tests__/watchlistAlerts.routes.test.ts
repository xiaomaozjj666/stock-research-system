import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 批量新闻回测是网络密集型动作（逐只拉新闻 + 行情），这里要验证的是
 * 「监控 → 落盘 → 只读接口读回」这条接线，故把回测替换为固定报告：不触网、可重复。
 */
vi.mock('../services/watchlistBacktest.js', () => ({
  runWatchlistNewsBacktest: vi.fn(async (codes: string[]) => ({
    generatedAt: '2026-09-15T10:00:00.000Z',
    count: codes.length,
    withNewsCount: 1,
    results: [
      {
        code: codes[0],
        name: '贵州茅台',
        newsSentiment: { polarity: 0.82, weightedImpact: 0.44, hasNews: true },
      },
    ],
  })),
}));

import { app } from '../index.js';
import {
  normalizeAlertsSnapshot,
  saveWatchlistAlertsSnapshot,
  MAX_ALERTS_PER_SNAPSHOT,
} from '../services/watchlistService.js';

/**
 * /api/watchlist/alerts：最近一次异动监控快照（落盘 + 只读回看）。
 * 落盘路径重定向到临时文件（与 services 单测同模式）。
 */
let tmpDir: string;
let alertsFile: string;
let watchlistFile: string;
const origFile = process.env.WATCHLIST_ALERTS_FILE;
const origWatchlistFile = process.env.WATCHLIST_FILE;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'watchlist-alerts-route-'));
  alertsFile = join(tmpDir, 'watchlistAlerts.json');
  watchlistFile = join(tmpDir, 'watchlist.json');
  process.env.WATCHLIST_ALERTS_FILE = alertsFile;
  process.env.WATCHLIST_FILE = watchlistFile;
});

afterAll(() => {
  if (origFile === undefined) delete process.env.WATCHLIST_ALERTS_FILE;
  else process.env.WATCHLIST_ALERTS_FILE = origFile;
  if (origWatchlistFile === undefined) delete process.env.WATCHLIST_FILE;
  else process.env.WATCHLIST_FILE = origWatchlistFile;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(alertsFile)) unlinkSync(alertsFile); // 每个用例从「没有快照」开始
});

describe('GET /api/watchlist/alerts 最近监控快照', () => {
  it('从未监控过：200 + 稳定空结构（不是 404，前端只需一条分支）', async () => {
    const res = await request(app).get('/api/watchlist/alerts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generatedAt: null, monitored: 0, alerts: [] });
  });

  it('落盘后读回完整快照（刷新/复访能看到上次异动的服务端依据）', async () => {
    saveWatchlistAlertsSnapshot(
      normalizeAlertsSnapshot({
        generatedAt: '2026-09-15T10:00:00.000Z',
        monitored: 2,
        alerts: [
          {
            code: '600519',
            name: '贵州茅台',
            level: 'strong-bull',
            polarity: 0.82,
            weightedImpact: 0.4,
            detail: '贵州茅台 新闻姿态强烈看多',
          },
        ],
      }),
    );

    const res = await request(app).get('/api/watchlist/alerts');
    expect(res.status).toBe(200);
    expect(res.body.generatedAt).toBe('2026-09-15T10:00:00.000Z');
    expect(res.body.monitored).toBe(2);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0]).toMatchObject({ code: '600519', level: 'strong-bull' });
  });

  it('快照文件损坏：降级为空结构而非 500', async () => {
    saveWatchlistAlertsSnapshot(
      normalizeAlertsSnapshot({ generatedAt: 'x', monitored: 1, alerts: [] }),
    );
    writeFileSync(alertsFile, '{ broken', 'utf-8');

    const res = await request(app).get('/api/watchlist/alerts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generatedAt: null, monitored: 0, alerts: [] });
  });

  it('接口返回的条数不超过上限（列表响应体不随异动数膨胀）', async () => {
    saveWatchlistAlertsSnapshot(
      normalizeAlertsSnapshot({
        generatedAt: '2026-09-15T10:00:00.000Z',
        monitored: MAX_ALERTS_PER_SNAPSHOT + 10,
        alerts: Array.from({ length: MAX_ALERTS_PER_SNAPSHOT + 10 }, (_, i) => ({
          code: String(600000 + i),
          name: null,
          level: 'high-impact' as const,
          polarity: 0.1,
          weightedImpact: 0.9,
          detail: '影响强度高',
        })),
      }),
    );

    const res = await request(app).get('/api/watchlist/alerts');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(MAX_ALERTS_PER_SNAPSHOT);
  });
});

describe('POST /api/watchlist/monitor 落盘闭环', () => {
  it('监控一次 → 快照落盘 → 刷新页面（重新 GET）仍能读回', async () => {
    writeFileSync(watchlistFile, JSON.stringify(['600519']), 'utf-8');

    const post = await request(app).post('/api/watchlist/monitor');
    expect(post.status).toBe(200);
    expect(post.body.monitored).toBe(1);
    expect(post.body.alerts).toHaveLength(1);
    expect(post.body.alerts[0]).toMatchObject({ code: '600519', level: 'strong-bull' });

    // 关键：另起一次只读请求（等价于用户刷新/复访），拿到的是同一次监控留下的快照
    const get = await request(app).get('/api/watchlist/alerts');
    expect(get.status).toBe(200);
    expect(get.body).toEqual(post.body);
  });

  it('自选股清单为空：400，且不会用空结果覆盖已有快照', async () => {
    writeFileSync(watchlistFile, JSON.stringify([]), 'utf-8');
    saveWatchlistAlertsSnapshot(
      normalizeAlertsSnapshot({
        generatedAt: '2026-09-15T10:00:00.000Z',
        monitored: 1,
        alerts: [],
      }),
    );

    const res = await request(app).post('/api/watchlist/monitor');
    expect(res.status).toBe(400);

    const after = await request(app).get('/api/watchlist/alerts');
    expect(after.body.generatedAt).toBe('2026-09-15T10:00:00.000Z'); // 旧快照仍在
  });
});

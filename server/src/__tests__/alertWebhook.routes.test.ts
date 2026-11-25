import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutonomousController, AutonomousOptions } from '../services/scheduler.js';
import type { WatchlistAlert } from '../services/alerts.js';
import logger from '../utils/logger.js';

/**
 * 异动预警 Webhook 与两条监控通道的接线（不依赖公网）
 * ----------------------------------------------------------------------------
 * 覆盖：
 *  - 手动监控 POST /api/watchlist/monitor：保存快照后推送，source=monitor；
 *  - 自治循环 onAlert：推送 source=autonomous，requested/skipped 与落盘快照同口径；
 *  - 推送失败（拒绝 / 非 2xx / 超时）不改路由返回，也不阻塞响应。
 * 网络层用 vi.stubGlobal('fetch') 覆盖；回测整体打桩，避免逐只拉行情/新闻。
 */
const schedulerMocks = vi.hoisted(() => ({
  onAlert: null as null | NonNullable<AutonomousOptions['onAlert']>,
  onRun: null as null | NonNullable<AutonomousOptions['onRun']>,
}));

vi.mock('../services/scheduler.js', () => ({
  startAutonomousLoop: (opts: AutonomousOptions): AutonomousController => {
    schedulerMocks.onAlert = opts.onAlert ?? null;
    schedulerMocks.onRun = opts.onRun ?? null;
    return {
      stop: () => {},
      getState: () => ({
        running: true,
        intervalMs: 60000,
        lastAlertCount: 0,
        runCount: 0,
        errorCount: 0,
      }),
    };
  },
}));

vi.mock('../services/watchlistBacktest.js', () => ({
  runWatchlistNewsBacktest: vi.fn(async (codes: string[]) => ({
    generatedAt: '2026-11-26T10:00:00.000Z',
    count: codes.length,
    withNewsCount: codes.length,
    results: codes.map((code: string) => ({
      code,
      name: code === '600519' ? '贵州茅台' : '平安银行',
      newsSentiment:
        code === '600519'
          ? { polarity: 0.82, weightedImpact: 0.4, hasNews: true }
          : { polarity: 0.1, weightedImpact: 0.1, hasNews: true },
    })),
  })),
}));

import { app } from '../index.js';

const fetchMock = vi.fn();
let tmpDir = '';
let watchlistFile = '';
let alertsFile = '';
const original = {
  watchlist: process.env.WATCHLIST_FILE,
  alerts: process.env.WATCHLIST_ALERTS_FILE,
  url: process.env.ALERT_WEBHOOK_URL,
  timeout: process.env.ALERT_WEBHOOK_TIMEOUT_MS,
};

/** 只取「本模块产生的」warning，避免 app 其它模块的告警干扰断言 */
function webhookWarnings(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter((call) => String(call[0]).includes('[alertWebhook]'));
}

function alertOf(code = '600519'): WatchlistAlert {
  return {
    code,
    name: code === '600519' ? '贵州茅台' : '平安银行',
    level: 'strong-bull',
    polarity: 0.82,
    weightedImpact: 0.4,
    detail: '贵州茅台 新闻姿态强烈看多（polarity=0.82）',
  };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alert-webhook-route-'));
  watchlistFile = join(tmpDir, 'watchlist.json');
  alertsFile = join(tmpDir, 'watchlistAlerts.json');
  process.env.WATCHLIST_FILE = watchlistFile;
  process.env.WATCHLIST_ALERTS_FILE = alertsFile;
});

afterAll(() => {
  for (const [key, value] of [
    ['WATCHLIST_FILE', original.watchlist],
    ['WATCHLIST_ALERTS_FILE', original.alerts],
    ['ALERT_WEBHOOK_URL', original.url],
    ['ALERT_WEBHOOK_TIMEOUT_MS', original.timeout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/hook';
  delete process.env.ALERT_WEBHOOK_TIMEOUT_MS;
  writeFileSync(watchlistFile, JSON.stringify(['600519']), 'utf-8');
  if (existsSync(alertsFile)) unlinkSync(alertsFile); // 每个用例从「没有快照」开始
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  schedulerMocks.onAlert = null;
  schedulerMocks.onRun = null;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await request(app).post('/api/autonomous/stop');
});

describe('POST /api/watchlist/monitor 推送接线', () => {
  it('保存快照后把同一份快照 POST 出去：source=monitor，body 与响应一致', async () => {
    const res = await request(app).post('/api/watchlist/monitor');
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      event: 'watchlist.alerts',
      source: 'monitor',
      generatedAt: '2026-11-26T10:00:00.000Z',
      monitored: 1,
      alerts: res.body.alerts,
    });
    expect(res.body.alerts).toHaveLength(1);
  });

  it('无预警的监控轮次不推送（响应照常 200）', async () => {
    writeFileSync(watchlistFile, JSON.stringify(['000001']), 'utf-8');

    const res = await request(app).post('/api/watchlist/monitor');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetch 拒绝：路由仍 200，推送只留 warning（不影响响应）', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).post('/api/watchlist/monitor');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    await vi.waitFor(() => expect(webhookWarnings(warnSpy)).toHaveLength(1), { timeout: 2000 });
  });

  it('非 2xx：路由仍 200，推送只留 warning', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }));

    const res = await request(app).post('/api/watchlist/monitor');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    await vi.waitFor(() => expect(webhookWarnings(warnSpy)).toHaveLength(1), { timeout: 2000 });
    expect(
      warnSpy.mock.calls.find((c) => String(c[0]).includes('[alertWebhook]'))?.[1],
    ).toMatchObject({ status: 502 });
  });

  it('推送挂起（超时 500ms）：响应先返回，不等待推送', async () => {
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = '500';
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const res = await request(app).post('/api/watchlist/monitor');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 响应已返回时推送仍在挂起：证明路由没有 await 推送
    expect(webhookWarnings(warnSpy)).toHaveLength(0);
    await vi.waitFor(() => expect(webhookWarnings(warnSpy)).toHaveLength(1), { timeout: 2000 });
  });
});

describe('自治循环 onAlert 推送接线', () => {
  it('onAlert 推送 source=autonomous，并带与快照一致的 requested/skipped', async () => {
    writeFileSync(watchlistFile, JSON.stringify(['600519', '000001']), 'utf-8');
    const started = await request(app).post('/api/autonomous/start').send({ intervalMs: 60000 });
    expect(started.status).toBe(200);
    expect(schedulerMocks.onAlert).toBeTypeOf('function');

    const alerts = [alertOf()];
    const report = { count: 1, generatedAt: '2026-11-26T11:00:00.000Z' };
    schedulerMocks.onRun!(alerts, report); // 真实调度顺序：先 onRun 落盘，再 onAlert 推送
    schedulerMocks.onAlert!(alerts, report);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(JSON.parse(init.body)).toEqual({
      event: 'watchlist.alerts',
      source: 'autonomous',
      generatedAt: report.generatedAt,
      monitored: 1,
      alerts,
      requested: 2,
      skipped: 1,
    });

    // 既有语义不受影响：落盘快照与 stop 返回的 lastAlerts 保持原行为
    const snapshot = await request(app).get('/api/watchlist/alerts');
    expect(snapshot.body).toMatchObject({ monitored: 1, alerts, requested: 2, skipped: 1 });
    const stopped = await request(app).post('/api/autonomous/stop');
    expect(stopped.body.lastAlerts).toEqual(alerts);
  });
});

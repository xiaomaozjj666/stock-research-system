import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pushAlerts } from '../alertWebhook.js';
import type { WatchlistAlertsSnapshot } from '../watchlistService.js';
import logger from '../../utils/logger.js';

/**
 * 异动预警 Webhook 推送（不依赖公网）
 * ----------------------------------------------------------------------------
 * 用 vi.stubGlobal('fetch') 覆盖网络层，验证：
 *  - 有告警时 POST 的 URL / method / headers / body（含 requested/skipped 的可选性）；
 *  - 无告警、未配置 URL 时不发起任何请求；
 *  - 网络拒绝 / 超时 / 非 2xx 都只降级为 warning，pushAlerts 永不 reject；
 *  - 非法 URL 只告警一次（后续同值调用直接跳过，不再尝试 fetch）。
 */
const fetchMock = vi.fn();
const originalUrl = process.env.ALERT_WEBHOOK_URL;
const originalTimeout = process.env.ALERT_WEBHOOK_TIMEOUT_MS;

function snapshot(overrides: Partial<WatchlistAlertsSnapshot> = {}): WatchlistAlertsSnapshot {
  return {
    generatedAt: '2026-11-26T10:00:00.000Z',
    monitored: 20,
    alerts: [
      {
        code: '600519',
        name: '贵州茅台',
        level: 'strong-bull',
        polarity: 0.82,
        weightedImpact: 0.4,
        detail: '贵州茅台 新闻姿态强烈看多（polarity=0.82）',
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/hook';
  delete process.env.ALERT_WEBHOOK_TIMEOUT_MS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = originalUrl;
  if (originalTimeout === undefined) delete process.env.ALERT_WEBHOOK_TIMEOUT_MS;
  else process.env.ALERT_WEBHOOK_TIMEOUT_MS = originalTimeout;
});

describe('pushAlerts 推送体与配置', () => {
  it('有告警：POST 同一份快照（含 source / generatedAt / monitored / alerts 与裁剪披露）', async () => {
    const snap = snapshot({ requested: 25, skipped: 5 });

    await expect(pushAlerts(snap, { source: 'monitor' })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      event: 'watchlist.alerts',
      source: 'monitor',
      generatedAt: '2026-11-26T10:00:00.000Z',
      monitored: 20,
      alerts: snap.alerts,
      requested: 25,
      skipped: 5,
    });
  });

  it('未发生上限裁剪时 body 不出现 requested / skipped（与快照契约一致）', async () => {
    await pushAlerts(snapshot(), { source: 'autonomous' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.source).toBe('autonomous');
    expect(body).not.toHaveProperty('requested');
    expect(body).not.toHaveProperty('skipped');
  });

  it('http:// 与 https:// 一样接受（只拒绝非 http/https 协议）', async () => {
    process.env.ALERT_WEBHOOK_URL = 'http://127.0.0.1:9999/hook';
    await pushAlerts(snapshot(), { source: 'monitor' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9999/hook');
  });

  it('无告警：不发起请求（定时巡检的常态，不该刷屏）', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await pushAlerts(snapshot({ alerts: [] }), { source: 'monitor' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ALERT_WEBHOOK_URL 为空 / 纯空白：显式关闭，不请求也不告警', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    for (const value of ['', '   ']) {
      process.env.ALERT_WEBHOOK_URL = value;
      await pushAlerts(snapshot(), { source: 'monitor' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('pushAlerts 最佳努力：失败不抛给调用方', () => {
  it('fetch 拒绝（网络错误）：只记 warning，pushAlerts 正常 resolve', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(pushAlerts(snapshot(), { source: 'monitor' })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ source: 'monitor' });
  });

  it('非 2xx：只记 warning（带状态码），pushAlerts 正常 resolve', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }));

    await expect(pushAlerts(snapshot(), { source: 'autonomous' })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ status: 502, source: 'autonomous' });
  });

  it('超时：注入 500ms，fetch 挂起时由 AbortSignal 断开并降级为 warning', async () => {
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = '500';
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const startedAt = Date.now();
    await expect(pushAlerts(snapshot(), { source: 'monitor' })).resolves.toBeUndefined();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(450); // 不早于注入的超时
    expect(elapsed).toBeLessThan(3000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('超时');
  });

  it('超时配置：空值/非数字回默认 3000，低于/高于范围夹紧到 500 / 10000', async () => {
    /** 用假计时器推进到「刚好差 1ms」再推进 1ms，钉住实际生效的超时值 */
    async function expectTimeoutAt(raw: string, expectedMs: number): Promise<void> {
      process.env.ALERT_WEBHOOK_TIMEOUT_MS = raw;
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      fetchMock.mockImplementation(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      vi.useFakeTimers();
      try {
        const pending = pushAlerts(snapshot(), { source: 'monitor' });
        await vi.advanceTimersByTimeAsync(expectedMs - 1);
        expect(warnSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    }

    await expectTimeoutAt('', 3000);
    await expectTimeoutAt('abc', 3000);
    await expectTimeoutAt('100', 500);
    await expectTimeoutAt('999999', 10000);
  });

  it('非法 URL：只告警一次，后续同值调用不再尝试 fetch', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    for (const bad of ['not a url', 'ftp://example.com/hook']) {
      process.env.ALERT_WEBHOOK_URL = bad;
      await pushAlerts(snapshot(), { source: 'monitor' });
      await pushAlerts(snapshot(), { source: 'autonomous' });
    }

    expect(fetchMock).not.toHaveBeenCalled();
    // 两个不同的非法值各告警一次；同一个值第二次调用不再告警
    expect(warnSpy).toHaveBeenCalledTimes(2);
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).toContain('不是合法的 http/https URL');
    }
  });
});

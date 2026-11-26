/**
 * /api/settings 路由契约与行为
 * ----------------------------------------------------------------------------
 * 覆盖：读写设置、非法输入 400、Webhook 脱敏回显、清除后回退 env、
 * 历史容量调低后立即裁剪、测试推送的成功/失败/未配置三种结果。
 * 所有 2xx 响应都经 withContract 按 OpenAPI 校验。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { partial } from '../test/partial.js';
import { withContract } from '../test/contractSupertest.js';
import type { AnalysisResult } from '../types.js';
import { closeHistoryStore, saveHistoryEntry } from '../services/historyService.js';
import { resetSettingsCache } from '../services/settings.js';

// 限流器在 app import 时按环境变量构造；hoisted 回调先于静态 import 执行，
// 避免本文件多组写操作把默认 10 次/分钟的配额打满（与真实部署阈值无关）。
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX_WRITE = '100';
  process.env.RATE_LIMIT_MAX_META = '100';
});

import { app } from '../index.js';

const wrapped = withContract(app);
const fetchMock = vi.fn();
const tmpDir = mkdtempSync(join(tmpdir(), 'settings-route-'));
const settingsFile = join(tmpDir, 'settings.json');
const historyFile = join(tmpDir, 'history.json');
const original = {
  settings: process.env.SETTINGS_FILE,
  url: process.env.ALERT_WEBHOOK_URL,
  timeout: process.env.ALERT_WEBHOOK_TIMEOUT_MS,
  history: process.env.HISTORY_FILE,
  historyMax: process.env.HISTORY_MAX_ITEMS,
};

beforeAll(() => {
  process.env.SETTINGS_FILE = settingsFile;
  process.env.HISTORY_FILE = historyFile;
});
afterAll(() => {
  closeHistoryStore();
  for (const [key, value] of [
    ['SETTINGS_FILE', original.settings],
    ['ALERT_WEBHOOK_URL', original.url],
    ['ALERT_WEBHOOK_TIMEOUT_MS', original.timeout],
    ['HISTORY_FILE', original.history],
    ['HISTORY_MAX_ITEMS', original.historyMax],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(settingsFile, { force: true });
  resetSettingsCache();
  delete process.env.ALERT_WEBHOOK_URL;
  delete process.env.ALERT_WEBHOOK_TIMEOUT_MS;
  delete process.env.HISTORY_MAX_ITEMS;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function entry(code: string) {
  return {
    stockCode: code,
    stockName: `股票${code}`,
    rating: '持续观察',
    totalScore: 60,
    result: partial<AnalysisResult>({ stock_pool: [] }),
  };
}

describe('GET /api/settings', () => {
  it('未配置时如实返回未配置与默认容量', async () => {
    const res = await request(wrapped).get('/api/settings').expect(200);
    expect(res.body).toEqual({
      alertWebhook: {
        configured: false,
        urlMasked: null,
        timeoutMs: 3000,
        source: 'none',
      },
      history: {
        maxItems: 2000,
        source: 'default',
        defaultMaxItems: 2000,
        hardMaxItems: 50_000,
      },
    });
  });

  it('只回脱敏地址，不泄露 key/token', async () => {
    process.env.ALERT_WEBHOOK_URL =
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=super-secret-key';
    const res = await request(wrapped).get('/api/settings').expect(200);
    expect(res.body.alertWebhook.configured).toBe(true);
    expect(res.body.alertWebhook.source).toBe('env');
    expect(res.body.alertWebhook.urlMasked).toBe('https://qyapi.weixin.qq.com/…');
    expect(JSON.stringify(res.body)).not.toContain('super-secret-key');
  });
});

describe('PUT /api/settings', () => {
  it('保存合法配置后立即生效并回显脱敏地址', async () => {
    const res = await request(wrapped)
      .put('/api/settings')
      .send({
        alertWebhook: {
          url: 'https://open.feishu.cn/open-apis/bot/v2/hook/token-abc',
          timeoutMs: 2500,
        },
        history: { maxItems: 800 },
      })
      .expect(200);

    expect(res.body.alertWebhook).toMatchObject({
      configured: true,
      source: 'settings',
      timeoutMs: 2500,
      urlMasked: 'https://open.feishu.cn/…',
    });
    expect(res.body.history).toMatchObject({ maxItems: 800, source: 'settings' });
    expect(JSON.stringify(res.body)).not.toContain('token-abc');

    const again = await request(wrapped).get('/api/settings').expect(200);
    expect(again.body).toEqual(res.body);
  });

  it('非法 URL / 越界容量返回 400 与可读错误', async () => {
    const badUrl = await request(wrapped)
      .put('/api/settings')
      .send({ alertWebhook: { url: 'ftp://example.com/hook' } })
      .expect(400);
    expect(badUrl.body.error).toMatch(/http/);

    const badType = await request(wrapped)
      .put('/api/settings')
      .send({ alertWebhook: { timeoutMs: 'fast' } })
      .expect(400);
    expect(badType.body.error).toMatch(/timeoutMs/);

    const badHistory = await request(wrapped)
      .put('/api/settings')
      .send({ history: { maxItems: 0 } })
      .expect(400);
    expect(badHistory.body.error).toMatch(/历史保留条数/);

    // 非法请求不应留下任何半写入配置
    const res = await request(wrapped).get('/api/settings').expect(200);
    expect(res.body.alertWebhook.configured).toBe(false);
    expect(res.body.history.maxItems).toBe(2000);
  });

  it('清除设置项后回退到环境变量', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://env.example.com/hook';
    await request(wrapped)
      .put('/api/settings')
      .send({ alertWebhook: { url: 'https://ui.example.com/hook' } })
      .expect(200);
    const cleared = await request(wrapped)
      .put('/api/settings')
      .send({ alertWebhook: { url: null, timeoutMs: null }, history: { maxItems: null } })
      .expect(200);
    expect(cleared.body.alertWebhook).toMatchObject({
      source: 'env',
      configured: true,
      urlMasked: 'https://env.example.com/…',
    });
    expect(cleared.body.history.source).toBe('default');
  });

  it('并发保存不同字段：互不覆盖，最终配置是三者并集', async () => {
    await Promise.all([
      request(wrapped)
        .put('/api/settings')
        .send({ alertWebhook: { url: 'https://a.example.com/hook' } })
        .expect(200),
      request(wrapped)
        .put('/api/settings')
        .send({ alertWebhook: { timeoutMs: 1500 } })
        .expect(200),
      request(wrapped)
        .put('/api/settings')
        .send({ history: { maxItems: 321 } })
        .expect(200),
    ]);

    const res = await request(wrapped).get('/api/settings').expect(200);
    expect(res.body.alertWebhook).toMatchObject({
      configured: true,
      urlMasked: 'https://a.example.com/…',
      timeoutMs: 1500,
      source: 'settings',
    });
    expect(res.body.history).toMatchObject({ maxItems: 321, source: 'settings' });
  });

  it('调低历史容量后立即裁剪现有记录', async () => {
    for (let i = 1; i <= 3; i++) {
      await saveHistoryEntry(entry(String(600100 + i)));
    }
    await request(wrapped)
      .put('/api/settings')
      .send({ history: { maxItems: 1 } })
      .expect(200);

    const history = await request(wrapped).get('/api/history?limit=10').expect(200);
    expect(history.body.items ?? history.body).toHaveLength(1);
  });

  it('请求体不是对象时返回 400', async () => {
    const res = await request(wrapped)
      .put('/api/settings')
      .set('Content-Type', 'application/json')
      .send('[]')
      .expect(400);
    expect(res.body.error).toMatch(/JSON 对象/);
  });
});

describe('POST /api/settings/alert-webhook/test', () => {
  it('未配置时返回 configured=false（200，不是请求错误）', async () => {
    const res = await request(wrapped).post('/api/settings/alert-webhook/test').expect(200);
    expect(res.body).toMatchObject({ sent: false, configured: false });
    expect(res.body.reason).toMatch(/尚未配置/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('已配置时走真实 POST 链路，2xx 记为成功', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://example.com/hook';
    const res = await request(wrapped).post('/api/settings/alert-webhook/test').expect(200);
    expect(res.body).toMatchObject({ sent: true, configured: true, status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    const payload = JSON.parse(String(init.body)) as {
      event: string;
      source: string;
      alerts: unknown[];
    };
    expect(payload.event).toBe('watchlist.alerts');
    expect(payload.source).toBe('settings');
    expect(payload.alerts).toHaveLength(1);
  });

  it('非 2xx 返回 sent=false 与上游状态码，而不是抛错', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://example.com/hook';
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const res = await request(wrapped).post('/api/settings/alert-webhook/test').expect(200);
    expect(res.body).toMatchObject({ sent: false, configured: true, status: 500 });
    expect(res.body.reason).toMatch(/HTTP 500/);
  });

  it('网络异常返回 sent=false 且提示未送达', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://example.com/hook';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(wrapped).post('/api/settings/alert-webhook/test').expect(200);
    expect(res.body).toMatchObject({ sent: false, configured: true });
    expect(res.body.reason).toMatch(/未送达/);
  });
});

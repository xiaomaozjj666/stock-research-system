import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 设置页真实交互 E2E
 * ----------------------------------------------------------------------------
 * 这里刻意**不用 page.route 打桩**：设置页的价值就在于“保存后服务端真的按新配置
 * 工作”。因此：
 *  - 测试进程里起一个真实 HTTP 接收端，服务端向它发真实 POST，断言收到的报文；
 *  - 失败路径用「接收端返回 500」与「端口无人监听」两种真实网络结果；
 *  - 历史容量用真实 SQLite 预置数据，保存后由服务端立即裁剪，再从 API 核对。
 *
 * 预置数据为什么直接写 SQLite：历史没有公开的“写入”接口（只有分析完成才入库），
 * 而这里要验证的是**设置→裁剪**这条服务端链路，不是分析链路。写入前先请求
 * /api/history 让服务端建库，随后外部连接在 WAL 下追加行，服务端下次读取可见。
 */

const tmpDir = path.join(import.meta.dirname, '.tmp');
const historyDb = path.join(tmpDir, 'history.db');
const settingsFile = path.join(tmpDir, 'settings.json');

interface Receiver {
  url: string;
  server: Server;
  bodies: string[];
}

/** 起一个只监听回环地址的接收端；status 决定它返回 2xx 还是 5xx */
function startReceiver(status = 200): Promise<Receiver> {
  return new Promise((resolve, reject) => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        bodies.push(body);
        res.statusCode = status;
        res.end('ok');
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/hook`, server, bodies });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 拿一个“确定没人监听”的端口：先监听再立即关闭 */
async function closedPortUrl(): Promise<string> {
  const probe = await startReceiver();
  const port = new URL(probe.url).port;
  await closeServer(probe.server);
  return `http://127.0.0.1:${port}/hook`;
}

async function openSettings(page: Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
}

function webhookCard(page: Page) {
  return page.locator('section.settings-card').filter({ hasText: '异动预警 Webhook' });
}

function historyCard(page: Page) {
  return page.locator('section.settings-card').filter({ hasText: '研究历史容量' });
}

async function saveWebhookUrl(page: Page, url: string) {
  const card = webhookCard(page);
  await card.getByLabel('Webhook 地址').fill(url);
  await card.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.settings-feedback.ok')).toHaveText('设置已保存并立即生效');
}

test.beforeEach(async ({ request }) => {
  // 每个用例从“未配置”开始，避免前一个用例的 Webhook/容量污染断言
  await request.put('/api/settings', {
    data: { alertWebhook: { url: null, timeoutMs: null }, history: { maxItems: null } },
  });
});

test.describe('设置页 — Webhook 真实推送', () => {
  test('保存地址后测试推送成功：服务端真实 POST，载荷与预警同形', async ({ page }) => {
    const receiver = await startReceiver(200);
    try {
      await openSettings(page);
      await saveWebhookUrl(page, receiver.url);

      const card = webhookCard(page);
      await expect(card.locator('.settings-current code')).toHaveText(
        new URL(receiver.url).origin + '/…',
      );
      await expect(card.locator('.settings-current')).toContainText('来源：设置页');

      await card.getByRole('button', { name: '发送测试推送' }).click();
      await expect(page.locator('.settings-feedback.ok')).toHaveText(
        '测试推送已发出，请检查接收端是否收到',
      );

      expect(receiver.bodies).toHaveLength(1);
      const payload = JSON.parse(receiver.bodies[0]) as {
        event: string;
        source: string;
        alerts: unknown[];
      };
      expect(payload.event).toBe('watchlist.alerts');
      expect(payload.source).toBe('settings');
      expect(payload.alerts).toHaveLength(1);
    } finally {
      await closeServer(receiver.server);
    }
  });

  test('接收端返回 500：如实提示未送达，不伪装成功', async ({ page }) => {
    const receiver = await startReceiver(500);
    try {
      await openSettings(page);
      await saveWebhookUrl(page, receiver.url);
      await webhookCard(page).getByRole('button', { name: '发送测试推送' }).click();
      const err = page.locator('.settings-feedback.err');
      await expect(err).toContainText('测试推送未送达');
      await expect(err).toContainText('HTTP 500');
    } finally {
      await closeServer(receiver.server);
    }
  });

  test('地址不可达：提示网络错误/超时，且页面不卡在发送中', async ({ page }) => {
    const url = await closedPortUrl();
    await openSettings(page);
    await saveWebhookUrl(page, url);
    const button = webhookCard(page).getByRole('button', { name: '发送测试推送' });
    await button.click();
    await expect(page.locator('.settings-feedback.err')).toContainText('网络错误或超时');
    // 测试按钮必须恢复可用（失败后不能永久禁用）
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('发送测试推送');
  });
});

test.describe('设置页 — 历史容量立即裁剪', () => {
  test('调低保留条数后服务端立即删除最旧记录，并持久化到设置文件', async ({ page, request }) => {
    // ① 让服务端先建库（此前的请求已初始化 historyService）
    await request.get('/api/history');

    // ② 真实 SQLite 预置 30 条：createdAt 递增，便于断言“保留最新”
    const db = new DatabaseSync(historyDb);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const insert = db.prepare(
        `INSERT OR REPLACE INTO history_items
           (id, stock_code, stock_name, industry, rating, total_score, created_at, result_json)
         VALUES (?, ?, ?, NULL, ?, ?, ?, '{}')`,
      );
      for (let i = 0; i < 30; i++) {
        insert.run(
          `seed-${i}`,
          String(610000 + i),
          `样本${i}`,
          '持续观察',
          60,
          new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        );
      }
    } finally {
      db.close();
    }

    const before = await request.get('/api/history?limit=200');
    expect(before.status()).toBe(200);
    expect((await before.json()).items).toHaveLength(30);

    // ③ 浏览器里改容量并保存
    await openSettings(page);
    const card = historyCard(page);
    await card.getByLabel('保留条数').fill('7');
    await card.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.settings-feedback.ok')).toHaveText('设置已保存并立即生效');
    await expect(card.locator('.settings-current')).toContainText('7 条');
    await expect(card.locator('.settings-current')).toContainText('来源：设置页');

    // ④ 立即生效：API 只剩最新 7 条，最旧的已被删除
    const after = await request.get('/api/history?limit=200');
    const items = (await after.json()).items as { stockCode: string }[];
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.stockCode)).toEqual([
      '610029',
      '610028',
      '610027',
      '610026',
      '610025',
      '610024',
      '610023',
    ]);

    // ⑤ 配置确实落盘（重启后仍然是 7）
    const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as {
      historyMaxItems?: number;
    };
    expect(persisted.historyMaxItems).toBe(7);
  });
});

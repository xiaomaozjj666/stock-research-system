/**
 * 自动刷新 README 核心界面截图（基于生产构建 + 隔离临时数据目录）
 *
 * 用法：
 *   npx tsx scripts/capture-screenshots.mts
 *
 * 说明：
 * - 启动本地生产模式服务（NODE_ENV=production node server/dist/index.js），不触碰 server/data/；
 * - 模拟盘与设置页直接调用真实后端 API 写入隔离临时文件，确保数据结构与线上契约 100% 一致；
 * - 刷新今日、自选股、模拟盘、研究历史、设置、量化研究等最新界面截图至 docs/screenshots/。
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* waiting */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not start in time: ${url}`);
}

async function postJson(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedRealBackendState(baseUrl: string): Promise<void> {
  // 1) 通过真实 API 添加自选股
  for (const code of ['600519', '300750', '000858', '600036']) {
    await postJson(`${baseUrl}/api/watchlist`, { code });
  }
  // 2) 通过真实 API 在模拟盘下单并日终撮合（初始资金 ¥100,000，遵循 A 股 T+1 / 整手 / 费率）
  await postJson(`${baseUrl}/api/paper/order`, {
    code: '600036',
    side: 'buy',
    type: 'market',
    quantity: 1000,
    date: '2026-11-18',
  });
  await postJson(`${baseUrl}/api/paper/settle`, {
    date: '2026-11-18',
    closePrices: { '600036': 36.2 },
  });
  await postJson(`${baseUrl}/api/paper/order`, {
    code: '300750',
    side: 'buy',
    type: 'market',
    quantity: 200,
    date: '2026-11-20',
  });
  await postJson(`${baseUrl}/api/paper/settle`, {
    date: '2026-11-20',
    closePrices: { '600036': 37.1, '300750': 238.5 },
  });
  await postJson(`${baseUrl}/api/paper/settle`, {
    date: '2026-11-24',
    closePrices: { '600036': 37.8, '300750': 246.2 },
  });
  await postJson(`${baseUrl}/api/paper/settle`, {
    date: '2026-11-27',
    closePrices: { '600036': 38.6, '300750': 254.0 },
  });
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'msedge' });
  } catch {
    return await chromium.launch();
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-shots-'));

  const serverProc = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'dist', 'index.js')], {
    cwd: path.join(REPO_ROOT, 'server'),
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      LOG_LEVEL: 'error',
      RATE_LIMIT_MAX_WRITE: '1000',
      WATCHLIST_FILE: path.join(tmpDir, 'watchlist.json'),
      PAPER_TRADING_FILE: path.join(tmpDir, 'paperTrading.json'),
      THESIS_FILE: path.join(tmpDir, 'theses.json'),
      DATA_CACHE_DIR: path.join(tmpDir, 'cache'),
      AUDIT_LOG_FILE: path.join(tmpDir, 'audit.log'),
      HISTORY_FILE: path.join(tmpDir, 'history.json'),
      HISTORY_DB_FILE: path.join(tmpDir, 'history.db'),
      SETTINGS_FILE: path.join(tmpDir, 'settings.json'),
    },
  });

  try {
    await waitForReady(`${baseUrl}/`);
    await seedRealBackendState(baseUrl);

    const browser = await launchBrowser();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();

    const nowIso = new Date().toISOString();

    // 仅对外部行情/推送快照接口提供确定性演示数据；自选股/模拟盘/设置均走真实后端
    await page.route('**/api/watchlist/alerts', (route) =>
      route.fulfill({
        json: {
          generatedAt: nowIso,
          monitored: 4,
          alerts: [
            {
              code: '600519',
              name: '贵州茅台',
              level: 'strong-bull',
              polarity: 0.78,
              weightedImpact: 0.42,
              detail: '贵州茅台 Q3 现金流超预期，直销渠道占比继续抬升（polarity=0.78）',
            },
            {
              code: '300750',
              name: '宁德时代',
              level: 'high-impact',
              polarity: 0.56,
              weightedImpact: 0.36,
              detail: '宁德时代 海外储能大单落地，毛利率环比稳中有升',
            },
            {
              code: '000858',
              name: '五粮液',
              level: 'strong-bear',
              polarity: -0.61,
              weightedImpact: 0.29,
              detail: '五粮液 批价短期承压，渠道去库节奏需继续跟踪',
            },
          ],
        },
      }),
    );

    await page.route('**/api/quant/digests**', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 'digest-demo-1',
              createdAt: nowIso,
              screener: {
                hitCount: 14,
                topHits: [
                  { code: '600519', name: '贵州茅台' },
                  { code: '300750', name: '宁德时代' },
                  { code: '600036', name: '招商银行' },
                ],
              },
            },
          ],
        },
      }),
    );

    await page.route('**/api/history**', (route) =>
      route.fulfill({
        json: {
          total: 4,
          items: [
            {
              id: 'hist-1',
              stockCode: '600519',
              stockName: '贵州茅台',
              industry: '白酒',
              rating: '重点关注',
              totalScore: 74,
              createdAt: nowIso,
              timeline: [
                { date: '2026-11-12', score: 68, rating: '持续观察' },
                { date: '2026-11-27', score: 74, rating: '重点关注' },
              ],
            },
            {
              id: 'hist-2',
              stockCode: '300750',
              stockName: '宁德时代',
              industry: '电池',
              rating: '重点关注',
              totalScore: 79,
              createdAt: new Date(Date.now() - 86_400_000).toISOString(),
              timeline: [
                { date: '2026-11-10', score: 73, rating: '持续观察' },
                { date: '2026-11-26', score: 79, rating: '重点关注' },
              ],
            },
            {
              id: 'hist-3',
              stockCode: '000858',
              stockName: '五粮液',
              industry: '白酒',
              rating: '持续观察',
              totalScore: 65,
              createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
              timeline: [
                { date: '2026-11-08', score: 69, rating: '持续观察' },
                { date: '2026-11-25', score: 65, rating: '持续观察' },
              ],
            },
            {
              id: 'hist-4',
              stockCode: '600036',
              stockName: '招商银行',
              industry: '银行',
              rating: '重点关注',
              totalScore: 76,
              createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
              timeline: [
                { date: '2026-11-05', score: 75, rating: '重点关注' },
                { date: '2026-11-24', score: 76, rating: '重点关注' },
              ],
            },
          ],
        },
      }),
    );

    await page.route('**/api/quant/universe/boards', (route) =>
      route.fulfill({
        json: {
          boards: [
            { code: 'BK0477', name: '白酒' },
            { code: 'BK0437', name: '银行' },
            { code: 'BK1033', name: '电池' },
          ],
          stale: false,
        },
      }),
    );

    await page.route('**/api/quant/health', (route) =>
      route.fulfill({
        json: {
          ok: true,
          checks: [
            { key: 'eastmoney', ok: true, detail: '主通道可用' },
            { key: 'cache', ok: true, detail: '本地行情缓存就绪' },
          ],
          degraded: [],
          checkedAt: nowIso,
          tushare: { configured: false },
          baostock: { available: false },
        },
      }),
    );

    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // 1) 「今日」聚合页（异动 + 关注股观点变化 + 最近研究简报）
    await page.getByRole('tab', { name: '今日' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT_DIR, 'today-dashboard.png') });
    console.log('wrote today-dashboard.png');

    // 2) 「自选股」页（真实后端 4 只关注股 + 异动预警）
    await page.getByRole('tab', { name: '自选股' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT_DIR, 'shot-watchlist.png') });
    console.log('wrote shot-watchlist.png');

    // 3) 「模拟盘」页（真实撮合引擎 + 净值曲线 + 持仓明细）
    await page.getByRole('tab', { name: '模拟盘' }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT_DIR, 'shot-paper.png') });
    console.log('wrote shot-paper.png');

    // 4) 「研究历史」页（SQLite 持久层）
    await page.getByRole('tab', { name: '历史' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT_DIR, 'shot-history.png') });
    console.log('wrote shot-history.png');

    // 5) 「设置」页（运行时 Webhook + 研究历史容量）
    await page.getByRole('tab', { name: '设置' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT_DIR, 'settings-page.png') });
    console.log('wrote settings-page.png');

    // 6) 「量化研究」页（移除模拟 digests 拦截，使用真实后端响应展示最新 3 模式界面）
    await page.unroute('**/api/quant/digests**');
    await page.getByRole('tab', { name: '量化研究' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT_DIR, 'quant-backtest.png') });
    console.log('wrote quant-backtest.png');

    await browser.close();
  } finally {
    serverProc.kill();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore temp cleanup on Windows */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

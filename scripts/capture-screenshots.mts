/**
 * 自动刷新 README 核心界面截图（基于生产构建 + 隔离临时数据目录）
 *
 * 用法：
 *   npx tsx scripts/capture-screenshots.mts
 *
 * 说明：
 * - 启动本地生产模式服务（NODE_ENV=production node server/dist/index.js），不触碰 server/data/；
 * - 量化回测直接点击「开始研究」执行真实 A 股（600519）全链路回测与防过拟合审计；
 * - 模拟盘与自选股直接调用真实后端 API 写入隔离临时文件（含真实波动与回撤的 10 个交易日撮合）；
 * - 刷新量化回测、模拟盘、对比分析、今日、自选股、研究历史、设置等最新截图至 docs/screenshots/。
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
  // 2) 通过真实 API 在模拟盘下单并完成 10 个交易日撮合（含真实回撤波动，遵循 A 股 T+1 / 整手 / 费率）
  await postJson(`${baseUrl}/api/paper/order`, {
    code: '600036',
    side: 'buy',
    type: 'market',
    quantity: 1000,
    date: '2026-11-10',
  });
  await postJson(`${baseUrl}/api/paper/settle`, {
    date: '2026-11-10',
    closePrices: { '600036': 36.4 },
  });
  await postJson(`${baseUrl}/api/paper/order`, {
    code: '300750',
    side: 'buy',
    type: 'market',
    quantity: 200,
    date: '2026-11-12',
  });
  const dailyCloses: Array<[string, Record<string, number>]> = [
    ['2026-11-12', { '600036': 36.9, '300750': 239.0 }],
    ['2026-11-13', { '600036': 37.3, '300750': 243.5 }],
    ['2026-11-16', { '600036': 36.6, '300750': 236.2 }],
    ['2026-11-17', { '600036': 36.1, '300750': 232.8 }],
    ['2026-11-18', { '600036': 36.8, '300750': 237.4 }],
    ['2026-11-19', { '600036': 37.2, '300750': 241.0 }],
    ['2026-11-20', { '600036': 37.0, '300750': 239.6 }],
    ['2026-11-23', { '600036': 37.5, '300750': 244.8 }],
    ['2026-11-25', { '600036': 37.9, '300750': 247.5 }],
    ['2026-11-27', { '600036': 38.4, '300750': 251.2 }],
  ];
  for (const [date, closePrices] of dailyCloses) {
    await postJson(`${baseUrl}/api/paper/settle`, { date, closePrices });
  }
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
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();

    const nowIso = new Date().toISOString();

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

    // 1) 「今日」聚合页
    await page.getByRole('tab', { name: '今日' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT_DIR, 'today-dashboard.png') });
    console.log('wrote today-dashboard.png');

    // 2) 「自选股」页
    await page.getByRole('tab', { name: '自选股' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT_DIR, 'shot-watchlist.png') });
    console.log('wrote shot-watchlist.png');

    // 3) 「模拟盘」页（10 个交易日真实撮合 + 合理回撤/夏普 + 完整持仓表 + 净值曲线）
    await page.getByRole('tab', { name: '模拟盘' }).click();
    await page.waitForTimeout(1200);
    await page.setViewportSize({ width: 1440, height: 1360 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, 'shot-paper.png') });
    console.log('wrote shot-paper.png');
    await page.setViewportSize({ width: 1440, height: 960 });

    // 4) 「研究历史」页
    await page.getByRole('tab', { name: '历史' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT_DIR, 'shot-history.png') });
    console.log('wrote shot-history.png');

    // 5) 「设置」页
    await page.getByRole('tab', { name: '设置' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT_DIR, 'settings-page.png') });
    console.log('wrote settings-page.png');

    // 6) 「量化研究」页：真实点击「开始研究」跑完 600519 近两年均线交叉回测 + 防过拟合审计
    await page.unroute('**/api/quant/digests**');
    await page.getByRole('tab', { name: '量化研究' }).click();
    await page.waitForTimeout(900);
    const runBtn = page.getByRole('button', { name: /开始研究/ }).first();
    await runBtn.click();
    await page.waitForSelector('canvas', { timeout: 45_000 });
    await page.waitForTimeout(1800);
    await page.setViewportSize({ width: 1440, height: 1120 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, 'quant-backtest.png') });
    console.log('wrote quant-backtest.png (real 600519 backtest equity curve + audit)');

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

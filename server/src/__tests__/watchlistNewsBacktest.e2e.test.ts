import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../index.js';
import type { OHLCVData } from '../quant/types.js';
import type { NewsSignal } from '../quant/newsSignal.js';

/**
 * 批量回测路由 —— 端到端集成测试
 * ----------------------------------------------------------------------------
 * 与 routes.test.ts（mock watchlistService 的纯路由契约）不同，本测试**不 mock 任何业务服务**：
 * 真实跑通  route → watchlistBacktest → strategyListEngine → backtestEngine → 新闻叠加层。
 * 仅 mock 三个网络/IO 边界，使其在无网沙箱中确定性可跑：
 *   - dataProvider.fetchOHLCVData（行情 K 线）
 *   - newsSignal.extractNewsSignal（实时新闻情绪）
 *   - stockMaster.loadStockMaster（主数据名称反查）
 * 这样能同时验证：报告级契约、每只 3 策略、最优策略摘要、含新闻姿态(newsAware.posture)、
 * 以及单只取数失败的错误隔离。
 */

// 用 vi.hoisted 预创建 mock，确保 vi.mock 工厂可引用（避免 TDZ）
const mocks = vi.hoisted(() => ({
  fetchOHLCVData: vi.fn(),
  getBenchmarkCurve: vi.fn(() => []),
  extractNewsSignal: vi.fn(),
  loadStockMaster: vi.fn(),
}));

/** 生成确定性的合成日 K 线（带轻微波动的上升趋势，足够策略产生交易） */
function makeOHLCV(code: string): OHLCVData[] {
  const n = 120;
  const out: OHLCVData[] = [];
  let price = 50;
  const seed = parseInt(code.slice(-2), 10) || 1;
  const start = new Date(Date.UTC(2024, 0, 1));
  for (let i = 0; i < n; i++) {
    const change = Math.sin(i / 7 + seed) * 0.02 + 0.0015;
    price = Math.max(5, price * (1 + change));
    const open = price / (1 + change);
    const high = Math.max(open, price) * 1.01;
    const low = Math.min(open, price) * 0.99;
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    out.push({
      date: d.toISOString().slice(0, 10),
      open: +open.toFixed(2),
      close: +price.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      volume: 1_000_000,
    });
  }
  return out;
}

const BULLISH: NewsSignal = {
  polarity: 0.6,
  sentimentZ: 0.5,
  bullishRatio: 0.7,
  newsCount: 3,
  freshness: 0.8,
  weightedImpact: 0.5,
  items: [{ id: 'n1', title: '超预期增长', publishedAt: new Date().toISOString() }],
  hasNews: true,
};
const NEUTRAL: NewsSignal = {
  polarity: 0,
  sentimentZ: 0,
  bullishRatio: 0,
  newsCount: 0,
  freshness: 0,
  weightedImpact: 0,
  items: [],
  hasNews: false,
};

vi.mock('../quant/dataProvider.js', () => ({
  fetchOHLCVData: mocks.fetchOHLCVData,
  getBenchmarkCurve: mocks.getBenchmarkCurve,
}));

vi.mock('../quant/newsSignal.js', () => ({
  extractNewsSignal: mocks.extractNewsSignal,
  aggregateNewsSentiment: vi.fn(() => ({ ...NEUTRAL })),
  fetchLatestNews: vi.fn(async () => []),
  lexiconPolarity: vi.fn(() => 0),
  NEWS_MODEL_CONSTANTS: { RECENCY_LAMBDA: 0.12, Z_CLIP: 0.001, HALF_LIFE_DAYS: 5.8 },
}));

vi.mock('../services/stockMaster.js', () => ({
  loadStockMaster: mocks.loadStockMaster,
  getSupportedStocks: vi.fn(() => []),
  searchStocks: vi.fn(() => []),
}));

// 测试隔离：把 watchlist 持久化重定向到临时文件，避免污染真实数据
// （曾导致 server/src/data/watchlist.json 残留 600519，进而让"空清单→400"测试误判）。
const _watchlistTmpDir = mkdtempSync(join(tmpdir(), 'watchlist-e2e-'));
beforeAll(() => {
  process.env.WATCHLIST_FILE = join(_watchlistTmpDir, 'watchlist.json');
});
afterAll(() => {
  delete process.env.WATCHLIST_FILE;
  rmSync(_watchlistTmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 默认：所有代码都能取到行情；仅 600519 命中最新消息（看多）
  mocks.fetchOHLCVData.mockImplementation((code: string) => Promise.resolve(makeOHLCV(code)));
  mocks.extractNewsSignal.mockImplementation((code: string) =>
    Promise.resolve({
      signal: code === '600519' ? BULLISH : NEUTRAL,
      source: code === '600519' ? 'live' : 'none',
    }),
  );
  mocks.loadStockMaster.mockResolvedValue([
    { code: '600519', name: '贵州茅台' },
    { code: '000001', name: '平安银行' },
    { code: '300750', name: '宁德时代' },
  ] as any);
});

function indexByCode(results: Array<{ code: string }>): Record<string, any> {
  const m: Record<string, any> = {};
  for (const r of results) m[r.code] = r;
  return m;
}

describe('POST /api/watchlist/news-backtest —— 端到端（route→service→engine 真实链路）', () => {
  it('真实跑通全链路，返回完整报告契约', async () => {
    const res = await request(app)
      .post('/api/watchlist/news-backtest')
      .send({ codes: ['600519', '000001', '300750'] });

    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.count).toBe(3);
    expect(body.withNewsCount).toBe(1);
    expect(typeof body.generatedAt).toBe('string');

    const byCode = indexByCode(body.results);
    expect(Object.keys(byCode).sort()).toEqual(['000001', '300750', '600519']);

    // 每只都有 3 个策略推荐 + 最优策略摘要
    for (const code of ['600519', '000001', '300750']) {
      const r = byCode[code];
      expect(Array.isArray(r.strategyList)).toBe(true);
      expect(r.strategyList.length).toBe(3);
      expect(r.bestStrategy).toBeDefined();
      expect(Number.isFinite(r.bestStrategy.sharpeRatio)).toBe(true);
    }

    // 有新闻的 600519：newsSentiment 存在 + newsAware 姿态 = clamp(0.5+0.5·0.6)=0.8
    const moutai = byCode['600519'];
    expect(moutai.newsSentiment?.hasNews).toBe(true);
    expect(moutai.newsSentiment.polarity).toBeCloseTo(0.6, 5);
    expect(moutai.bestStrategy.newsAware).toBeDefined();
    const posture = moutai.bestStrategy.newsAware.posture;
    expect(posture).toBeGreaterThan(0);
    expect(posture).toBeLessThanOrEqual(1);
    expect(posture).toBeCloseTo(0.8, 1);

    // 无新闻的 000001：newsSentiment 为 null，最优策略无 newsAware（未叠加新闻仓位）
    const pingan = byCode['000001'];
    expect(pingan.newsSentiment).toBeNull();
    expect(pingan.bestStrategy.newsAware).toBeUndefined();
  });

  it('单只取数失败不影响其余（错误隔离）', async () => {
    mocks.fetchOHLCVData.mockImplementation((code: string) => {
      if (code === '000001') return Promise.reject(new Error('行情接口不可达'));
      return Promise.resolve(makeOHLCV(code));
    });

    const res = await request(app)
      .post('/api/watchlist/news-backtest')
      .send({ codes: ['600519', '000001', '300750'] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    const byCode = indexByCode(res.body.results);
    expect(typeof byCode['000001'].error).toBe('string');
    expect(byCode['600519'].error).toBeUndefined();
    expect(byCode['300750'].error).toBeUndefined();
    // 失败的那只仍可正常返回（带 error 字段），未污染其余结果
    expect(byCode['600519'].bestStrategy).toBeDefined();
  });

  it('清单为空 → 400', async () => {
    const res = await request(app).post('/api/watchlist/news-backtest').send({ codes: [] });
    expect(res.status).toBe(400);
  });

  it('单次超过 20 只 → 400', async () => {
    const codes = Array.from({ length: 21 }, (_, i) => String(600000 + i).padStart(6, '0'));
    const res = await request(app).post('/api/watchlist/news-backtest').send({ codes });
    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import type { OHLCVData } from '../quant/types.js';
import type { FinancialData } from '../types.js';

// 实验台账落盘重定向到临时文件（真实台账模块仍参与集成，避免污染项目 data/）
process.env.FACTOR_LEDGER_FILE = path.join(
  os.tmpdir(),
  `factor-ledger-routes-test-${process.pid}.json`,
);

// ============================================================================
// 量化因子路由集成测试：/api/quant/factor/composite、/composite/batch、
// /factor/cross-section、/api/quant/universe/boards。
//
// 隔离策略：外部数据面全部 mock（K 线/财务/季度财报/板块 universe/组合服务），
// 路由层的参数校验、状态码语义、universe 解析与降级披露走真实代码。
// quantLimiter（5 req/min 无 env 覆盖）在模块层替换为直通中间件——本文件用例数
// 远超 5 个，不替换会相互挤占限额导致 429；circuitBreakerGuard 等保持真实实现。
// ============================================================================

vi.mock('../middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware.js')>();
  return {
    ...actual,
    quantLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../quant/compositeService.js', () => ({
  computeCompositeAlphaForStrategy: vi.fn(),
  computeCompositeAlphaBatch: vi.fn(),
}));
vi.mock('../services/dataFetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dataFetcher.js')>();
  return { ...actual, fetchFinancialData: vi.fn() };
});
vi.mock('../quant/dataProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/dataProvider.js')>();
  return { ...actual, fetchOHLCVData: vi.fn() };
});
vi.mock('../quant/universeProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/universeProvider.js')>();
  return {
    ...actual,
    fetchIndustryBoardsWithMeta: vi.fn(),
    fetchBoardConstituentsWithMeta: vi.fn(),
  };
});
vi.mock('../services/quarterlyFinancials.js', () => ({
  fetchQuarterlyFinancials: vi.fn(),
}));
vi.mock('../quant/eventProvider.js', () => ({
  fetchStockEvents: vi.fn(),
}));
vi.mock('../quant/marginProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../quant/marginProvider.js')>()),
  fetchMarginSeries: vi.fn(),
}));
vi.mock('../quant/baostockBridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../quant/baostockBridge.js')>()),
  fetchIndexConstituentsCached: vi.fn(),
  baostockHealth: vi.fn(async () => ({ available: false, detail: 'mocked' })),
}));
// 预检会真的探测行情源：测试环境无外网，替换为直通结果（预检自身逻辑在
// preflight.test.ts 单独覆盖）
vi.mock('../quant/preflight.js', () => ({
  runPreflight: vi.fn(async () => ({
    ok: true,
    checks: [
      { key: 'upstream', ok: true, detail: 'ok' },
      { key: 'upstream_list', ok: true, detail: 'ok' },
      { key: 'llm', ok: true, detail: 'ok' },
      { key: 'cache', ok: true, detail: 'ok' },
    ],
    degraded: [],
    checkedAt: new Date().toISOString(),
  })),
}));

import { app } from '../index.js';
import {
  computeCompositeAlphaForStrategy,
  computeCompositeAlphaBatch,
} from '../quant/compositeService.js';
import { fetchFinancialData } from '../services/dataFetcher.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import {
  fetchIndustryBoardsWithMeta,
  fetchBoardConstituentsWithMeta,
} from '../quant/universeProvider.js';
import { fetchQuarterlyFinancials } from '../services/quarterlyFinancials.js';
import type { QuarterlySeries } from '../services/quarterlyFinancials.js';
import { fetchStockEvents } from '../quant/eventProvider.js';
import { fetchMarginSeries } from '../quant/marginProvider.js';
import { fetchIndexConstituentsCached } from '../quant/baostockBridge.js';

const mockedComposite = vi.mocked(computeCompositeAlphaForStrategy);
const mockedBatch = vi.mocked(computeCompositeAlphaBatch);
const mockedFinancial = vi.mocked(fetchFinancialData);
const mockedBars = vi.mocked(fetchOHLCVData);
const mockedBoardsMeta = vi.mocked(fetchIndustryBoardsWithMeta);
const mockedConstituentsMeta = vi.mocked(fetchBoardConstituentsWithMeta);
const mockedQuarterly = vi.mocked(fetchQuarterlyFinancials);
const mockedEvents = vi.mocked(fetchStockEvents);
const mockedMargin = vi.mocked(fetchMarginSeries);
const mockedIndexCons = vi.mocked(fetchIndexConstituentsCached);

/** 6 只成分股（截面 / 表达式用例共用） */
const CONST_SIX = ['600519', '000858', '603288', '600809', '000568', '600702'].map((code, i) => ({
  code,
  name: `股票${i}`,
  marketCap: 1000 - i,
}));

beforeEach(() => {
  vi.mocked(computeCompositeAlphaForStrategy).mockReset();
  vi.mocked(computeCompositeAlphaBatch).mockReset();
  mockedFinancial.mockReset();
  mockedBars.mockReset();
  mockedBoardsMeta.mockReset();
  mockedConstituentsMeta.mockReset();
  mockedQuarterly.mockReset();
  mockedEvents.mockReset();
  // 默认空事件捆绑：不影响既有用例的事件族缺席语义
  mockedEvents.mockResolvedValue({ dividend: [], buyback: [], unlock: [], dragonTiger: [] });
  mockedMargin.mockReset();
  // 默认空两融序列：两融因子缺席，与既有用例口径一致
  mockedMargin.mockResolvedValue([]);
  mockedIndexCons.mockReset();
});

/** n 根日频 K 线；按代码给不同漂移，保证截面有真实的横截面差异 */
function genBars(code: string, n = 400, start = '2024-01-01'): OHLCVData[] {
  const drift = (((parseInt(code, 10) || 7) % 7) - 3) * 0.0004;
  const out: OHLCVData[] = [];
  const d = new Date(start);
  let close = 100 * (1 + drift);
  for (let i = 0; i < n; i++) {
    close *= 1 + 0.004 * Math.sin(i * 0.3) + drift + 0.001;
    out.push({
      date: d.toISOString().slice(0, 10),
      open: Math.round(close * 100) / 100,
      high: Math.round(close * 101) / 100,
      low: Math.round(close * 99) / 100,
      close: Math.round(close * 100) / 100,
      volume: 1_000_000,
    });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function makeFinancial(code: string): FinancialData {
  const bump = ((parseInt(code, 10) || 7) % 5) + 1;
  return {
    years: ['2023', '2024'],
    revenue: [100, 120],
    netProfit: [20, 30],
    grossMargin: [50, 50 + bump],
    netMargin: [20, 25],
    roe: [10, 10 + bump],
    operatingCashFlow: [10, 15],
    eps: [1, 1.5],
    totalAssets: [200, 220],
    totalLiabilities: [80, 90],
    equity: [120, 130],
    accountsReceivable: [5, 6],
    inventory: [4, 5],
    goodwill: [0, 0],
    debtRatio: [40, 41],
    dataQuality: { estimatedFields: [], missingFields: [] },
  };
}

/** 四年报告期链（2021-2024），2024 两期带公告日；净利按代码缩放保证截面差异 */
function makeQuarterly(code: string): QuarterlySeries {
  const scale = 1 + ((parseInt(code, 10) || 7) % 5) * 0.1;
  const r = (date: string, np: number, notice?: string) => ({
    reportDate: date,
    noticeDate: notice ?? `${date.slice(0, 4)}-04-22`,
    revenue: np * 10,
    netProfit: np * scale,
    roe: 10 + np / 10,
    grossMargin: 50,
    debtRatio: 40,
    revenueYoY: 10,
    netProfitYoY: 10,
  });
  return {
    code,
    source: 'eastmoney_f10',
    reports: [
      r('2021-03-31', 4),
      r('2021-06-30', 9),
      r('2021-09-30', 15),
      r('2021-12-31', 22),
      r('2022-03-31', 5),
      r('2022-06-30', 11),
      r('2022-09-30', 18),
      r('2022-12-31', 26),
      r('2023-03-31', 6),
      r('2023-06-30', 13),
      r('2023-09-30', 21),
      r('2023-12-31', 30),
      r('2024-03-31', 8, '2024-04-20'),
      r('2024-06-30', 17, '2024-08-05'),
    ],
  };
}

const compositeResult = (code: string, horizons: number[]) => ({
  stockCode: code,
  market: 'A' as const,
  benchmarkSecid: '1.000300',
  horizons,
  compositeAlpha: {
    horizons: [],
    hasSignal: false,
    overallDirection: 'neutral' as const,
    overallAlpha: 0,
  },
  factorPredictability: [],
  bars: 400,
  dataRange: { start: '2024-01-01', end: '2025-03-01' },
  benchmarkAvailable: true,
});

describe('POST /api/quant/factor/composite', () => {
  it('缺 stockCode → 400', async () => {
    const res = await request(app).post('/api/quant/factor/composite').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('stockCode');
  });

  it('K 线不可得（服务抛「无法获取」）→ 422 数据问题语义', async () => {
    mockedComposite.mockRejectedValue(new Error('无法获取股票 999999 的K线数据'));
    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ stockCode: '999999' });
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain('无法获取');
  });

  it('合法请求 → 200 且 horizons 透传', async () => {
    mockedComposite.mockResolvedValue(compositeResult('600519', [7, 30]) as never);
    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ stockCode: '600519', horizons: [7, 30] });
    expect(res.status).toBe(200);
    expect(res.body.stockCode).toBe('600519');
    expect(res.body.horizons).toEqual([7, 30]);
    expect(mockedComposite).toHaveBeenCalledWith(
      '600519',
      expect.any(String),
      expect.any(String),
      [7, 30],
    );
  });
});

describe('POST /api/quant/factor/composite/batch', () => {
  it('缺 stockCodes / 超 20 只 → 400 / 413', async () => {
    const res400 = await request(app).post('/api/quant/factor/composite/batch').send({});
    expect(res400.status).toBe(400);
    const res413 = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: Array.from({ length: 21 }, (_, i) => `60051${i % 10}`) });
    expect(res413.status).toBe(413);
  });

  it('单只失败不拖垮整批：ok/失败项按输入顺序返回', async () => {
    mockedBatch.mockResolvedValue({
      requested: 2,
      succeeded: 1,
      failed: 1,
      items: [
        { stockCode: '600519', ok: true, result: compositeResult('600519', [21, 63]) as never },
        { stockCode: '000000', ok: false, error: '无法获取股票 000000 的K线数据' },
      ],
      startDate: '2024-01-01',
      endDate: '2025-03-01',
      horizons: [21, 63],
    });
    const res = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519', '000000'] });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.items.map((it: { stockCode: string }) => it.stockCode)).toEqual([
      '600519',
      '000000',
    ]);
    expect(res.body.items[1].ok).toBe(false);
  });
});

describe('POST /api/quant/factor/cross-section — 参数校验', () => {
  it('codes 少于 2 只 / 超过默认上限（300）→ 400', async () => {
    const one = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ codes: ['600519'] });
    expect(one.status).toBe(400);
    expect(one.body.error).toContain('2-300');
    // 上限已从 30 放开到 300（QUANT_CROSS_SECTION_MAX_CODES 可配）：超过上限才拒绝
    const many = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({
        codes: Array.from({ length: 301 }, (_, i) => `6005${String(i % 100).padStart(2, '0')}`),
      });
    expect(many.status).toBe(400);
    expect(many.body.error).toContain('2-300');
  });

  it('31 只（旧上限 30 之外）现已被接受 → 200', async () => {
    mockedBars.mockImplementation((code: string) => Promise.resolve(genBars(code)));
    mockedFinancial.mockImplementation((code: string) => Promise.resolve(makeFinancial(code)));
    mockedQuarterly.mockImplementation((code: string) => Promise.resolve(makeQuarterly(code)));

    const codes = Array.from({ length: 31 }, (_, i) => `6005${String(i % 100).padStart(2, '0')}`);
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ codes, horizons: [21] });
    expect(res.status).toBe(200);
    expect(res.body.universe.source).toBe('codes');
    expect(res.body.universe.requested).toBe(31);
  });

  it('QUANT_CROSS_SECTION_MAX_CODES 覆盖宽度上限', async () => {
    const orig = process.env.QUANT_CROSS_SECTION_MAX_CODES;
    process.env.QUANT_CROSS_SECTION_MAX_CODES = '5';
    try {
      const six = await request(app)
        .post('/api/quant/factor/cross-section')
        .send({ codes: ['600519', '000858', '603288', '600809', '000568', '600702'] });
      expect(six.status).toBe(400);
      expect(six.body.error).toContain('2-5');
    } finally {
      if (orig === undefined) delete process.env.QUANT_CROSS_SECTION_MAX_CODES;
      else process.env.QUANT_CROSS_SECTION_MAX_CODES = orig;
    }
  });

  it('codes 含非 6 位代码 → 400 且指明代码', async () => {
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ codes: ['600519', 'AAPL'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('AAPL');
  });

  it('board 非法 / topN 越界 → 400', async () => {
    const badBoard = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'XX1' });
    expect(badBoard.status).toBe(400);
    expect(badBoard.body.error).toContain('板块代码');
    const badTopN = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475', topN: 2 });
    expect(badTopN.status).toBe(400);
    expect(badTopN.body.error).toContain('topN');
  });
});

describe('POST /api/quant/factor/cross-section — board universe 拉宽', () => {
  const CONSTITUENTS = ['600519', '000858', '603288', '600809', '000568', '600702'].map(
    (code, i) => ({ code, name: `股票${i}`, marketCap: 1000 - i }),
  );

  beforeEach(() => {
    mockedConstituentsMeta.mockResolvedValue({ value: CONSTITUENTS, stale: false });
    mockedBars.mockImplementation((code: string) => Promise.resolve(genBars(code)));
    mockedFinancial.mockImplementation((code: string) => Promise.resolve(makeFinancial(code)));
    mockedQuarterly.mockImplementation((code: string) => Promise.resolve(makeQuarterly(code)));
  });

  it('happy path → universe 回显、三族因子齐备、horizons 透传', async () => {
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'bk0475', topN: 6, horizons: [21, 63] });
    expect(res.status).toBe(200);
    expect(res.body.universe.source).toBe('board');
    expect(res.body.universe.board).toBe('BK0475'); // 大小写归一
    expect(res.body.universe.constituents).toHaveLength(6);
    expect(res.body.stocksIncluded).toHaveLength(6);
    expect(res.body.stocksSkipped).toEqual([]);
    expect(res.body.horizons).toEqual([21, 63]);

    const types = new Set(res.body.factors.map((f: { type: string }) => f.type));
    expect(types.has('price_volume')).toBe(true);
    expect(types.has('fundamental')).toBe(true);
    expect(types.has('event')).toBe(true);
    // 基本面因子含季度派生键
    const names = res.body.factors.map((f: { name: string }) => f.name);
    expect(names).toContain('cs_np_yoy_q');
    expect(names).toContain('cs_roe_slope');
    expect(names).toContain('ev_earnings_surprise');
    // 每个 factor report 都带逐持有期 OOS 与判定
    for (const f of res.body.factors) {
      expect(f.report.periods).toEqual([21, 63]);
      for (const p of f.report.byPeriod) {
        expect(p.oos).toHaveProperty('stable');
        expect(p.verdict).toHaveProperty('effective');
      }
    }
  });

  it('成分股获取失败 → 502（不编造 universe）', async () => {
    mockedConstituentsMeta.mockRejectedValue(new Error('上游超时'));
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475' });
    expect(res.status).toBe(502);
    expect(res.body.detail).toContain('上游超时');
  });

  it('上游失败但有磁盘快照 → 回落陈旧成分股、200 且如实披露 stale', async () => {
    // 模拟「远端失败，但 provider 内部回落磁盘陈旧快照」的语义：route 收到的
    // 是 stale=true 的包裹，不应再 502，且 universe.stale 透传给前端
    mockedConstituentsMeta.mockResolvedValue({
      value: CONSTITUENTS,
      stale: true,
      staleAgeMs: 3 * 60 * 60 * 1000,
    });
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475', topN: 6 });
    expect(res.status).toBe(200);
    expect(res.body.universe.stale).toBe(true);
    expect(res.body.universe.staleAgeMs).toBeGreaterThan(0);
  });

  it('有效成分股不足 2 只 → 422', async () => {
    mockedConstituentsMeta.mockResolvedValue({
      value: [{ code: '600519', name: '独苗', marketCap: 1 }],
      stale: false,
    });
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('无法构成截面');
  });
});

describe('POST /api/quant/factor/cross-section — codes 路径与降级披露', () => {
  it('个股 K 线为空 → 计入 stocksSkipped，其余照常评估', async () => {
    mockedBars.mockImplementation((code: string) =>
      Promise.resolve(code === '300750' ? [] : genBars(code)),
    );
    mockedFinancial.mockImplementation((code: string) => Promise.resolve(makeFinancial(code)));
    mockedQuarterly.mockImplementation((code: string) => Promise.resolve(makeQuarterly(code)));
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ codes: ['600519', '300750', '000858'], includeFundamental: false });
    expect(res.status).toBe(200);
    expect(res.body.universe.source).toBe('codes');
    expect(res.body.universe.requested).toBe(3);
    // 幸存者偏差如实声明
    expect(res.body.universe.survivorshipNote).toContain('幸存者偏差');
    expect(res.body.stocksIncluded).toEqual(['600519', '000858']);
    expect(res.body.stocksSkipped).toEqual([
      { code: '300750', reason: expect.stringContaining('K线不足') },
    ]);
    // includeFundamental=false：不拉财务/季度财报，也无基本面与事件因子
    expect(mockedFinancial).not.toHaveBeenCalled();
    expect(mockedQuarterly).not.toHaveBeenCalled();
    const types = res.body.factors.map((f: { type: string }) => f.type);
    expect(types).not.toContain('fundamental');
    expect(types).not.toContain('event');
    expect(types).toContain('price_volume');
  });
});

describe('GET /api/quant/universe/boards', () => {
  it('返回板块列表', async () => {
    mockedBoardsMeta.mockResolvedValue({
      value: [{ code: 'BK0475', name: '白酒' }],
      stale: false,
    });
    const res = await request(app).get('/api/quant/universe/boards');
    expect(res.status).toBe(200);
    expect(res.body.boards).toEqual([{ code: 'BK0475', name: '白酒' }]);
  });

  it('过滤旧体系子级板块（名称后缀 Ⅱ/Ⅲ），只保留现行一级板块', async () => {
    mockedBoardsMeta.mockResolvedValue({
      value: [
        { code: 'BK0428', name: '电力行业' },
        { code: 'BK0475', name: '白酒' },
        { code: 'BK0480', name: '银行' },
        { code: 'BK0481', name: '银行Ⅱ' },
        { code: 'BK0482', name: '国有大型银行Ⅲ' },
      ],
      stale: false,
    });
    const res = await request(app).get('/api/quant/universe/boards');
    expect(res.status).toBe(200);
    expect(res.body.boards.map((b: { name: string }) => b.name)).toEqual([
      '电力行业',
      '白酒',
      '银行',
    ]);
  });

  it('上游失败 → 502', async () => {
    mockedBoardsMeta.mockRejectedValue(new Error('上游不可用'));
    const res = await request(app).get('/api/quant/universe/boards');
    expect(res.status).toBe(502);
  });

  it('上游失败但磁盘有快照 → 200 且披露 stale', async () => {
    mockedBoardsMeta.mockResolvedValue({
      value: [{ code: 'BK0475', name: '白酒' }],
      stale: true,
      staleAgeMs: 90 * 60 * 1000,
    });
    const res = await request(app).get('/api/quant/universe/boards');
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.staleAgeMs).toBeGreaterThan(0);
  });
});

describe('POST /api/quant/factor/cross-section — 事件族（分红/回购/解禁）', () => {
  beforeEach(() => {
    mockedConstituentsMeta.mockResolvedValue({
      value: ['600519', '000858', '603288'].map((code, i) => ({
        code,
        name: `股${i}`,
        marketCap: 100 - i,
      })),
      stale: false,
    });
    mockedBars.mockImplementation((code: string) => Promise.resolve(genBars(code)));
    mockedFinancial.mockImplementation((code: string) => Promise.resolve(makeFinancial(code)));
    mockedQuarterly.mockImplementation((code: string) => Promise.resolve(makeQuarterly(code)));
  });

  it('事件源返回事件 → 三类新事件因子装配为 type=event', async () => {
    mockedEvents.mockImplementation(async (code: string) =>
      code === '600519'
        ? {
            dividend: [
              { announceDate: '2024-03-01', exDate: null, per10Cash: 30, dividendYieldPct: 2.5 },
            ],
            buyback: [
              {
                announceDate: '2024-05-06',
                startDate: null,
                planAmountHighYuan: 4e8,
                preAnnounceCapYuan: 2e10,
                planRatioMidPct: null,
                progress: '004',
              },
            ],
            unlock: [
              { freeDate: '2024-07-01', ratioOfFloatPct: 8, sharesWan: 1e3, marketCapWan: 9e4 },
            ],
            dragonTiger: [
              {
                eventDate: '2024-04-10',
                changeRate: 9.98,
                netAmountYuan: 2.5e8,
                netAmountRatioPct: 12.5,
                freeMarketCapYuan: 2e10,
                reason: '日涨幅偏离值达7%的证券',
              },
            ],
          }
        : { dividend: [], buyback: [], unlock: [], dragonTiger: [] },
    );
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475', topN: 3, horizons: [21] });
    expect(res.status).toBe(200);
    const names = res.body.factors
      .filter((f: { type: string }) => f.type === 'event')
      .map((f: { name: string }) => f.name);
    expect(names).toContain('ev_dividend_yield');
    expect(names).toContain('ev_buyback_ratio');
    expect(names).toContain('ev_unlock_overhang');
    expect(names).toContain('ev_dragon_tiger');
    // PEAD 仍随季度财报装配
    expect(names).toContain('ev_earnings_surprise');
  });

  it('事件源返回空捆绑 → 四类新因子缺席，量价族不受影响', async () => {
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475', topN: 3, horizons: [21] });
    expect(res.status).toBe(200);
    const names = res.body.factors.map((f: { name: string }) => f.name);
    expect(names).not.toContain('ev_dividend_yield');
    expect(names).not.toContain('ev_dragon_tiger');
    expect(names).not.toContain('ev_buyback_ratio');
    expect(names).not.toContain('ev_unlock_overhang');
    expect(res.body.factors.some((f: { type: string }) => f.type === 'price_volume')).toBe(true);
  });

  it('includeEvents=false → 事件族整体缺席且不调用事件源', async () => {
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475', topN: 3, horizons: [21], includeEvents: false });
    expect(res.status).toBe(200);
    expect(res.body.factors.some((f: { type: string }) => f.type === 'event')).toBe(false);
    expect(mockedEvents).not.toHaveBeenCalled();
  });
});

describe('预检 / 实验台账 / 自定义因子表达式', () => {
  it('GET /api/quant/health → 返回预检四项', async () => {
    const res = await request(app).get('/api/quant/health');
    expect(res.status).toBe(200);
    expect(res.body.checks.map((c: { key: string }) => c.key)).toEqual([
      'upstream',
      'upstream_list',
      'llm',
      'cache',
    ]);
  });

  it('截面响应带可复现快照与预检结果', async () => {
    mockedConstituentsMeta.mockResolvedValue({ value: CONST_SIX, stale: false });
    mockedBars.mockImplementation((code: string) => Promise.resolve(genBars(code)));
    mockedFinancial.mockImplementation((code: string) => Promise.resolve(makeFinancial(code)));
    mockedQuarterly.mockImplementation((code: string) => Promise.resolve(makeQuarterly(code)));
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475', topN: 6, horizons: [21] });
    expect(res.status).toBe(200);
    expect(res.body.run.kind).toBe('cross-section');
    expect(res.body.run.horizons).toEqual([21]);
    expect(res.body.run.start).toBeTruthy();
    expect(res.body.preflight.checks).toHaveLength(4);
    // 台账自动留痕：因子 × 持有期
    expect(res.body.ledger.recorded).toBeGreaterThan(0);
  });

  it('POST /api/quant/factor/expression 非法表达式 → 400 且指明原因', async () => {
    const res = await request(app)
      .post('/api/quant/factor/expression')
      .send({ expression: 'eval(1)' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('因子表达式非法');
  });

  it('POST /api/quant/factor/expression 缺表达式 → 400', async () => {
    const res = await request(app).post('/api/quant/factor/expression').send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/quant/factor/expression 合法表达式 → 评估并入台账', async () => {
    mockedConstituentsMeta.mockResolvedValue({ value: CONST_SIX, stale: false });
    mockedBars.mockImplementation((code: string) => Promise.resolve(genBars(code)));
    const res = await request(app)
      .post('/api/quant/factor/expression')
      .send({
        expression: 'close / mean(close, 20) - 1',
        board: 'BK0475',
        topN: 6,
        horizons: [21],
      });
    expect(res.status).toBe(200);
    expect(res.body.factor.type).toBe('expression');
    expect(res.body.factor.report.byPeriod).toHaveLength(1);
    expect(res.body.factor.report.byPeriod[0].verdict).toHaveProperty('effective');
    expect(res.body.ledger.recorded).toBeGreaterThan(0);
    expect(res.body.run.expression).toBe('close / mean(close, 20) - 1');
  });

  it('GET /api/quant/factor/experiments → 列表与汇总', async () => {
    const res = await request(app).get('/api/quant/factor/experiments?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.summary).toHaveProperty('total');
  });

  it('POST /api/quant/factor/experiments 补录 → 返回写入条数', async () => {
    const res = await request(app)
      .post('/api/quant/factor/experiments')
      .send({
        entries: [
          {
            source: 'expression',
            name: 'x',
            expression: 'close',
            universe: { requested: 2, included: 2 },
            horizon: 21,
            sampleSize: 100,
            icMean: 0.02,
            pValue: 0.4,
            oosStable: false,
            kept: false,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(1);
  });

  it('POST /api/quant/factor/experiments 空 entries → 400', async () => {
    const res = await request(app).post('/api/quant/factor/experiments').send({ entries: [] });
    expect(res.status).toBe(400);
  });

  it('cross-section indexUniverse：指数历史成分宇宙 → source=index + 历史快照声明', async () => {
    mockedBars.mockImplementation((code: string) => Promise.resolve(genBars(code)));
    mockedQuarterly.mockImplementation((code: string) => Promise.resolve(makeQuarterly(code)));
    mockedIndexCons.mockResolvedValue({
      index: 'hs300',
      requestedDate: '2024-06-28',
      updateDate: '2024-06-24',
      count: 3,
      constituents: [
        { code: '600519', name: '贵州茅台' },
        { code: '000858', name: '五粮液' },
        { code: '600036', name: '招商银行' },
      ],
    });
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ indexUniverse: { index: 'hs300', date: '2024-06-28' }, horizons: [21] });
    expect(res.status).toBe(200);
    expect(res.body.universe.source).toBe('index');
    expect(res.body.universe.updateDate).toBe('2024-06-24');
    expect(res.body.universe.requested).toBe(3);
    expect(res.body.universe.survivorshipNote).toContain('历史快照');
    expect(res.body.universe.survivorshipNote).toContain('后退市证券');
    expect(res.body.factors.length).toBeGreaterThan(0);
  });

  it('cross-section indexUniverse：非法指数名 → 400（列出可选项）', async () => {
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ indexUniverse: { index: 'csi1000' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('hs300 / zz500 / sz50');
  });

  it('cross-section indexUniverse：非法日期格式 → 400', async () => {
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ indexUniverse: { index: 'hs300', date: '2024/06/28' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('YYYY-MM-DD');
  });

  it('cross-section indexUniverse：sidecar 失败 → 502 + 可执行指引', async () => {
    mockedIndexCons.mockRejectedValue(new Error('未找到 Python 解释器（python）'));
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ indexUniverse: { index: 'zz500' } });
    expect(res.status).toBe(502);
    expect(res.body.detail).toContain('Python');
    expect(res.body.hint).toContain('pip install baostock');
  });
});

describe('POST /api/quant/factor/expression/batch — 批量假设验证', () => {
  beforeEach(() => {
    mockedConstituentsMeta.mockResolvedValue({ value: CONST_SIX, stale: false });
    mockedBars.mockImplementation((code: string) => Promise.resolve(genBars(code)));
    mockedFinancial.mockImplementation((code: string) => Promise.resolve(makeFinancial(code)));
    mockedQuarterly.mockImplementation((code: string) => Promise.resolve(makeQuarterly(code)));
  });

  it('expressions 缺失 / 空 / 超 50 → 400 / 413', async () => {
    const e0 = await request(app).post('/api/quant/factor/expression/batch').send({});
    expect(e0.status).toBe(400);
    const many = await request(app)
      .post('/api/quant/factor/expression/batch')
      .send({ expressions: Array.from({ length: 51 }, (_, i) => `close + ${i}`) });
    expect(many.status).toBe(413);
  });

  it('全部非法 → 400 且逐条给原因', async () => {
    const res = await request(app)
      .post('/api/quant/factor/expression/batch')
      .send({ expressions: ['close +', 'unknown_field * 2'] });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(2);
  });

  it('happy path：合法与非法混合 → 数据取一次、逐条评估、非法项只标记', async () => {
    const callsBefore = mockedBars.mock.calls.length;
    const res = await request(app)
      .post('/api/quant/factor/expression/batch')
      .send({
        expressions: [
          'close / mean(close, 20) - 1', // 合法
          'volume / mean(volume, 20)', // 合法
          'bad_ident + 1', // 非法标识符
        ],
        board: 'BK0475',
        topN: 6,
        horizons: [21],
      });
    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(3);
    expect(res.body.evaluated).toBe(2);
    const okItems = res.body.results.filter((r: { ok: boolean }) => r.ok);
    expect(okItems).toHaveLength(2);
    for (const r of okItems) {
      expect(r.factor.report.periods).toEqual([21]);
      expect(r.factor.report.byPeriod[0].verdict).toHaveProperty('effective');
      expect(r.ledger.recorded).toBeGreaterThan(0);
    }
    const bad = res.body.results.find((r: { ok: boolean }) => !r.ok);
    expect(bad.error).toContain('未授权的标识符');
    // 面板共享：3 条表达式只取一次数据（取数调用数 = 股票数，而非 ×3）
    expect(mockedBars.mock.calls.length - callsBefore).toBe(CONST_SIX.length);
  });

  it('portfolio 参数 → 逐条附组合回测（IC 之外的 PnL 视角）', async () => {
    const res = await request(app)
      .post('/api/quant/factor/expression/batch')
      .send({
        expressions: ['close / mean(close, 20) - 1'],
        codes: ['600519', '000858', '603288', '600809', '000568', '600702'],
        horizons: [21],
        portfolio: { holdDays: 21, topN: 3, costBps: 30 },
      });
    expect(res.status).toBe(200);
    const pf = res.body.results[0].portfolio;
    expect(pf).not.toBeNull();
    expect(pf.periods).toBeGreaterThan(0);
    expect(typeof pf.totalReturn).toBe('number');
    expect(pf.rebalances[0].holdings.length).toBeLessThanOrEqual(3);
    expect(typeof pf.sharpe).toBe('number');
    expect(typeof pf.maxDrawdown).toBe('number');
  });

  it('合法表达式但全 NaN（除零）→ 该项标记样本不足', async () => {
    const res = await request(app)
      .post('/api/quant/factor/expression/batch')
      .send({ expressions: ['close / (close - close)'], codes: ['600519', '000858'] });
    expect(res.status).toBe(200);
    expect(res.body.evaluated).toBe(0);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].error).toContain('有效观测');
  });
});

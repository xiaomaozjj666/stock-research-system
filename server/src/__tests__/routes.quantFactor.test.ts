import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { OHLCVData } from '../quant/types.js';
import type { FinancialData } from '../types.js';

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
  return { ...actual, fetchIndustryBoards: vi.fn(), fetchBoardConstituents: vi.fn() };
});
vi.mock('../services/quarterlyFinancials.js', () => ({
  fetchQuarterlyFinancials: vi.fn(),
}));

import { app } from '../index.js';
import {
  computeCompositeAlphaForStrategy,
  computeCompositeAlphaBatch,
} from '../quant/compositeService.js';
import { fetchFinancialData } from '../services/dataFetcher.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import { fetchIndustryBoards, fetchBoardConstituents } from '../quant/universeProvider.js';
import { fetchQuarterlyFinancials } from '../services/quarterlyFinancials.js';
import type { QuarterlySeries } from '../services/quarterlyFinancials.js';

const mockedComposite = vi.mocked(computeCompositeAlphaForStrategy);
const mockedBatch = vi.mocked(computeCompositeAlphaBatch);
const mockedFinancial = vi.mocked(fetchFinancialData);
const mockedBars = vi.mocked(fetchOHLCVData);
const mockedBoards = vi.mocked(fetchIndustryBoards);
const mockedConstituents = vi.mocked(fetchBoardConstituents);
const mockedQuarterly = vi.mocked(fetchQuarterlyFinancials);

beforeEach(() => {
  vi.mocked(computeCompositeAlphaForStrategy).mockReset();
  vi.mocked(computeCompositeAlphaBatch).mockReset();
  mockedFinancial.mockReset();
  mockedBars.mockReset();
  mockedBoards.mockReset();
  mockedConstituents.mockReset();
  mockedQuarterly.mockReset();
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
  it('codes 少于 2 只 / 多于 30 只 → 400', async () => {
    const one = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ codes: ['600519'] });
    expect(one.status).toBe(400);
    expect(one.body.error).toContain('2-30');
    const many = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ codes: Array.from({ length: 31 }, (_, i) => `6005${String(i).padStart(2, '0')}`) });
    expect(many.status).toBe(400);
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
  const BOARDS = [
    { code: 'BK0475', name: '白酒' },
    { code: 'BK0428', name: '电力行业' },
  ];
  const CONSTITUENTS = ['600519', '000858', '603288', '600809', '000568', '600702'].map(
    (code, i) => ({ code, name: `股票${i}`, marketCap: 1000 - i }),
  );

  beforeEach(() => {
    mockedBoards.mockResolvedValue(BOARDS);
    mockedConstituents.mockResolvedValue(CONSTITUENTS);
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
    expect(res.body.universe.boardName).toBe('白酒');
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
    mockedConstituents.mockRejectedValue(new Error('上游超时'));
    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475' });
    expect(res.status).toBe(502);
    expect(res.body.detail).toContain('上游超时');
  });

  it('有效成分股不足 2 只 → 422', async () => {
    mockedConstituents.mockResolvedValue([{ code: '600519', name: '独苗', marketCap: 1 }]);
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
    expect(res.body.universe).toEqual({ source: 'codes', requested: 3 });
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
    mockedBoards.mockResolvedValue([{ code: 'BK0475', name: '白酒' }]);
    const res = await request(app).get('/api/quant/universe/boards');
    expect(res.status).toBe(200);
    expect(res.body.boards).toEqual([{ code: 'BK0475', name: '白酒' }]);
  });

  it('上游失败 → 502', async () => {
    mockedBoards.mockRejectedValue(new Error('上游不可用'));
    const res = await request(app).get('/api/quant/universe/boards');
    expect(res.status).toBe(502);
  });
});

/**
 * ============================================================================
 * 因子测量路由的取数区间闸门（#2 + #3 的批量取数成本）
 * ----------------------------------------------------------------------------
 * #2 日期参数未校验：/factor/composite、/factor/composite/batch、/factor/expression、
 * /factor/expression/batch 此前只对 startDate/endDate 做 String() 强转（expression
 * 两条甚至完全忽略入参）。非法日期 / 倒置区间 / 十年以上的超长跨度会原样落到
 * 「每只股票按同一区间拉一遍 K 线」上——截面宽度 × 区间长度直接乘出上游成本。
 * 本文件的核心断言不是「400」，而是**一次 K 线都没取**。
 *
 * #3 批量闸门多做一轮取数：batch 路径曾先 findSimulatedCodes() 按同一口径预检一遍，
 * 冷缓存时整批多一轮上游拉取。现在改为跑完后按逐股结果的 isSimulated 判定，
 * 语义（422 + degraded + 命中代码）不变，取数次数减半。
 *
 * 隔离：K 线 / 预检 / universe / 组合服务全部替身，不发真实网络。
 * ============================================================================
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { OHLCVData } from '../quant/types.js';

vi.mock('../middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware.js')>();
  return {
    ...actual,
    quantLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../quant/dataProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/dataProvider.js')>();
  return { ...actual, fetchOHLCVData: vi.fn() };
});

vi.mock('../quant/compositeService.js', () => ({
  computeCompositeAlphaForStrategy: vi.fn(),
  computeCompositeAlphaBatch: vi.fn(),
}));

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

vi.mock('../quant/universeProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/universeProvider.js')>();
  return {
    ...actual,
    fetchIndustryBoardsWithMeta: vi.fn(),
    fetchBoardConstituentsWithMeta: vi.fn(),
  };
});

vi.mock('../services/dataFetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dataFetcher.js')>();
  return { ...actual, fetchFinancialData: vi.fn(async () => null) };
});
vi.mock('../services/quarterlyFinancials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/quarterlyFinancials.js')>();
  return { ...actual, fetchQuarterlyFinancials: vi.fn(async () => null) };
});
vi.mock('../quant/eventProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/eventProvider.js')>();
  return {
    ...actual,
    fetchStockEvents: vi.fn(async () => ({
      dividend: [],
      buyback: [],
      unlock: [],
      dragonTiger: [],
    })),
  };
});
vi.mock('../quant/marginProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/marginProvider.js')>();
  return { ...actual, fetchMarginSeries: vi.fn(async () => []) };
});

import { app } from '../index.js';
import {
  computeCompositeAlphaForStrategy,
  computeCompositeAlphaBatch,
} from '../quant/compositeService.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';

const mockedComposite = vi.mocked(computeCompositeAlphaForStrategy);
const mockedBatch = vi.mocked(computeCompositeAlphaBatch);
const mockedBars = vi.mocked(fetchOHLCVData);

/** 真实行情（无 isSimulated 标记） */
function realBars(n = 300): OHLCVData[] {
  const out: OHLCVData[] = [];
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date, open: 10, high: 11, low: 9, close: 10 + (i % 7) * 0.1, volume: 1000 });
  }
  return out;
}

/** 命中模拟降级（dataProvider 在源不可达时返回的合成 K 线）；供后续用例按需取用 */
function simulatedBars(n = 300): OHLCVData[] {
  return realBars(n).map((b) => ({ ...b, isSimulated: true }));
}
void simulatedBars; // 本轮用例尚未用到：保留工具函数，显式声明"有意保留"

const compositeResult = (code: string) => ({
  stockCode: code,
  market: 'A' as const,
  benchmarkSecid: '1.000300',
  horizons: [21, 63],
  compositeAlpha: { horizons: [], hasSignal: false, overallDirection: 'neutral', overallAlpha: 0 },
  factorPredictability: [],
  bars: 300,
  dataRange: { start: '2024-01-01', end: '2025-03-01' },
  benchmarkAvailable: true,
  isSimulated: false,
});

function batchResultFor(codes: string[], simulated: string[] = []) {
  return {
    requested: codes.length,
    succeeded: codes.length,
    failed: 0,
    items: codes.map((code) => ({
      stockCode: code,
      ok: true as const,
      result: { ...compositeResult(code), isSimulated: simulated.includes(code) },
    })),
    startDate: '2024-01-01',
    endDate: '2025-03-01',
    horizons: [21, 63],
  };
}

/** expression 系列的 codes 路径要求 2-300 只（单只走 composite） */
const PANEL_CODES = ['600519', '000858', '601318'];

/** 四个待校验端点 + 各自的合法请求体（expression 系列用 codes 走确定性 universe） */
const ENDPOINTS: { name: string; path: string; body: Record<string, unknown> }[] = [
  {
    name: '/factor/composite',
    path: '/api/quant/factor/composite',
    body: { stockCode: '600519' },
  },
  {
    name: '/factor/composite/batch',
    path: '/api/quant/factor/composite/batch',
    body: { stockCodes: ['600519', '000858'] },
  },
  {
    name: '/factor/expression',
    path: '/api/quant/factor/expression',
    body: { expression: 'close', codes: PANEL_CODES },
  },
  {
    name: '/factor/expression/batch',
    path: '/api/quant/factor/expression/batch',
    body: { expressions: ['close'], codes: PANEL_CODES },
  },
];

beforeEach(() => {
  mockedComposite.mockReset();
  mockedBatch.mockReset();
  mockedBars.mockReset();
  mockedBars.mockResolvedValue(realBars());
  mockedComposite.mockResolvedValue(compositeResult('600519') as never);
  mockedBatch.mockImplementation(async (codes: string[]) => batchResultFor(codes) as never);
});

describe('#2 区间参数闸门：非法日期 / 倒置 / 超长跨度 → 400 且零取数', () => {
  const badCases: [string, Record<string, unknown>, RegExp][] = [
    ['startDate 非 YYYY-MM-DD', { startDate: '2024/01/01' }, /startDate/],
    ['startDate 非真实日历日（2024-02-30）', { startDate: '2024-02-30' }, /startDate/],
    ['endDate 月份越界（2024-13-01）', { endDate: '2024-13-01' }, /endDate/],
    ['倒置区间', { startDate: '2025-06-30', endDate: '2024-01-01' }, /不得晚于/],
    ['跨度过大（2000-01-01 → 今天，远超 10.5 年）', { startDate: '2000-01-01' }, /区间过长/],
  ];

  it.each(ENDPOINTS)('$name：非法入参一律 400 + 中文原因，且不取任何 K 线', async (endpoint) => {
    for (const [caseName, extra, pattern] of badCases) {
      mockedBars.mockClear();
      const res = await request(app)
        .post(endpoint.path)
        .send({ ...endpoint.body, ...extra });

      expect(res.status, `${endpoint.name} / ${caseName}`).toBe(400);
      expect(res.body.error, `${endpoint.name} / ${caseName}`).toMatch(pattern);
      expect(mockedBars, `${endpoint.name} / ${caseName} 不得取数`).not.toHaveBeenCalled();
      expect(mockedComposite, `${endpoint.name} / ${caseName}`).not.toHaveBeenCalled();
      expect(mockedBatch, `${endpoint.name} / ${caseName}`).not.toHaveBeenCalled();
    }
  });

  it('composite：合法区间原样透传（正常路径不变）', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ stockCode: '600519', startDate: '2024-01-01', endDate: '2024-12-31' });

    expect(res.status).toBe(200);
    expect(mockedComposite).toHaveBeenCalledWith('600519', '2024-01-01', '2024-12-31', [21, 63]);
    expect(mockedBars).toHaveBeenCalledWith('600519', '2024-01-01', '2024-12-31');
  });

  it('composite/batch：合法区间透传 + 响应回显', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519'], startDate: '2024-01-01', endDate: '2024-12-31' });

    expect(res.status).toBe(200);
    expect(mockedBatch).toHaveBeenCalledWith(
      ['600519'],
      '2024-01-01',
      '2024-12-31',
      [21, 63],
      undefined,
      expect.anything(),
    );
  });

  it('composite：缺省日期沿用既有默认区间（约 2 年 → 今天）', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ stockCode: '600519' });

    expect(res.status).toBe(200);
    const [, start, end] = mockedComposite.mock.calls[0] as unknown as [string, string, string];
    expect(end).toBe(new Date().toISOString().slice(0, 10));
    const spanDays = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
    expect(spanDays).toBe(730);
    // 默认区间不额外取数
    expect(mockedBars).toHaveBeenCalledTimes(1);
  });

  it('expression：区间入参被真正采用（此前被忽略，固定 730 天窗口）', async () => {
    const res = await request(app).post('/api/quant/factor/expression').send({
      expression: 'close',
      codes: PANEL_CODES,
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });

    // 允许因样本不足 422，但取数区间必须是调用方给的那个
    expect(mockedBars).toHaveBeenCalled();
    expect(mockedBars.mock.calls.every((c) => c[1] === '2024-01-01' && c[2] === '2024-12-31')).toBe(
      true,
    );
    expect([200, 422]).toContain(res.status);
  });
});

describe('#3 批量闸门：跑完后据结果判定，冷缓存只按批量口径取一次数', () => {
  it('命中模拟数据 → 422 + degraded + 命中代码（语义与预检版一致）', async () => {
    mockedBatch.mockImplementation(
      async (codes: string[]) => batchResultFor(codes, ['000858']) as never,
    );

    const res = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519', '000858'] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('行情源不可用，本次未使用模拟数据');
    expect(res.body.degraded).toBe(true);
    expect(res.body.simulatedCodes).toEqual(['000858']);
    // 不得泄漏任何「像结论的指标」
    expect(res.body.items).toBeUndefined();
    expect(res.body.succeeded).toBeUndefined();
  });

  it('冷缓存：路由只按批量口径取一次数（不再多一轮预检）', async () => {
    await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519', '000858'] });

    // 取数只发生在批量服务内部；预检版会在路由层直接看到 fetchOHLCVData 调用
    expect(mockedBatch).toHaveBeenCalledTimes(1);
    expect(mockedBars).toHaveBeenCalledTimes(0);
  });

  it('冷缓存：真实批量服务逐股恰好取一次数（预检版会翻倍）', async () => {
    // 换用真实批量服务，让逐股取数真的发生：2 只代码 → 恰好 2 次 fetchOHLCVData
    const actual = await vi.importActual<typeof import('../quant/compositeService.js')>(
      '../quant/compositeService.js',
    );
    mockedBatch.mockImplementation(actual.computeCompositeAlphaBatch);

    await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519', '000858'] });

    expect(mockedBars).toHaveBeenCalledTimes(2);
    expect(mockedBars.mock.calls.map((c) => c[0]).sort()).toEqual(['000858', '600519']);
  });

  it('全部真实行情 → 200（闸门不误伤正常路径）', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519', '000858'] });

    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(2);
    expect(res.body.items).toHaveLength(2);
  });

  it('旧式结果（无 isSimulated 字段）不误判为模拟数据', async () => {
    mockedBatch.mockImplementation(
      async (codes: string[]) =>
        ({
          ...batchResultFor(codes),
          items: codes.map((code) => ({
            stockCode: code,
            ok: true,
            result: { ...compositeResult(code), isSimulated: undefined },
          })),
        }) as never,
    );

    const res = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519'] });

    expect(res.status).toBe(200);
  });
});

/**
 * ============================================================================
 * 量化路由「数据可信」回归测试：模拟行情闸门 + horizons 统一解析。
 *
 * 防的两类缺陷（都不报错、只静默产出伪结论）：
 *   1. **合成 K 线流入结论**：dataProvider 在行情源不可达时返回按代码播种的确定性
 *      合成 K 线（isSimulated=true）。此前 composite / cross-section /
 *      backtest-evaluate / batch 四条路径取数后从不检查该标记，用户拿到的是基于
 *      合成曲线算出的 IC/t/p、compositeAlpha、totalReturn/sharpe，且 HTTP 200，
 *      无从分辨。现在统一 422 + degraded，不返回任何指标。
 *   2. **horizons 解析口径四处不一致**：单只 composite 连上界都没有（h=1e9 可通过）；
 *      截面/表达式只有单元素值域、无个数上限（16000 个整数约 64KB body 即可通过，
 *      每档一轮全截面测算）；batch 先 floor 再没复检下界（h=0.5 → 0 →
 *      Math.ceil(m/0)=Infinity → tStat=NaN → 响应字段成 null）。
 *      现在五处共用 parseHorizons：非法即 400 + 中文说明，不静默回落默认值。
 *
 * 隔离策略：外部数据面全部 mock（K 线 / 预检 / universe），不发真实网络；
 * quantLimiter 在模块层替换为直通中间件（本文件用例数 > 5 req/min）。
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
import {
  fetchIndustryBoardsWithMeta,
  fetchBoardConstituentsWithMeta,
} from '../quant/universeProvider.js';

const mockedComposite = vi.mocked(computeCompositeAlphaForStrategy);
const mockedBatch = vi.mocked(computeCompositeAlphaBatch);
const mockedBars = vi.mocked(fetchOHLCVData);
const mockedConstituents = vi.mocked(fetchBoardConstituentsWithMeta);
const mockedBoards = vi.mocked(fetchIndustryBoardsWithMeta);

/** 行情不可用 → dataProvider 的合成降级产物（带 isSimulated 标记） */
function simulatedBars(n = 300): OHLCVData[] {
  const out: OHLCVData[] = [];
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    out.push({
      date,
      open: 10,
      high: 11,
      low: 9,
      close: 10 + (i % 7) * 0.1,
      volume: 1000,
      isSimulated: true,
    });
  }
  return out;
}

/** 真实行情（无 isSimulated 标记） */
function realBars(n = 300): OHLCVData[] {
  return simulatedBars(n).map(({ isSimulated: _drop, ...rest }) => rest);
}

/** 断言响应体里没有任何「像结论的指标」 */
function expectNoMetrics(body: Record<string, unknown>): void {
  for (const key of [
    'compositeAlpha',
    'factorPredictability',
    'factors',
    'baseline',
    'experiment',
    'comparison',
    'items',
  ]) {
    expect(body[key]).toBeUndefined();
  }
}

beforeEach(() => {
  mockedComposite.mockReset();
  mockedBatch.mockReset();
  mockedBars.mockReset();
  mockedConstituents.mockReset();
  mockedBoards.mockReset();
  mockedBars.mockResolvedValue(realBars());
});

describe('模拟行情闸门：合成 K 线不得流入结论', () => {
  it('单只 composite 命中模拟数据 → 422 + degraded，不跑组合 alpha 计算', async () => {
    mockedBars.mockResolvedValue(simulatedBars());

    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ stockCode: '600519' });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: '行情源不可用，本次未使用模拟数据', degraded: true });
    expectNoMetrics(res.body);
    // 闸门必须在算之前：不得先算出 IC/t/p 再据结果决定状态码
    expect(mockedComposite).not.toHaveBeenCalled();
  });

  it('单只 composite 真实行情 → 照常 200（闸门不误伤正常路径）', async () => {
    mockedComposite.mockResolvedValue({
      stockCode: '600519',
      market: 'A',
      benchmarkSecid: '1.000300',
      horizons: [21, 63],
      compositeAlpha: {
        horizons: [],
        hasSignal: false,
        overallDirection: 'neutral',
        overallAlpha: 0,
      },
      factorPredictability: [],
      bars: 300,
      dataRange: { start: '2024-01-01', end: '2025-10-01' },
      benchmarkAvailable: true,
    } as never);

    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ stockCode: '600519' });

    expect(res.status).toBe(200);
    expect(res.body.stockCode).toBe('600519');
  });

  it('batch composite 任一只命中模拟数据 → 422 + 列出命中代码，不跑整批', async () => {
    mockedBars.mockImplementation((code: string) =>
      Promise.resolve(code === '000858' ? simulatedBars() : realBars()),
    );

    const res = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519', '000858'] });

    expect(res.status).toBe(422);
    expect(res.body.degraded).toBe(true);
    expect(res.body.simulatedCodes).toEqual(['000858']);
    expectNoMetrics(res.body);
    // 批量结果不携带 isSimulated 标记，必须在调用批量服务**之前**拦下
    expect(mockedBatch).not.toHaveBeenCalled();
  });

  it('截面路径命中模拟数据 → 422，不产出任何因子报告', async () => {
    mockedBoards.mockResolvedValue({ value: [], stale: false } as never);
    mockedConstituents.mockResolvedValue({
      value: [
        { code: '600519', name: '甲', marketCap: 100 },
        { code: '000858', name: '乙', marketCap: 90 },
      ],
      stale: false,
    } as never);
    mockedBars.mockResolvedValue(simulatedBars());

    const res = await request(app)
      .post('/api/quant/factor/cross-section')
      .send({ board: 'BK0475', topN: 3 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('行情源不可用，本次未使用模拟数据');
    expect(res.body.degraded).toBe(true);
    expectNoMetrics(res.body);
  });

  it('/api/backtest/evaluate 命中模拟数据 → 422，不返回 totalReturn/sharpe', async () => {
    mockedBars.mockResolvedValue(simulatedBars());

    const res = await request(app)
      .post('/api/backtest/evaluate')
      .send({ stockCode: '600519', strategy: 'ma_cross' });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: '行情源不可用，本次未使用模拟数据', degraded: true });
    expectNoMetrics(res.body);
  });
});

describe('horizons 统一解析：越界/小数/超个数一律 400', () => {
  const base = { stockCode: '600519' };

  beforeEach(() => {
    mockedComposite.mockResolvedValue({} as never);
  });

  it.each([
    ['上界越界（旧行为可通过 h=1e9）', [1e9], /1-504/],
    ['下界越界（h=0）', [0], /1-504/],
    ['小数（旧 batch 路径 floor 成 0 → tStat=NaN）', [0.5], /1-504/],
    ['空数组', [], /不能为空/],
    ['非数组', '21', /整数数组/],
    ['数组内含非数值字符串', ['abc'], /1-504/],
    ['个数超上限（9 > 8）', [1, 2, 3, 4, 5, 6, 7, 8, 9], /档位过多/],
    ['超大批量（16000 档）', Array.from({ length: 16000 }, (_, i) => (i % 400) + 1), /档位过多/],
  ])('%s → 400 且不调用组合服务', async (_name, horizons, pattern) => {
    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ ...base, horizons });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(pattern);
    expect(mockedComposite).not.toHaveBeenCalled();
  });

  it('数字字符串档位按数值语义接受（兼容前端表单原样透传）', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ ...base, horizons: ['21', '63'] });

    expect(res.status).toBe(200);
    expect(mockedComposite).toHaveBeenCalledWith(
      '600519',
      expect.any(String),
      expect.any(String),
      [21, 63],
    );
  });

  it('batch 路径同样受统一解析约束：h=0.5 → 400（旧行为 floor 成 0，tStat 变 NaN）', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519'], horizons: [0.5] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1-504/);
    expect(mockedBatch).not.toHaveBeenCalled();
  });

  it('重复档位去重后透传', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ ...base, horizons: [21, 21, 63, 21] });

    expect(res.status).toBe(200);
    expect(mockedComposite).toHaveBeenCalledWith(
      '600519',
      expect.any(String),
      expect.any(String),
      [21, 63],
    );
  });

  it('缺省字段 → 沿用默认档位 [21, 63]', async () => {
    const res = await request(app).post('/api/quant/factor/composite').send(base);
    expect(res.status).toBe(200);
    expect(mockedComposite).toHaveBeenCalledWith(
      '600519',
      expect.any(String),
      expect.any(String),
      [21, 63],
    );
  });
});

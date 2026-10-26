import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createThesis,
  evaluateThesis,
  listTheses,
  type CreateThesisInput,
} from '../thesisService.js';
import type { OHLCVData } from '../../quant/types.js';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../quant/dataProvider.js', () => ({ fetchOHLCVData: fetchMock }));

function bar(date: string, close: number, isSimulated?: boolean): OHLCVData {
  return { date, open: close, high: close, low: close, close, volume: 1000, isSimulated };
}

const tmpDir = mkdtempSync(join(tmpdir(), 'thesis-'));
const tmpFile = join(tmpDir, 'theses.json');
const originalFile = process.env.THESIS_FILE;
const createdAt = new Date('2026-01-01T12:00:00.000Z');
const dueAt = new Date('2026-01-03T12:00:00.000Z');

function input(overrides: Partial<CreateThesisInput> = {}): CreateThesisInput {
  return {
    stockCode: '600519',
    thesis: '基本面改善将带来正收益；若跌破证伪线则退出',
    rating: '持续观察',
    totalScore: 66,
    metric: 'return_pct',
    comparator: 'lte',
    threshold: -5,
    horizonDays: 2,
    evidenceSource: 'real_ohlcv',
    invalidationAction: '撤销看多假设并复核风险',
    benchmarkCode: '000300',
    execution: {
      side: 'buy',
      orderType: 'market',
      entryPrice: 100,
      quantity: 100,
      commissionRate: 0.0003,
      stampDutyRate: 0.0005,
    },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.THESIS_FILE = tmpFile;
  writeFileSync(tmpFile, JSON.stringify({ items: [] }));
  fetchMock.mockClear();
  fetchMock.mockImplementation(async (code: string) =>
    code === '000300' ? [bar('2026-01-02', 100), bar('2026-01-03', 105)] : [bar('2026-01-02', 80)],
  );
});

afterAll(() => {
  if (originalFile === undefined) delete process.env.THESIS_FILE;
  else process.env.THESIS_FILE = originalFile;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('thesisService 预注册与确定性评估', () => {
  it('创建时冻结期限、基准、成交规则与 active 状态', async () => {
    const created = await createThesis(
      input({ execution: { ...input().execution, quantity: 250 } }),
      createdAt,
    );
    const stored = listTheses('600519')[0];

    expect(created.status).toBe('active');
    expect(created.evidenceStatus).toBe('pending');
    expect(created.createdAt).toBe(createdAt.toISOString());
    expect(created.dueAt).toBe(dueAt.toISOString());
    expect(created.benchmarkCode).toBe('000300');
    expect(created.execution.quantity).toBe(200);
    expect(stored).toEqual(created);
    expect(await evaluateThesis(created.id, new Date('2026-01-03T11:59:59.999Z'))).toMatchObject({
      status: 'active',
      evidenceStatus: 'pending',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('到期边界按真实证据判定 invalidated，并复用冻结费用计算收益', async () => {
    const created = await createThesis(input(), createdAt);
    fetchMock.mockImplementation(async () => [bar('2026-01-02', 80)]);

    const evaluated = await evaluateThesis(created.id, dueAt);
    expect(evaluated).toMatchObject({
      status: 'invalidated',
      evidenceStatus: 'sufficient',
      reason: 'threshold_met',
      observedAt: '2026-01-02',
      observedValue: -20.09,
      returnPct: -20.09,
    });
    expect(evaluated?.returnPct).toBeLessThanOrEqual(-5);
  });

  it('上涨收益以买入总成本为基期并扣除双边费用', async () => {
    const created = await createThesis(input(), createdAt);
    fetchMock.mockImplementation(async () => [bar('2026-01-02', 110)]);

    const evaluated = await evaluateThesis(created.id, dueAt);
    expect(evaluated).toMatchObject({
      status: 'expired',
      evidenceStatus: 'sufficient',
      reason: 'threshold_not_met',
      observedValue: 9.88,
      returnPct: 9.88,
    });
  });

  it('到期但无已完成真实 K 线时 expired + insufficient_evidence，不制造收益', async () => {
    const created = await createThesis(input(), createdAt);
    fetchMock.mockImplementation(async () => [bar('2026-01-03', 80)]);

    const evaluated = await evaluateThesis(created.id, dueAt);
    expect(evaluated).toMatchObject({
      status: 'expired',
      evidenceStatus: 'insufficient_evidence',
      reason: 'insufficient_evidence',
    });
    expect(evaluated?.returnPct).toBeUndefined();
    expect(evaluated?.observedValue).toBeUndefined();

    fetchMock.mockImplementation(async () => [bar('2026-01-02', 120)]);
    expect((await evaluateThesis(created.id, new Date('2026-01-04T12:00:00Z')))?.status).toBe(
      'expired',
    );
    expect((await evaluateThesis(created.id, dueAt))?.returnPct).toBeUndefined();
  });

  it('比较符等于阈值时确定性失效', async () => {
    const created = await createThesis(
      input({ metric: 'close_price', comparator: 'lte', threshold: 90 }),
      createdAt,
    );
    fetchMock.mockImplementation(async () => [bar('2026-01-02', 90)]);

    const evaluated = await evaluateThesis(created.id, dueAt);
    expect(evaluated).toMatchObject({
      status: 'invalidated',
      evidenceStatus: 'sufficient',
      reason: 'threshold_met',
      observedValue: 90,
    });
    expect(evaluated?.returnPct).toBeUndefined();
  });

  it('模拟行情不视为证据；超额收益只在同窗口真实基准充足时计算', async () => {
    const insufficient = await createThesis(
      input({ metric: 'excess_return_pct', threshold: 3 }),
      createdAt,
    );
    fetchMock.mockImplementation(async () => [bar('2026-01-02', 110, true)]);
    expect((await evaluateThesis(insufficient.id, dueAt))?.evidenceStatus).toBe(
      'insufficient_evidence',
    );
  });

  it('超额条件边界使用冻结基准；限价未成交不生成收益', async () => {
    const excess = await createThesis(
      input({ metric: 'excess_return_pct', comparator: 'gte', threshold: 4, horizonDays: 3 }),
      createdAt,
    );
    fetchMock.mockImplementation(async (code: string) =>
      code === '000300'
        ? [bar('2026-01-02', 100), bar('2026-01-03', 105)]
        : [bar('2026-01-02', 100), bar('2026-01-03', 110)],
    );
    const evaluatedExcess = await evaluateThesis(excess.id, new Date('2026-01-04T12:00:00Z'));
    expect(evaluatedExcess).toMatchObject({ status: 'invalidated', excessPct: 4.88 });

    const noFill = await createThesis(
      input({ execution: { ...input().execution, orderType: 'limit', limitPrice: 90 } }),
      createdAt,
    );
    const evaluatedNoFill = await evaluateThesis(noFill.id, dueAt);
    expect(evaluatedNoFill).toMatchObject({ status: 'expired', evidenceStatus: 'no_execution' });
    expect(evaluatedNoFill?.returnPct).toBeUndefined();
  });
});

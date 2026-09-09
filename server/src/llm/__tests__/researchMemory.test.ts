import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getPreviousAnalysis, listHistory } from '../../services/historyService.js';
import { listFactorExperiments } from '../../quant/factorLedger.js';
import { buildResearchMemory } from '../researchMemory.js';

vi.mock('../../services/historyService.js', () => ({
  getPreviousAnalysis: vi.fn(),
  listHistory: vi.fn(),
}));
vi.mock('../../quant/factorLedger.js', () => ({ listFactorExperiments: vi.fn() }));

const mockedPrev = vi.mocked(getPreviousAnalysis);
const mockedList = vi.mocked(listHistory);
const mockedLedger = vi.mocked(listFactorExperiments);

beforeEach(() => {
  mockedPrev.mockReset();
  mockedList.mockReset();
  mockedLedger.mockReset();
  mockedPrev.mockReturnValue(null);
  mockedList.mockReturnValue([]);
  mockedLedger.mockReturnValue([]);
});

describe('buildResearchMemory', () => {
  it('无任何历史 → summary 为 null（不编造记忆）', () => {
    const m = buildResearchMemory('600519');
    expect(m.summary).toBeNull();
    expect(m.previous).toBeNull();
    expect(m.historyCount).toBe(0);
  });

  it('带上一次分析结论', () => {
    mockedPrev.mockReturnValue({
      id: 'x',
      stockCode: '600519',
      stockName: '贵州茅台',
      createdAt: '2026-09-01T00:00:00.000Z',
      rating: '增持',
      totalScore: 78,
    } as never);
    const m = buildResearchMemory('600519');
    expect(m.previous?.rating).toBe('增持');
    expect(m.summary).toContain('上次分析');
    expect(m.summary).toContain('增持');
  });

  it('评分趋势按由旧到新排列（最多 5 条）', () => {
    // listHistory 真实返回是时间倒序（最新在前）；这里同步模拟，
    // 最新一次评分最高 → 反转后趋势应为递增
    mockedList.mockReturnValue(
      Array.from({ length: 8 }, (_, i) => ({
        id: `id-${i}`,
        stockCode: '600519',
        stockName: 'x',
        createdAt: `2026-09-${String(8 - i).padStart(2, '0')}T00:00:00.000Z`,
        rating: 'r',
        totalScore: 67 - i,
      })),
    );
    const m = buildResearchMemory('600519');
    expect(m.historyCount).toBe(8);
    expect(m.scoreTrend).toHaveLength(5);
    // listHistory 按时间倒序 → 取前 5 再反转 = 由旧到新
    expect(m.scoreTrend[0]).toBeLessThan(m.scoreTrend[4]);
  });

  it('并入台账中已通过验证的因子', () => {
    mockedLedger.mockReturnValue([
      {
        id: 'e1',
        createdAt: 'x',
        source: 'expression',
        name: 'cs_roe',
        universe: { requested: 6, included: 6 },
        horizon: 21,
        sampleSize: 400,
        icMean: 0.0612,
        pValue: 0.01,
        oosStable: true,
        kept: true,
      },
    ] as never);
    const m = buildResearchMemory('600519');
    expect(m.validatedFactors).toHaveLength(1);
    expect(m.summary).toContain('cs_roe');
    expect(m.summary).toContain('0.061');
  });
});

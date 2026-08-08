import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runQuantPipeline } from '../pipeline.js';
import { fetchOHLCVData } from '../dataProvider.js';
import { runBacktest } from '../backtestEngine.js';
import {
  parseStrategyInput,
  orchestrate,
  generateSummary,
} from '../agents/orchestrator.js';
import type {
  AuditReport,
  BacktestResult,
  DataQualityReport,
  OHLCVData,
  OptimizationReport,
  StrategyConfig,
} from '../types.js';

vi.mock('../dataProvider.js', () => ({ fetchOHLCVData: vi.fn() }));
vi.mock('../backtestEngine.js', () => ({ runBacktest: vi.fn() }));
vi.mock('../agents/orchestrator.js', () => ({
  parseStrategyInput: vi.fn(),
  orchestrate: vi.fn(),
  generateSummary: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchOHLCVData);
const mockedRunBacktest = vi.mocked(runBacktest);
const mockedParse = vi.mocked(parseStrategyInput);
const mockedOrchestrate = vi.mocked(orchestrate);
const mockedSummary = vi.mocked(generateSummary);

function makeStrategy(): StrategyConfig {
  return {
    name: '测试策略',
    type: 'ma_cross',
    stockCode: '600519',
    params: { shortPeriod: 5, longPeriod: 20 },
    startDate: '2023-01-01',
    endDate: '2025-01-01',
  };
}

function makeBars(n: number): OHLCVData[] {
  const bars: OHLCVData[] = [];
  const start = new Date('2024-01-02T00:00:00');
  let i = 0;
  while (bars.length < n) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      bars.push({
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate(),
        ).padStart(2, '0')}`,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 1_000_000,
      });
    }
    i++;
  }
  return bars;
}

function makeBacktest(): BacktestResult {
  return {
    totalReturn: 10,
    annualizedReturn: 15,
    sharpeRatio: 1.5,
    maxDrawdown: 10,
    winRate: 50,
    tradeCount: 50,
    profitFactor: 1.5,
    equityCurve: [{ date: '2024-01-02', value: 100 }],
    trades: [],
    benchmark: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedParse.mockImplementation((input) =>
    typeof input === 'string'
      ? { ...makeStrategy(), name: `解析:${input}` }
      : input,
  );
  mockedFetch.mockResolvedValue(makeBars(40));
  mockedRunBacktest.mockReturnValue(makeBacktest());
  mockedOrchestrate.mockResolvedValue({
    dataQuality: { overallScore: 95 } as DataQualityReport,
    audit: { riskScore: 80 } as AuditReport,
    optimization: { suggestions: [] } as unknown as OptimizationReport,
  });
  mockedSummary.mockReturnValue('综合摘要文本');
});

describe('runQuantPipeline', () => {
  it('完整流程：解析→取数→回测→编排→摘要，并汇报进度', async () => {
    const onProgress = vi.fn();
    const report = await runQuantPipeline('双均线策略', onProgress);

    expect(mockedParse).toHaveBeenCalledWith('双均线策略');
    expect(mockedFetch).toHaveBeenCalledWith('600519', '2023-01-01', '2025-01-01');
    expect(mockedRunBacktest).toHaveBeenCalledTimes(1);
    expect(mockedOrchestrate).toHaveBeenCalledTimes(1);
    expect(mockedSummary).toHaveBeenCalledTimes(1);

    expect(report.strategy.name).toBe('解析:双均线策略');
    expect(report.dataQuality.overallScore).toBe(95);
    expect(report.audit.riskScore).toBe(80);
    expect(report.optimization.suggestions).toEqual([]);
    expect(report.summary).toBe('综合摘要文本');
    expect(report.confidence).toContain('基于40个交易日数据回测');
    expect(report.limitations.length).toBeGreaterThan(0);

    // 编排函数内部不发进度，仅流水线自身汇报
    expect(onProgress.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['parsing', 5],
      ['data_fetch', 15],
      ['backtest', 30],
      ['summary', 95],
      ['complete', 100],
    ]);
  });

  it('历史数据不足30条时抛出错误，且不执行回测', async () => {
    mockedFetch.mockResolvedValue(makeBars(10));
    await expect(runQuantPipeline('双均线策略')).rejects.toThrow(
      '历史数据不足（仅10条），请扩大时间范围',
    );
    expect(mockedRunBacktest).not.toHaveBeenCalled();
    expect(mockedOrchestrate).not.toHaveBeenCalled();
  });

  it('结构化配置输入透传', async () => {
    const cfg = makeStrategy();
    await runQuantPipeline(cfg);
    expect(mockedParse).toHaveBeenCalledWith(cfg);
    expect(mockedFetch).toHaveBeenCalledWith(cfg.stockCode, cfg.startDate, cfg.endDate);
  });
});

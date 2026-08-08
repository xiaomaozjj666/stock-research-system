import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, getTool, executeToolCall, type ToolDeps } from '../tools.js';

describe('tool registry', () => {
  it('defines valid OpenAI-compatible tool schemas', () => {
    expect(TOOL_DEFINITIONS.length).toBe(4);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe('function');
      expect(t.function.name).toBeTruthy();
      expect(t.function.parameters.type).toBe('object');
      expect(t.function.parameters.properties).toBeTypeOf('object');
    }
  });

  it('getTool finds by name', () => {
    expect(getTool('run_analysis')?.function.name).toBe('run_analysis');
    expect(getTool('nope')).toBeUndefined();
  });

  it('returns error string for unknown tool (non-throwing)', async () => {
    const r = await executeToolCall({ id: '1', type: 'function', function: { name: 'nope', arguments: '{}' } }, {});
    expect(r).toContain('未知工具');
  });

  it('run_analysis calls deps and serializes result', async () => {
    const deps: ToolDeps = { runAnalysis: async (c) => ({ stock_pool: [{ stock_name: c, total_score: 90 }] }) };
    const r = await executeToolCall({ id: '1', type: 'function', function: { name: 'run_analysis', arguments: JSON.stringify({ stockCode: '600519' }) } }, deps);
    expect(r).toContain('600519');
  });

  it('run_analysis validates 6-digit code', async () => {
    const deps: ToolDeps = { runAnalysis: async () => ({}) };
    const r = await executeToolCall({ id: '1', type: 'function', function: { name: 'run_analysis', arguments: JSON.stringify({ stockCode: 'abc' }) } }, deps);
    expect(r).toContain('6 位');
  });

  it('run_backtest wires parse/fetch/run', async () => {
    const deps: ToolDeps = {
      parseStrategyInput: (s) => ({ stockCode: String((s as { stockCode: string }).stockCode), strategy: 'ma_cross' }),
      fetchOHLCVData: async () => [{ date: '2023-01-01', open: 1, close: 1, high: 1, low: 1, volume: 1 }],
      runBacktest: async () => ({ sharpe: 1.2 }),
    };
    const r = await executeToolCall({ id: '1', type: 'function', function: { name: 'run_backtest', arguments: JSON.stringify({ stockCode: '600519', strategy: 'ma_cross' }) } }, deps);
    expect(r).toContain('sharpe');
  });

  it('evaluate_backtest 跑基线+实验对比，返回 comparison 结构', async () => {
    let callCount = 0;
    const deps: ToolDeps = {
      parseStrategyInput: () => ({ stockCode: '', strategy: 'ma_cross' }),
      fetchOHLCVData: async () => [{ date: '2023-01-01', open: 1, close: 1, high: 1, low: 1, volume: 1 }],
      // 第一次=基线，第二次=实验组（带 newsOverlay 调用时收益更高）
      runBacktest: async (_ohlcv, cfg) => {
        callCount++;
        const hasNews = (cfg as { newsOverlay?: unknown }).newsOverlay !== undefined;
        return {
          totalReturn: hasNews ? 20 : 10,
          annualizedReturn: hasNews ? 12 : 5,
          sharpeRatio: hasNews ? 1.8 : 1.2,
          maxDrawdown: hasNews ? 10 : 15,
          winRate: hasNews ? 65 : 55,
          profitFactor: hasNews ? 2.0 : 1.8,
          tradeCount: 0,
          equityCurve: Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, value: 10000 * (1 + (hasNews ? 0.002 : 0.001) * i) })),
          trades: [],
          benchmark: [],
        };
      },
      extractNewsSignal: async () => ({ signal: { polarity: 0.6, hasNews: true }, source: 'live' }),
    };
    const r = await executeToolCall({ id: '1', type: 'function', function: { name: 'evaluate_backtest', arguments: JSON.stringify({ stockCode: '600519', strategy: 'ma_cross' }) } }, deps);
    expect(callCount).toBe(2); // 基线 + 实验组各一次
    const parsed = JSON.parse(r);
    expect(parsed.verdict).toBe('experiment_wins');
    expect(parsed.alphaAnnualized).toBe(7);
  });

  it('evaluate_backtest 无新闻时实验组退化为基线，判 tie', async () => {
    const deps: ToolDeps = {
      parseStrategyInput: () => ({ stockCode: '', strategy: 'ma_cross' }),
      fetchOHLCVData: async () => [{ date: '2023-01-01', open: 1, close: 1, high: 1, low: 1, volume: 1 }],
      runBacktest: async () => ({
        totalReturn: 10, annualizedReturn: 5, sharpeRatio: 1.2, maxDrawdown: 15,
        winRate: 55, profitFactor: 1.8, tradeCount: 0,
        equityCurve: Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, value: 10000 + i })),
        trades: [], benchmark: [],
      }),
      extractNewsSignal: async () => ({ signal: { polarity: 0, hasNews: false }, source: 'none' }),
    };
    const r = await executeToolCall({ id: '1', type: 'function', function: { name: 'evaluate_backtest', arguments: JSON.stringify({ stockCode: '600519', strategy: 'ma_cross' }) } }, deps);
    const parsed = JSON.parse(r);
    // 两组完全相同 → tie
    expect(parsed.verdict).toBe('tie');
  });

  it('evaluate_backtest 校验 6 位代码', async () => {
    const deps: ToolDeps = {
      parseStrategyInput: () => ({ stockCode: '', strategy: 'ma_cross' }),
      fetchOHLCVData: async () => [],
      runBacktest: async () => ({}),
    };
    const r = await executeToolCall({ id: '1', type: 'function', function: { name: 'evaluate_backtest', arguments: JSON.stringify({ stockCode: 'abc', strategy: 'ma_cross' }) } }, deps);
    expect(r).toContain('6 位');
  });
});

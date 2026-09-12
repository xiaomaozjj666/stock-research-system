import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, getTool, executeToolCall, type ToolDeps } from '../tools.js';

describe('tool registry', () => {
  it('defines valid OpenAI-compatible tool schemas', () => {
    expect(TOOL_DEFINITIONS.length).toBe(10);
    expect(TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual([
      'run_analysis',
      'compare_stocks',
      'run_backtest',
      'evaluate_backtest',
      'get_screener_latest',
      'get_factor_experiments',
      'run_timeseries_analyze',
      'list_recent_digests',
      'get_recent_announcements',
      'run_valuation_model',
    ]);
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
    const r = await executeToolCall(
      { id: '1', type: 'function', function: { name: 'nope', arguments: '{}' } },
      {},
    );
    expect(r).toContain('未知工具');
  });

  it('run_analysis calls deps and serializes result', async () => {
    const deps: ToolDeps = {
      runAnalysis: async (c) => ({ stock_pool: [{ stock_name: c, total_score: 90 }] }),
    };
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: { name: 'run_analysis', arguments: JSON.stringify({ stockCode: '600519' }) },
      },
      deps,
    );
    expect(r).toContain('600519');
  });

  it('run_analysis validates 6-digit code', async () => {
    const deps: ToolDeps = { runAnalysis: async () => ({}) };
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: { name: 'run_analysis', arguments: JSON.stringify({ stockCode: 'abc' }) },
      },
      deps,
    );
    expect(r).toContain('6 位');
  });

  it('run_backtest wires parse/fetch/run', async () => {
    const deps: ToolDeps = {
      parseStrategyInput: (s) => ({
        stockCode: String((s as { stockCode: string }).stockCode),
        strategy: 'ma_cross',
      }),
      fetchOHLCVData: async () => [
        { date: '2023-01-01', open: 1, close: 1, high: 1, low: 1, volume: 1 },
      ],
      runBacktest: async () => ({ sharpe: 1.2 }),
    };
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'run_backtest',
          arguments: JSON.stringify({ stockCode: '600519', strategy: 'ma_cross' }),
        },
      },
      deps,
    );
    expect(r).toContain('sharpe');
  });

  it('run_backtest 校验 6 位代码（与 run_analysis/evaluate_backtest 对齐）', async () => {
    const deps: ToolDeps = {
      parseStrategyInput: () => ({ stockCode: '', strategy: 'ma_cross' }),
      fetchOHLCVData: async () => [],
      runBacktest: async () => ({}),
    };
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'run_backtest',
          arguments: JSON.stringify({ stockCode: 'abc', strategy: 'ma_cross' }),
        },
      },
      deps,
    );
    expect(r).toContain('6 位');
  });

  it('compare_stocks 并行分析 2-3 只股票', async () => {
    const analyzed: string[] = [];
    const deps: ToolDeps = {
      runAnalysis: async (c) => {
        analyzed.push(c);
        return { stock_pool: [{ stock_name: c, total_score: 80 }] };
      },
    };
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'compare_stocks',
          arguments: JSON.stringify({ stockCodes: ['600519', '000001'] }),
        },
      },
      deps,
    );
    expect(analyzed).toEqual(['600519', '000001']); // 每只各分析一次
    expect(r).toContain('600519');
    expect(r).toContain('000001');
  });

  it('compare_stocks 数量非 2-3 时拒绝', async () => {
    const deps: ToolDeps = { runAnalysis: async () => ({}) };
    for (const codes of [['600519'], ['600519', '000001', '300750', '601318']]) {
      const r = await executeToolCall(
        {
          id: '1',
          type: 'function',
          function: { name: 'compare_stocks', arguments: JSON.stringify({ stockCodes: codes }) },
        },
        deps,
      );
      expect(r).toContain('请选择 2-3 只股票');
    }
  });

  it('compare_stocks 未配置 deps 时返回错误', async () => {
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'compare_stocks',
          arguments: JSON.stringify({ stockCodes: ['600519', '000001'] }),
        },
      },
      {},
    );
    expect(r).toContain('compare_stocks 未配置');
  });

  it('evaluate_backtest 跑基线+实验对比，返回 comparison 结构', async () => {
    let callCount = 0;
    const deps: ToolDeps = {
      parseStrategyInput: () => ({ stockCode: '', strategy: 'ma_cross' }),
      fetchOHLCVData: async () => [
        { date: '2023-01-01', open: 1, close: 1, high: 1, low: 1, volume: 1 },
      ],
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
          equityCurve: Array.from({ length: 40 }, (_, i) => ({
            date: `d${i}`,
            value: 10000 * (1 + (hasNews ? 0.002 : 0.001) * i),
          })),
          trades: [],
          benchmark: [],
        };
      },
      extractNewsSignal: async () => ({
        signal: {
          polarity: 0.6,
          hasNews: true,
          // 带发布日期：evaluate_backtest 会取最早日期作为 newsOverlay.since（防前视偏差）
          items: [{ id: 'n1', title: '利好', publishedAt: '2025-06-01T09:00:00Z' }],
        },
        source: 'live',
      }),
    };
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'evaluate_backtest',
          arguments: JSON.stringify({ stockCode: '600519', strategy: 'ma_cross' }),
        },
      },
      deps,
    );
    expect(callCount).toBe(2); // 基线 + 实验组各一次
    const parsed = JSON.parse(r);
    expect(parsed.verdict).toBe('experiment_wins');
    expect(parsed.alphaAnnualized).toBe(7);
  });

  it('evaluate_backtest 无新闻时实验组退化为基线，判 tie', async () => {
    const deps: ToolDeps = {
      parseStrategyInput: () => ({ stockCode: '', strategy: 'ma_cross' }),
      fetchOHLCVData: async () => [
        { date: '2023-01-01', open: 1, close: 1, high: 1, low: 1, volume: 1 },
      ],
      runBacktest: async () => ({
        totalReturn: 10,
        annualizedReturn: 5,
        sharpeRatio: 1.2,
        maxDrawdown: 15,
        winRate: 55,
        profitFactor: 1.8,
        tradeCount: 0,
        equityCurve: Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, value: 10000 + i })),
        trades: [],
        benchmark: [],
      }),
      extractNewsSignal: async () => ({ signal: { polarity: 0, hasNews: false }, source: 'none' }),
    };
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'evaluate_backtest',
          arguments: JSON.stringify({ stockCode: '600519', strategy: 'ma_cross' }),
        },
      },
      deps,
    );
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
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'evaluate_backtest',
          arguments: JSON.stringify({ stockCode: 'abc', strategy: 'ma_cross' }),
        },
      },
      deps,
    );
    expect(r).toContain('6 位');
  });
});

describe('量化研究工具（初筛/台账/时序/简报）', () => {
  it('get_screener_latest：有记录返回 JSON，无记录给可执行提示', async () => {
    const r1 = await executeToolCall(
      { id: '1', type: 'function', function: { name: 'get_screener_latest', arguments: '{}' } },
      { getScreenerLatest: () => ({ at: '2026-09-12T10:00:00.000Z', hits: [1, 2] }) },
    );
    expect(r1).toContain('2026-09-12');
    const r2 = await executeToolCall(
      { id: '2', type: 'function', function: { name: 'get_screener_latest', arguments: '{}' } },
      { getScreenerLatest: () => null },
    );
    expect(r2).toContain('还没有初筛记录');
    expect(r2).toContain('/api/quant/screener/run');
  });

  it('get_factor_experiments：透传概览 JSON', async () => {
    const r = await executeToolCall(
      { id: '1', type: 'function', function: { name: 'get_factor_experiments', arguments: '{}' } },
      {
        getFactorExperimentSummary: () => ({
          total: 30,
          kept: 4,
          keptExpectedFalse: 0.2,
        }),
      },
    );
    expect(r).toContain('"keptExpectedFalse": 0.2');
  });

  it('run_timeseries_analyze：未配置/代码非法/缺 code2 均有明确提示', async () => {
    const r1 = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'run_timeseries_analyze',
          arguments: '{"test":"garch","stockCode":"600519"}',
        },
      },
      {},
    );
    expect(r1).toContain('未配置');
    const r2 = await executeToolCall(
      {
        id: '2',
        type: 'function',
        function: {
          name: 'run_timeseries_analyze',
          arguments: '{"test":"garch","stockCode":"abc"}',
        },
      },
      { runTimeseriesAnalyze: async () => ({}) },
    );
    expect(r2).toContain('6 位');
    const r3 = await executeToolCall(
      {
        id: '3',
        type: 'function',
        function: {
          name: 'run_timeseries_analyze',
          arguments: '{"test":"coint","stockCode":"600036"}',
        },
      },
      { runTimeseriesAnalyze: async () => ({}) },
    );
    expect(r3).toContain('code2');
  });

  it('run_timeseries_analyze：透传到注入实现（含 code2）', async () => {
    const seen: { test: string; code: string; code2?: string }[] = [];
    const r = await executeToolCall(
      {
        id: '1',
        type: 'function',
        function: {
          name: 'run_timeseries_analyze',
          arguments: JSON.stringify({ test: 'coint', stockCode: '600036', code2: '601318' }),
        },
      },
      {
        runTimeseriesAnalyze: async (input) => {
          seen.push(input);
          return { test: input.test, ok: true };
        },
      },
    );
    expect(seen[0]).toEqual({ test: 'coint', code: '600036', code2: '601318' });
    expect(r).toContain('"ok": true');
  });

  it('list_recent_digests：空列表给生成提示；limit 钳制到 [1,20]', async () => {
    const r1 = await executeToolCall(
      { id: '1', type: 'function', function: { name: 'list_recent_digests', arguments: '{}' } },
      { listDigests: () => [] },
    );
    expect(r1).toContain('还没有研究简报');
    const seen: number[] = [];
    await executeToolCall(
      {
        id: '2',
        type: 'function',
        function: { name: 'list_recent_digests', arguments: '{"limit":999}' },
      },
      {
        listDigests: (limit?: number) => {
          seen.push(limit ?? -1);
          return [{ id: 'a' }];
        },
      },
    );
    expect(seen[0]).toBe(20);
  });
});

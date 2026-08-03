import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, getTool, executeToolCall, type ToolDeps } from '../tools.js';

describe('tool registry', () => {
  it('defines valid OpenAI-compatible tool schemas', () => {
    expect(TOOL_DEFINITIONS.length).toBe(3);
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
});

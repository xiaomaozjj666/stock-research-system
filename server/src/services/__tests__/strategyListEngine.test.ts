import { describe, it, expect } from 'vitest';
import { generateStrategyList } from '../strategyListEngine.js';
import type { OHLCVData } from '../../quant/types.js';

function uptrendSeries(n = 80, flat = 25, low = 100, high = 220): OHLCVData[] {
  const out: OHLCVData[] = [];
  const base = new Date('2025-01-01').getTime();
  for (let i = 0; i < n; i++) {
    const price = i < flat ? low : low + ((high - low) * (i - flat)) / (n - 1 - flat);
    const d = new Date(base + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    out.push({ date: d, open: price, close: Math.round(price * 100) / 100, high: price + 1, low: price - 1, volume: 1_000_000 });
  }
  return out;
}

const ohlcv = uptrendSeries();

describe('generateStrategyList 新闻感知', () => {
  it('不传 newsSignal 时各策略无 newsAware', async () => {
    const list = await generateStrategyList('600519', ohlcv, null);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => !s.newsAware)).toBe(true);
  });

  it('传入 newsSignal 时各策略返回 newsAware 且姿态正确', async () => {
    const list = await generateStrategyList('600519', ohlcv, { polarity: -0.5 });
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s.newsAware).toBeDefined();
      expect(s.newsAware!.posture).toBeCloseTo(0.25, 6);
    }
  });

  it('强烈利空(polarity=-1) → 姿态0，含新闻回测收益为0', async () => {
    const list = await generateStrategyList('600519', ohlcv, { polarity: -1 });
    for (const s of list) {
      expect(s.newsAware!.posture).toBeCloseTo(0, 6);
      expect(s.newsAware!.totalReturn).toBeCloseTo(0, 6);
    }
  });
});

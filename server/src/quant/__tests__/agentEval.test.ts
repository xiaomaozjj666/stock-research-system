import { describe, it, expect } from 'vitest';
import { runBacktest } from '../backtestEngine.js';
import { walkForwardBacktest } from '../walkForward.js';
import type { StrategyConfig } from '../types.js';

function makeOHLCV(n: number) {
  const a: {
    date: string;
    open: number;
    close: number;
    high: number;
    low: number;
    volume: number;
  }[] = [];
  for (let i = 0; i < n; i++) {
    const p = 100 * (1 + Math.sin(i / 6) * 0.02);
    const day = String((i % 28) + 1).padStart(2, '0');
    a.push({
      date: `2023-01-${day}`,
      open: p,
      close: p,
      high: p * 1.01,
      low: p * 0.99,
      volume: 1000,
    });
  }
  return a;
}

const cfg = {
  stockCode: '600519',
  strategyType: 'ma_cross',
  startDate: '2023-01-01',
  endDate: '2023-12-31',
} as unknown as StrategyConfig;

/**
 * 受控评估：验证"纯数学内核" + "新闻叠加（LLM 将喂入的极性）"的机制确实生效，
 * 并确认 walk-forward 样本外纪律可计算。对标 arXiv Profit Mirage：任何 LLM 层
 * 都必须套用 OOS 审计，避免把记忆当预测。
 */
describe('agent eval harness', () => {
  it('news overlay (LLM 喂入极性) 改变回测结果', () => {
    const data = makeOHLCV(160);
    const base = runBacktest(data, cfg);
    const news = runBacktest(data, { ...cfg, newsOverlay: { polarity: 0.8 } });
    expect(news).not.toEqual(base);
    expect(typeof (news as { totalReturn?: number }).totalReturn).toBe('number');
  });

  it('walk-forward 产出样本外稳健性指标', () => {
    const data = makeOHLCV(220);
    const wf = walkForwardBacktest(runBacktest, data, cfg, {
      trainSize: 60,
      testSize: 30,
      step: 30,
    });
    expect(wf.folds.length).toBeGreaterThan(0);
    expect(typeof wf.oosRatio).toBe('number');
    expect(wf.oosRatio).toBeGreaterThanOrEqual(0);
    expect(typeof wf.stable).toBe('boolean');
  });
});

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
  const start = new Date(Date.UTC(2023, 0, 1));
  for (let i = 0; i < n; i++) {
    const p = 100 * (1 + Math.sin(i / 6) * 0.02);
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    a.push({
      date: d.toISOString().slice(0, 10),
      open: p,
      close: p,
      high: p * 1.01,
      low: p * 0.99,
      volume: 1000,
    });
  }
  return a;
}

// 注意字段名必须是 type（StrategyConfig 只有 type 字段）：此前误用 strategyType，
// 引擎会落入 default → 'hold' 分支，整个回测零交易、两个用例恒通过（测错东西）。
const cfg = {
  name: '双均线',
  type: 'ma_cross',
  stockCode: '600519',
  params: { shortPeriod: 5, longPeriod: 20 },
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
    // 策略必须真实产生交易（ma_cross 金叉），否则下面的断言没有意义
    expect(base.tradeCount).toBeGreaterThan(0);
    expect(typeof (news as { totalReturn?: number }).totalReturn).toBe('number');
    expect(news).not.toEqual(base);
    expect((news as { totalReturn?: number }).totalReturn).not.toBe(
      (base as { totalReturn?: number }).totalReturn,
    );
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
    // 策略真实产生交易后，样本内/样本外夏普应非零（此前恒 0，断言退化为恒真）
    expect(wf.avgTrainSharpe).not.toBe(0);
    expect(wf.avgTestSharpe).not.toBe(0);
  });
});

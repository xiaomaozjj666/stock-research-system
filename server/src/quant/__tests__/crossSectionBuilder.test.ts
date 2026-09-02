/**
 * 截面因子编排器测试
 * ----------------------------------------------------------------------------
 * 重点验证装配正确性（观测结构 / 远期收益口径 / 基本面常数语义 / 降级披露），
 * IC 数值本身的正确性由 factorEvaluation 评估器的既有测试覆盖。
 */
import { describe, it, expect } from 'vitest';
import { buildCrossSectionPanel, type StockPanelInput } from '../crossSectionBuilder.js';
import { evaluateFactor } from '../factorEvaluation.js';
import type { OHLCVData } from '../types.js';
import type { FinancialData } from '../../types.js';

/** 生成 n 根确定性 K 线（各股不同漂移，保证截面差异） */
function barsFor(code: string, n: number, drift: number): OHLCVData[] {
  const out: OHLCVData[] = [];
  const base = new Date('2024-01-01').getTime();
  let price = 100;
  for (let i = 0; i < n; i++) {
    price = price * (1 + drift / 252 + 0.01 * Math.sin(i / 7 + code.charCodeAt(3)));
    const close = Math.round(price * 100) / 100;
    const d = new Date(base + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    out.push({ date: d, open: close, high: close, low: close, close, volume: 1_000_000 });
  }
  return out;
}

function financialFor(roe: number, margin: number): FinancialData {
  return {
    years: ['2024', '2025'],
    revenue: [100, 120],
    netProfit: [10, 12],
    grossMargin: [margin, margin + 1],
    netMargin: [10, 12],
    roe: [roe - 2, roe],
    operatingCashFlow: [11, 13],
    eps: [1, 1.2],
    totalAssets: [500, 550],
    totalLiabilities: [100, 110],
    equity: [400, 440],
    accountsReceivable: [5, 6],
    inventory: [10, 12],
    goodwill: [0, 0],
    debtRatio: [20, 21],
    dataQuality: { estimatedFields: [], missingFields: [] },
  };
}

const HORIZONS = [21];
const N_BARS = 300; // ≥ MIN_FACTOR_LOOKBACK(253) + 21，保证量价因子序列非空

describe('buildCrossSectionPanel 面板装配', () => {
  const inputs: StockPanelInput[] = [
    { code: '600519', bars: barsFor('600519', N_BARS, 0.3), financial: financialFor(30, 90) },
    { code: '000858', bars: barsFor('000858', N_BARS, 0.0), financial: financialFor(15, 60) },
    { code: '300750', bars: barsFor('300750', N_BARS, -0.2), financial: financialFor(5, 20) },
  ];
  const panel = buildCrossSectionPanel(inputs, HORIZONS);

  it('三只股票全部纳入，量价因子面板非空且观测含股票代码', () => {
    expect(panel.stocksIncluded).toEqual(['600519', '000858', '300750']);
    expect(panel.stocksSkipped).toEqual([]);
    const names = Object.keys(panel.priceVolume);
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) {
      for (const o of panel.priceVolume[name]) {
        expect(o.symbol).toBeTruthy();
      }
    }
  });

  it('远期收益口径：returns[21] = close(t+21)/close(t) − 1（抽查一行）', () => {
    const obs = panel.priceVolume.volatility_1m;
    expect(obs.length).toBeGreaterThan(0);
    const o = obs[0];
    const bars = inputs.find((i) => i.code === o.symbol)!.bars;
    const i = bars.findIndex((b) => b.date === o.date);
    expect(o.returns[21]).toBeCloseTo(bars[i + 21].close / bars[i].close - 1, 12);
  });

  it('基本面观测每股恒定：同一股票的所有 cs_roe 观测值相同', () => {
    const roe = panel.fundamental.cs_roe;
    expect(roe.length).toBeGreaterThan(0);
    const bySymbol = new Map<string, Set<number>>();
    for (const o of roe) {
      if (!o.symbol) continue;
      let set = bySymbol.get(o.symbol);
      if (!set) {
        set = new Set<number>();
        bySymbol.set(o.symbol, set);
      }
      set.add(o.value);
    }
    expect(bySymbol.get('600519')).toEqual(new Set([30]));
    expect(bySymbol.get('300750')).toEqual(new Set([5]));
    // 远期收益非常数（逐日变化），确认面板确实带时间维度的 returns
    const m = roe.filter((o) => o.symbol === '600519');
    expect(new Set(m.map((o) => o.returns[21])).size).toBeGreaterThan(1);
  });

  it('K 线不足的股票被降级披露，不进入面板', () => {
    const short: StockPanelInput[] = [
      ...inputs,
      { code: '000001', bars: barsFor('000001', 5, 0.1), financial: financialFor(8, 30) },
    ];
    const p = buildCrossSectionPanel(short, HORIZONS);
    expect(p.stocksSkipped).toEqual([{ code: '000001', reason: 'K线不足（5 根）' }]);
    for (const name of Object.keys(p.priceVolume)) {
      expect(p.priceVolume[name].some((o) => o.symbol === '000001')).toBe(false);
    }
  });

  it('面板喂入截面评估器：periods 与持有期一致，IC 序列非空且带 OOS 复核', () => {
    // 用「截面市值排序」语义的常数因子（cs_roe）走 evaluateFactor：
    // 每日 3 只股票的截面 + 漂移差异较大的远期收益 → 截面 IC 可计算
    const report = evaluateFactor(panel.fundamental.cs_roe);
    expect(report.periods).toEqual([21]);
    const periodReport = report.byPeriod[0];
    expect(periodReport.ic.n).toBeGreaterThan(0);
    expect(periodReport.oos).toBeDefined();
    expect(periodReport.oos.isN + periodReport.oos.oosN).toBeGreaterThan(0);
  });
});

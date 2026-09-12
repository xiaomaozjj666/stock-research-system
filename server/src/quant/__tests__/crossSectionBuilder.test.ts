/**
 * 截面因子编排器测试
 * ----------------------------------------------------------------------------
 * 重点验证装配正确性（观测结构 / 远期收益口径 / 基本面 PIT 语义 / 降级披露），
 * IC 数值本身的正确性由 factorEvaluation 评估器的既有测试覆盖。
 */
import { describe, it, expect } from 'vitest';
import { buildCrossSectionPanel, type StockPanelInput } from '../crossSectionBuilder.js';
import { evaluateFactor } from '../factorEvaluation.js';
import type { OHLCVData } from '../types.js';
import type { QuarterlySeries } from '../../services/quarterlyFinancials.js';

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

const HORIZONS = [21];
const N_BARS = 300; // ≥ MIN_FACTOR_LOOKBACK(253) + 21，保证量价因子序列非空

describe('buildCrossSectionPanel 面板装配', () => {
  const inputs: StockPanelInput[] = [
    { code: '600519', bars: barsFor('600519', N_BARS, 0.3) },
    { code: '000858', bars: barsFor('000858', N_BARS, 0.0) },
    { code: '300750', bars: barsFor('300750', N_BARS, -0.2) },
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

  it('K 线不足的股票被降级披露，不进入面板', () => {
    const short: StockPanelInput[] = [
      ...inputs,
      { code: '000001', bars: barsFor('000001', 5, 0.1) },
    ];
    const p = buildCrossSectionPanel(short, HORIZONS);
    expect(p.stocksSkipped).toEqual([{ code: '000001', reason: 'K线不足（5 根）' }]);
    for (const name of Object.keys(p.priceVolume)) {
      expect(p.priceVolume[name].some((o) => o.symbol === '000001')).toBe(false);
    }
  });
});

describe('buildCrossSectionPanel — 基本面因子 PIT 语义（公告日门控）', () => {
  /** 两份报告：ROE 10 于 2024-01-10 公告、ROE 12 于 2024-04-20 公告 */
  function pitQuarterly(roe2 = 12): QuarterlySeries {
    return {
      code: '600519',
      source: 'eastmoney_f10',
      reports: [
        {
          reportDate: '2023-12-31',
          noticeDate: '2024-01-10',
          revenue: 100,
          netProfit: 20,
          roe: 10,
          grossMargin: 50,
          debtRatio: 30,
          revenueYoY: 10,
          netProfitYoY: 10,
        },
        {
          reportDate: '2024-03-31',
          noticeDate: '2024-04-20',
          revenue: 110,
          netProfit: 24,
          roe: roe2,
          grossMargin: 51,
          debtRatio: 29,
          revenueYoY: 11,
          netProfitYoY: 12,
        },
      ],
    };
  }

  it('公告前无观测；公告后取「已公告最新值」；新公告日跳变', () => {
    const p = buildCrossSectionPanel(
      [{ code: '600519', bars: barsFor('600519', N_BARS, 0.1), quarterly: pitQuarterly() }],
      HORIZONS,
    );
    const roe = p.fundamental.cs_roe;
    expect(roe.length).toBeGreaterThan(0);
    const byDate = new Map(roe.map((o) => [o.date, o.value]));
    // 公告前（< 2024-01-10）：无观测——绝不回退到"未来值"
    expect(byDate.has('2024-01-05')).toBe(false);
    // 第一份公告后：ROE = 10
    expect(byDate.get('2024-01-15')).toBe(10);
    expect(byDate.get('2024-04-10')).toBe(10);
    // 第二份公告（2024-04-20）后：跳变为 12
    expect(byDate.get('2024-04-25')).toBe(12);
    expect(byDate.get('2024-08-01')).toBe(12);
    // 全窗口恰有两个相异值（两次公告间的阶梯）
    expect(new Set(roe.map((o) => o.value))).toEqual(new Set([10, 12]));
  });

  it('不同股票报告值不同 → 截面有区分度，评估器可算 IC 与 OOS', () => {
    const p = buildCrossSectionPanel(
      [
        { code: '600519', bars: barsFor('600519', N_BARS, 0.3), quarterly: pitQuarterly(30) },
        { code: '000858', bars: barsFor('000858', N_BARS, 0.0), quarterly: pitQuarterly(15) },
        { code: '300750', bars: barsFor('300750', N_BARS, -0.2), quarterly: pitQuarterly(5) },
      ],
      HORIZONS,
    );
    expect(p.fundamental.cs_roe.length).toBeGreaterThan(0);
    const report = evaluateFactor(p.fundamental.cs_roe);
    expect(report.periods).toEqual([21]);
    const periodReport = report.byPeriod[0];
    expect(periodReport.ic.n).toBeGreaterThan(0);
    expect(periodReport.oos).toBeDefined();
    expect(periodReport.oos.isN + periodReport.oos.oosN).toBeGreaterThan(0);
  });

  it('无季度数据的股票不参与基本面因子（量价不受影响）', () => {
    const p = buildCrossSectionPanel(
      [{ code: '600519', bars: barsFor('600519', N_BARS, 0.2) }],
      HORIZONS,
    );
    expect(p.fundamental.cs_roe).toEqual([]);
    expect(p.fundamental.cs_np_yoy_q).toEqual([]);
    expect(Object.keys(p.priceVolume).length).toBeGreaterThanOrEqual(5);
  });
});

describe('buildCrossSectionPanel — 季度派生因子（cs_np_yoy_q / cs_roe_slope）', () => {
  /** 四年报告链。growth 为逐年复利因子：不同的 growth 给出不同的单季同比路径
   *  （同比对整体缩放不变，必须改变「路径」而非「水平」才有截面差异）；
   *  ROE 随季号线性变化，斜率随 growth 差异化。 */
  function quarterlyFor(growth: number): QuarterlySeries {
    const chain: [string, number][] = [
      ['2021-03-31', 4],
      ['2021-06-30', 9],
      ['2021-09-30', 15],
      ['2021-12-31', 22],
      ['2022-03-31', 5],
      ['2022-06-30', 11],
      ['2022-09-30', 18],
      ['2022-12-31', 26],
      ['2023-03-31', 6],
      ['2023-06-30', 13],
      ['2023-09-30', 21],
      ['2023-12-31', 30],
      ['2024-03-31', 7],
      ['2024-06-30', 15],
      ['2024-09-30', 24],
      ['2024-12-31', 34],
    ];
    const reports = chain.map(([reportDate, np], i) => {
      const yearIdx = Math.floor(i / 4);
      const v = np * growth ** yearIdx;
      // ROE 在第 13 份报告（2024-03-31，窗口内公告）加水平跳变：严格线性序列的
      // OLS 斜率不随窗口增减变化，PIT 前后无法区分——跳变使公告前后斜率不同
      const roe = 10 + i * 0.5 * growth + (i >= 12 ? 2 : 0);
      return {
        reportDate,
        noticeDate: `${reportDate.slice(0, 4)}-04-22`,
        revenue: v * 10,
        netProfit: v,
        roe,
        grossMargin: 50,
        debtRatio: 30,
        revenueYoY: 10,
        netProfitYoY: 10,
      };
    });
    return { code: '600519', source: 'eastmoney_f10', reports };
  }

  it('带季度序列 → 季度因子面板非空、PIT 阶梯且随股票差异；无序列 → 如实为空', () => {
    const withQ = buildCrossSectionPanel(
      [
        { code: '600519', bars: barsFor('600519', N_BARS, 0.2), quarterly: quarterlyFor(1.0) },
        { code: '000858', bars: barsFor('000858', N_BARS, 0.0), quarterly: quarterlyFor(1.25) },
      ],
      HORIZONS,
    );
    for (const name of ['cs_np_yoy_q', 'cs_roe_slope'] as const) {
      const obs = withQ.fundamental[name];
      expect(obs.length).toBeGreaterThan(0);
      // PIT：窗口内 2024-04-22 公告（2024-03-31 报告）→ 该股恰有两个阶梯值
      const v519 = obs.filter((o) => o.symbol === '600519').map((o) => o.value);
      expect(new Set(v519).size).toBe(2);
      // 两股取值不同（截面有区分度）
      const v858 = obs.filter((o) => o.symbol === '000858').map((o) => o.value);
      expect(v858[0]).not.toBe(v519[0]);
    }

    const withoutQ = buildCrossSectionPanel(
      [{ code: '600519', bars: barsFor('600519', N_BARS, 0.2) }],
      HORIZONS,
    );
    expect(withoutQ.fundamental.cs_np_yoy_q).toEqual([]);
    expect(withoutQ.fundamental.cs_roe_slope).toEqual([]);
  });
});

describe('buildCrossSectionPanel — 两融因子（PIT + T+1 披露延迟）', () => {
  it('有 margin 序列的股票进入两融因子面板，观测结构与量价一致', () => {
    const bars = barsFor('600519', N_BARS, 0.1);
    const marginRows = Array.from({ length: N_BARS - 1 }, (_, i) => ({
      date: bars[i].date, // 行止于倒数第二根 bar：末根 bar 的取值仍来自严格早行
      balance: 1000 + i,
      balancePct: 2 + i * 0.01,
      netBuy: i,
    }));
    const panel = buildCrossSectionPanel([{ code: '600519', bars, margin: marginRows }], HORIZONS);
    expect(panel.stocksIncluded).toEqual(['600519']);
    // 两个两融因子都有观测（行数充足）
    for (const key of ['mg_balance_chg20', 'mg_balance_pct'] as const) {
      expect(panel.margin[key].length).toBeGreaterThan(30);
      const first = panel.margin[key][0];
      expect(first.symbol).toBe('600519');
      expect(Object.keys(first.returns)).toContain(String(HORIZONS[0]));
    }
    // 无 margin 的股票不产出两融观测
    const bare = buildCrossSectionPanel(
      [{ code: '000858', bars: barsFor('000858', N_BARS, 0.0) }],
      HORIZONS,
    );
    expect(bare.margin.mg_balance_pct).toHaveLength(0);
  });

  it('末根 bar 的两融取值不使用当日行（T+1 披露纪律在装配层生效）', () => {
    const bars = barsFor('600519', 60, 0.1);
    // 两融行覆盖全部 bar 日期（含末根）；末根 bar 的可用行只有倒数第二根之前
    const marginRows = bars.map((b, i) => ({
      date: b.date,
      balance: 1000 + i,
      balancePct: 2 + i * 0.01,
      netBuy: i,
    }));
    const panel = buildCrossSectionPanel([{ code: '600519', bars, margin: marginRows }], [21]);
    const dates = new Set(panel.margin.mg_balance_pct.map((o) => o.date));
    // bar[20] 的取值 = 严格早于它的最后一行（index 19）→ pct = 2 + 19*0.01
    const obs = panel.margin.mg_balance_pct.find((o) => o.date === bars[20].date);
    expect(obs?.value).toBeCloseTo(2 + 19 * 0.01, 10);
    // 末根 bar（窗口尾部无远期收益）与任何日期 ≥ 自身行的「当日值」都不出现
    expect(dates.has(bars[bars.length - 1].date)).toBe(false);
  });
});

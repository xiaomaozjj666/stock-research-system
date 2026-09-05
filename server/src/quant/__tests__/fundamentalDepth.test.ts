import { describe, it, expect } from 'vitest';
import type { QuarterlyReport, QuarterlySeries } from '../../services/quarterlyFinancials.js';
import {
  deriveSingleQuarter,
  earningsSurpriseSeries,
  roeSlope,
  quarterlySnapshotValue,
  buildEarningsSurpriseObservations,
} from '../fundamentalDepth.js';
import type { OHLCVData } from '../types.js';

/**
 * 两年 8 个报告期的累计口径 fixture（亿元）。
 * 单季净利：2024 = 10/12/14/16；2025 = 12/13.2/18.2/19.2
 * 单季净利同比：2025Q1=20%，Q2=10%，Q3=30%，Q4=20%
 */
function report(
  date: string,
  np: number | null,
  rev: number | null,
  notice?: string | null,
): QuarterlyReport {
  return {
    reportDate: date,
    noticeDate: notice === undefined ? `${date.slice(0, 4)}-04-22` : notice,
    revenue: rev,
    netProfit: np,
    roe: null,
    grossMargin: null,
    debtRatio: null,
    revenueYoY: null,
    netProfitYoY: null,
  };
}

const FIXTURE: QuarterlyReport[] = [
  report('2024-03-31', 10, 100),
  report('2024-06-30', 22, 210),
  report('2024-09-30', 36, 330),
  report('2024-12-31', 52, 460),
  report('2025-03-31', 12, 110),
  report('2025-06-30', 25.2, 224),
  report('2025-09-30', 43.4, 352),
  report('2025-12-31', 62.6, 496),
];

describe('deriveSingleQuarter — 累计差分与单季同比', () => {
  it('单季值 = 本季累计 − 上季累计；Q1 = 累计', () => {
    const pts = deriveSingleQuarter(FIXTURE);
    expect(pts).toHaveLength(8);
    const byDate = new Map(pts.map((p) => [p.reportDate, p]));
    expect(byDate.get('2024-03-31')?.netProfit).toBe(10);
    expect(byDate.get('2024-06-30')?.netProfit).toBe(12);
    expect(byDate.get('2025-06-30')?.netProfit).toBeCloseTo(13.2, 10);
    expect(byDate.get('2025-12-31')?.netProfit).toBeCloseTo(19.2, 10);
    // 营收同样差分
    expect(byDate.get('2025-09-30')?.revenue).toBe(128);
  });

  it('单季同比 = 单季值 / 去年同期单季值（跨财年查表）', () => {
    const pts = deriveSingleQuarter(FIXTURE);
    const byDate = new Map(pts.map((p) => [p.reportDate, p]));
    // 2024 年无 2023 基期 → 同比为 null
    expect(byDate.get('2024-06-30')?.netProfitYoY).toBeNull();
    expect(byDate.get('2025-03-31')?.netProfitYoY).toBeCloseTo(20, 10);
    expect(byDate.get('2025-06-30')?.netProfitYoY).toBeCloseTo(10, 10);
    expect(byDate.get('2025-09-30')?.netProfitYoY).toBeCloseTo(30, 10);
  });

  it('报告缺季 → 差分与同比如实为 null（不硬凑）', () => {
    // 缺 2024-09-30：2024Q4 单季无法差分；2025Q3 同比也缺基期链
    const broken = FIXTURE.filter((r) => r.reportDate !== '2024-09-30');
    const pts = deriveSingleQuarter(broken);
    const byDate = new Map(pts.map((p) => [p.reportDate, p]));
    expect(byDate.get('2024-12-31')?.netProfit).toBeNull();
    expect(byDate.get('2025-09-30')?.netProfitYoY).toBeNull();
    // 但 2025Q2 同比不受缺季影响（基期链 2024Q1/Q2 完整）
    expect(byDate.get('2025-06-30')?.netProfitYoY).toBeCloseTo(10, 10);
  });

  it('去年同期单季为零 → 同比为 null（绝不除零）', () => {
    // 2023 整条链单季全为 0：2024Q4 单季 16 对基期 0 无同比可言
    const full = [
      report('2023-09-30', 0, 0),
      report('2023-12-31', 0, 0),
      report('2024-09-30', 36, 330),
      report('2024-12-31', 52, 460),
    ];
    const pts = deriveSingleQuarter(full);
    const q4 = pts.find((p) => p.reportDate === '2024-12-31');
    expect(q4?.netProfit).toBe(16);
    // 去年同期单季 = 0 − 0 = 0 → 同比 null
    expect(q4?.netProfitYoY).toBeNull();
  });
});

describe('earningsSurpriseSeries — 单季同比相对前 4 季均值的偏离', () => {
  it('首期无前置样本 → 无 surprise；其后逐期计算', () => {
    const surprises = earningsSurpriseSeries(deriveSingleQuarter(FIXTURE));
    const byDate = new Map(surprises.map((s) => [s.reportDate, s]));
    expect(byDate.has('2025-03-31')).toBe(false); // 第一个同比点没有前置基期
    expect(byDate.get('2025-06-30')?.surprise).toBeCloseTo(-10, 10); // 10 − 20
    expect(byDate.get('2025-09-30')?.surprise).toBeCloseTo(15, 10); // 30 − (20+10)/2
    expect(byDate.get('2025-12-31')?.surprise).toBeCloseTo(0, 10); // 20 − (20+10+30)/3
  });
});

describe('roeSlope — ROE 逐季趋势', () => {
  const withRoe = (roes: (number | null)[]): QuarterlyReport[] =>
    roes.map((roe, i) => ({ ...report(`2024-0${i + 1}-15`, 1, 1), roe }));

  it('逐季上行 → 斜率为正；下行 → 负', () => {
    expect(roeSlope(withRoe([10, 11, 12, 13]))).toBeCloseTo(1, 6);
    expect(roeSlope(withRoe([13, 12, 11, 10]))).toBeCloseTo(-1, 6);
  });

  it('null 观测被剔除后不足 3 个 → null', () => {
    expect(roeSlope(withRoe([10, null, 12]))).toBeNull();
  });

  it('window 截取最近 N 个', () => {
    // 前 4 期平坦、后 2 期陡升：短窗口对尾部变化更敏感 → 截段斜率更大
    const all = withRoe([10, 10, 10, 10, 10, 20]);
    const s6 = roeSlope(all, 6);
    const s5 = roeSlope(all, 5);
    expect(s6).not.toBeNull();
    expect(s5).not.toBeNull();
    expect(s5 as number).toBeGreaterThan(s6 as number);
  });

  it('window < 3 → null（斜率守卫）', () => {
    expect(roeSlope(withRoe([10, 20]), 2)).toBeNull();
  });
});

describe('quarterlySnapshotValue — 季度快照因子', () => {
  const series: QuarterlySeries = { code: '600519', reports: FIXTURE, source: 'eastmoney_f10' };

  it('cs_np_yoy_q = 最新有限单季同比', () => {
    expect(quarterlySnapshotValue('cs_np_yoy_q', series)).toBeCloseTo(20, 10);
  });

  it('cs_roe_slope 有 roe 序列时给斜率，无则 NaN', () => {
    const withRoeSeries: QuarterlySeries = {
      code: '600519',
      reports: FIXTURE.map((r, i) => ({ ...r, roe: 10 + i })),
      source: 'eastmoney_f10',
    };
    expect(quarterlySnapshotValue('cs_roe_slope', withRoeSeries)).toBeCloseTo(1, 6);
    expect(quarterlySnapshotValue('cs_roe_slope', series)).toBeNaN();
  });
});

describe('buildEarningsSurpriseObservations — PEAD 事件面板', () => {
  /** n 根日频 K 线（date 单调即可），close 稳步上行保证收益为正 */
  function genBars(n: number, start = '2024-01-01'): OHLCVData[] {
    const out: OHLCVData[] = [];
    const d = new Date(start);
    for (let i = 0; i < n; i++) {
      out.push({
        date: d.toISOString().slice(0, 10),
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: 1_000_000,
      });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  /**
   * 两年完整基期链 + 2024 两次公告。
   * 单季同比：2023 = 25/20/16.67/14.29；2024Q1 = 2024Q2 = 100
   * 超预期：2024Q1 = 100 − mean(25,20,16.67,14.29) = 81.01
   *         2024Q2 = 100 − mean(20,16.67,14.29,100) = 62.26
   */
  const EVENT_REPORTS: QuarterlyReport[] = [
    report('2022-03-31', 4, null),
    report('2022-06-30', 9, null),
    report('2022-09-30', 15, null),
    report('2022-12-31', 22, null),
    report('2023-03-31', 5, null),
    report('2023-06-30', 11, null),
    report('2023-09-30', 18, null),
    report('2023-12-31', 26, null),
    report('2024-03-31', 10, null, '2024-04-20'),
    report('2024-06-30', 22, null, '2024-08-05'),
  ];

  it('事件窗口内逐日产出观测，窗口外无；值 = 该次公告的超预期幅度', () => {
    const obs = buildEarningsSurpriseObservations({
      code: '600519',
      reports: EVENT_REPORTS,
      bars: genBars(300),
      horizons: [5],
      decayDays: 10,
    });
    expect(obs.length).toBeGreaterThan(0);
    const dates = new Set(obs.map((o) => o.date));
    expect(dates.size).toBe(obs.length);
    for (const o of obs) {
      expect(o.symbol).toBe('600519');
      expect(Number.isFinite(o.returns[5])).toBe(true);
      expect(Number.isFinite(o.value)).toBe(true);
    }
    // 2024Q1 窗口 [04-20, +10)：值恒为 81.01
    const win1 = obs.filter((o) => o.date >= '2024-04-20' && o.date < '2024-04-30');
    expect(win1.length).toBe(10);
    expect(new Set(win1.map((o) => o.value))).toEqual(new Set([81.01]));
    // 2024Q2 窗口 [08-05, +10)：值恒为 62.26
    const win2 = obs.filter((o) => o.date >= '2024-08-05' && o.date < '2024-08-15');
    expect(win2.length).toBe(10);
    expect(new Set(win2.map((o) => o.value))).toEqual(new Set([62.26]));
    // 两窗口之外无观测
    expect(dates.has('2024-05-05')).toBe(false);
    expect(dates.has('2024-08-16')).toBe(false);
  });

  it('窗口重叠时新公告覆盖旧公告', () => {
    const overlapped = EVENT_REPORTS.map((r) =>
      r.reportDate === '2024-06-30' ? { ...r, noticeDate: '2024-04-24' } : r,
    );
    const obs = buildEarningsSurpriseObservations({
      code: '600519',
      reports: overlapped,
      bars: genBars(300),
      horizons: [5],
      decayDays: 10,
    });
    const byDate = new Map(obs.map((o) => [o.date, o.value]));
    // 04-21 只在 2024Q1 窗口内 → 81.01；04-25 已被 2024Q2（后公告）覆盖 → 62.26
    expect(byDate.get('2024-04-21')).toBeCloseTo(81.01, 2);
    expect(byDate.get('2024-04-25')).toBeCloseTo(62.26, 2);
  });

  it('缺公告日 / K 线不足的输入 → 空面板', () => {
    const noNotice = FIXTURE.map((r) => ({ ...r, noticeDate: null }));
    expect(
      buildEarningsSurpriseObservations({
        code: '600519',
        reports: noNotice,
        bars: genBars(300),
        horizons: [5],
      }),
    ).toEqual([]);
    expect(
      buildEarningsSurpriseObservations({
        code: '600519',
        reports: FIXTURE,
        bars: genBars(4),
        horizons: [5],
      }),
    ).toEqual([]);
  });
});

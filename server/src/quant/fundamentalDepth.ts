/**
 * 基本面深度因子（季度财报时间序列驱动）
 * --------------------------------------------------------------------------
 * 年报快照因子（cs_roe 等）回答「这家公司质量如何」，本模块回答两个更有
 * 交易含义的问题：
 *
 *   1. **盈利动能方向** —— 累计口径的同比掩盖了季度间的拐点：中报累计同比
 *      +10% 完全可能是「Q1 +30%、Q2 −5%」的减速路径。把累计值差分成单季值、
 *      再算单季同比，趋势一目了然；ROE 的逐季斜率（OLS）给出同类的方向度量。
 *   2. **业绩超预期（PEAD 事件因子）** —— 单季同比相对其前 4 季均值的偏离
 *      作为「超预期」度量；公告日后的 decayDays 个交易日内持有该信号，
 *      检验盈余公告后漂移（Post-Earnings Announcement Drift）在该股横截面上
 *      是否成立。事件窗口外无信号（NaN），由评估器整行丢弃——这与「把过期
 *      信号洗成 0」有本质区别：后者会把无事件的日子伪装成「中性事件」。
 *
 * 全部纯函数、无副作用；数值口径：净利/营收为亿元，同比/斜率为百分比。
 */

import type { OHLCVData } from './types.js';
import type { QuarterlyReport, QuarterlySeries } from '../services/quarterlyFinancials.js';
import type { FactorObservation } from './factorEvaluation.js';

/** 单季（差分后）盈利点 */
export interface SingleQuarterPoint {
  /** 报告期（YYYY-MM-DD） */
  reportDate: string;
  /** 公告日（缺公告的期为 null，不参与事件因子） */
  noticeDate: string | null;
  /** 财季 1~4（03-31→1，06-30→2，09-30→3，12-31→4） */
  quarter: 1 | 2 | 3 | 4;
  /** 单季归母净利（亿元）；Q1 直接取累计，Q2~Q4 为累计差分 */
  netProfit: number | null;
  /** 单季营收（亿元） */
  revenue: number | null;
  /** 单季净利同比（%）；去年同期单季缺失/为零时为 null */
  netProfitYoY: number | null;
  /** 单季营收同比（%） */
  revenueYoY: number | null;
}

function quarterOf(reportDate: string): 1 | 2 | 3 | 4 | null {
  const m = Number(reportDate.slice(5, 7));
  if (m === 3) return 1;
  if (m === 6) return 2;
  if (m === 9) return 3;
  if (m === 12) return 4;
  return null; // 非标准报告期（异常数据），不参与差分
}

/** 同比 = (cur − prev) / |prev| × 100；prev 缺失或为 0 → null（绝不除 0 / 洗成 0） */
function yoyPct(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 100 * 100) / 100;
}

/**
 * 把累计口径报告差分成单季序列（升序）。
 * 单季同比需要去年同期：至少 5 个报告期（跨两个财年）才会有第一个同比点。
 * 同一报告期重复行已在 parseQuarterlyRecords 去重，此处按报告期唯一处理。
 * 报告缺季（如某年三季报缺失）时相关差分/同比如实置 null，绝不硬凑。
 */
export function deriveSingleQuarter(reports: QuarterlyReport[]): SingleQuarterPoint[] {
  const asc = [...reports].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  // 「年-Qn」→ 报告 查表：差分与同比基期都是 O(1) 取，不重扫
  const byKey = new Map<string, QuarterlyReport>();
  for (const r of asc) {
    const q = quarterOf(r.reportDate);
    if (q === null) continue;
    byKey.set(`${r.reportDate.slice(0, 4)}-Q${q}`, r);
  }

  /** 单季值：Q1 = 累计；Q2~Q4 = 累计差分；本季或前季累计缺失 → null */
  const singleOf = (
    cur: number | null | undefined,
    prev: number | null | undefined,
    q: 1 | 2 | 3 | 4,
  ): number | null => {
    if (cur === null || cur === undefined) return null;
    if (q === 1) return cur;
    if (prev === null || prev === undefined) return null;
    return Math.round((cur - prev) * 100) / 100;
  };

  const out: SingleQuarterPoint[] = [];
  for (const cur of asc) {
    const q = quarterOf(cur.reportDate);
    if (q === null) continue;
    const year = Number(cur.reportDate.slice(0, 4));
    const prev = q > 1 ? byKey.get(`${year}-Q${q - 1}`) : undefined;
    const prevYearSameQ = byKey.get(`${year - 1}-Q${q}`);
    const prevYearPrevQ = q > 1 ? byKey.get(`${year - 1}-Q${q - 1}`) : undefined;

    const npSingle = singleOf(cur.netProfit, prev?.netProfit, q);
    const revSingle = singleOf(cur.revenue, prev?.revenue, q);
    const baseNp = singleOf(prevYearSameQ?.netProfit, prevYearPrevQ?.netProfit, q);
    const baseRev = singleOf(prevYearSameQ?.revenue, prevYearPrevQ?.revenue, q);

    out.push({
      reportDate: cur.reportDate,
      noticeDate: cur.noticeDate,
      quarter: q,
      netProfit: npSingle,
      revenue: revSingle,
      netProfitYoY: yoyPct(npSingle, baseNp),
      revenueYoY: yoyPct(revSingle, baseRev),
    });
  }
  return out;
}

/** 业绩超预期：单季净利同比 − 前 min(4, 可得) 季单季同比均值（百分点） */
export interface SurprisePoint {
  reportDate: string;
  noticeDate: string | null;
  /** 超预期幅度（百分点）；>0 = 高于近期趋势 */
  surprise: number;
  /** 该期单季净利同比（%） */
  netProfitYoY: number;
}

/**
 * 对全部有单季同比的报告计算超预期幅度（含历史各期——事件研究需要多期事件
 * 撑样本量，只算最新一期的话截面评估永远凑不齐 30 个观测）。
 * 前置样本不足（首个同比点之前无基期）时该期无 surprise。
 */
export function earningsSurpriseSeries(points: SingleQuarterPoint[]): SurprisePoint[] {
  const withYoY = points.filter((p) => p.netProfitYoY !== null);
  const out: SurprisePoint[] = [];
  for (let i = 0; i < withYoY.length; i++) {
    const prior = withYoY.slice(Math.max(0, i - 4), i).map((p) => p.netProfitYoY as number);
    if (prior.length === 0) continue;
    const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
    const yoy = withYoY[i].netProfitYoY as number;
    out.push({
      reportDate: withYoY[i].reportDate,
      noticeDate: withYoY[i].noticeDate,
      netProfitYoY: yoy,
      surprise: Math.round((yoy - mean) * 100) / 100,
    });
  }
  return out;
}

/**
 * ROE 逐季趋势：最近 window 个有限 ROE 观测对时间序号的 OLS 斜率（每季百分点）。
 * >0 盈利能力改善、<0 恶化。样本 < 3 时返回 null（斜率不可信）。
 */
export function roeSlope(reports: QuarterlyReport[], window = 6): number | null {
  const vals = [...reports]
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
    .map((r) => r.roe)
    .filter((v): v is number => v !== null)
    .slice(-window);
  const n = vals.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = vals.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < n; i++) {
    cov += (i - mx) * (vals[i] - my);
    varx += (i - mx) ** 2;
  }
  return varx > 0 ? Math.round((cov / varx) * 100) / 100 : null;
}

/** 季度快照因子（进入截面基本面面板，每股常数） */
export type QuarterlyFactorName = 'cs_np_yoy_q' | 'cs_roe_slope';

/**
 * 季度快照因子取值：最新单季净利同比（%）/ ROE 逐季斜率（每季百分点）。
 * 数据不足返回 NaN → 截面组装时如实剔除该股该因子。
 */
export function quarterlySnapshotValue(name: QuarterlyFactorName, series: QuarterlySeries): number {
  if (name === 'cs_np_yoy_q') {
    const points = deriveSingleQuarter(series.reports);
    for (let i = points.length - 1; i >= 0; i--) {
      const v = points[i].netProfitYoY;
      if (v !== null) return v;
    }
    return NaN;
  }
  return roeSlope(series.reports) ?? NaN;
}

export interface EventObservationOptions {
  code: string;
  reports: QuarterlyReport[];
  bars: OHLCVData[];
  /** 持有期（交易日）数组，与截面面板其余因子一致；每行须带全部持有期收益 */
  horizons: number[];
  /** 事件窗口长度（交易日，公告日后多少日内信号有效），默认 63 */
  decayDays?: number;
}

/**
 * 业绩超预期事件因子面板（PEAD）：公告日后 decayDays 个交易日内，
 * 因子值 = 该次公告的超预期幅度（百分点，每股每日恒定）；窗口外无观测。
 * 同一交易日落入多个事件窗口时，取**最近一次公告**的信号（新信息覆盖旧信息）。
 *
 * 前视纪律与截面面板一致：日期 t 的观测只带 t → t+h 的远期收益（全部持有期
 * 齐备才收行，与 buildCrossSectionPanel 同口径）；公告日对齐到「公告日（含）
 * 之后的第一个交易日」——公告当日收盘后才可知晓，用当日收盘作为基准价、
 * 次日才持仓的口径略保守但纪律干净（收益仍按 t 收盘计）。
 */
export function buildEarningsSurpriseObservations(
  opts: EventObservationOptions,
): FactorObservation[] {
  const { code, reports, bars, horizons } = opts;
  const decayDays = opts.decayDays ?? 63;
  const maxHorizon = Math.max(...horizons);
  if (!(maxHorizon > 0) || bars.length <= maxHorizon) return [];

  const surprises = earningsSurpriseSeries(deriveSingleQuarter(reports)).filter(
    (s) => s.noticeDate !== null && Number.isFinite(s.surprise),
  );
  if (surprises.length === 0) return [];

  // 公告日 → 信号（后写覆盖：按报告期升序遍历，越晚的公告覆盖越早的）
  const signalByDate = new Map<string, number>();
  for (const s of surprises) {
    const t = bars.findIndex((b) => b.date >= (s.noticeDate as string));
    if (t < 0) continue; // 公告日在 K 线区间之后：事件尚未开始，无观测
    const end = Math.min(t + decayDays, bars.length - maxHorizon);
    for (let i = t; i < end; i++) {
      signalByDate.set(bars[i].date, s.surprise);
    }
  }

  const obs: FactorObservation[] = [];
  for (const [date, value] of signalByDate) {
    const i = bars.findIndex((b) => b.date === date);
    const base = bars[i].close;
    if (!(base > 0)) continue;
    const returns: Record<number, number> = {};
    let complete = true;
    for (const h of horizons) {
      const ahead = bars[i + h].close;
      if (!(ahead > 0)) {
        complete = false;
        break;
      }
      returns[h] = ahead / base - 1;
    }
    if (!complete) continue;
    obs.push({ date, symbol: code, value, returns });
  }
  obs.sort((a, b) => a.date.localeCompare(b.date));
  return obs;
}

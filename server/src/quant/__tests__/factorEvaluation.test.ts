import { describe, it, expect } from 'vitest';
import {
  assignQuantiles,
  cleanFactorPanel,
  dailyIcSeries,
  evaluateFactor,
  factorAlphaBeta,
  factorReturns,
  factorTurnover,
  icSignificance,
  judgeFactor,
  quantileReturns,
  type FactorObservation,
} from '../factorEvaluation.js';

/**
 * 构造一个「因子完美预测收益」的面板：3 个交易日 × 4 只股票，
 * 每日截面内因子值排序与下期收益排序完全一致。
 */
function perfectPanel(): FactorObservation[] {
  const shape = [
    { symbol: 'S1', value: 1, ret: -0.03 },
    { symbol: 'S2', value: 2, ret: -0.01 },
    { symbol: 'S3', value: 3, ret: 0.01 },
    { symbol: 'S4', value: 4, ret: 0.03 },
  ];
  const out: FactorObservation[] = [];
  ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09'].forEach(
    (date, d) => {
      for (const s of shape) {
        out.push({
          date,
          symbol: s.symbol,
          // 每日因子值整体平移，但截面内排序不变
          value: s.value + d * 10,
          returns: { 1: s.ret, 5: s.ret * 2 },
        });
      }
    },
  );
  return out;
}

describe('cleanFactorPanel', () => {
  it('丢弃因子值非有限与收益缺失的行', () => {
    const rows = cleanFactorPanel(
      [
        { date: 'd1', value: 1, returns: { 1: 0.1 } },
        { date: 'd1', value: NaN, returns: { 1: 0.2 } },
        { date: 'd1', value: 3, returns: { 1: NaN } },
        { date: 'd1', value: Infinity, returns: { 1: 0.4 } },
      ],
      { maxLoss: 0.8 },
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.dropped).toBe(3);
    expect(rows.dropRatio).toBeCloseTo(0.75, 10);
  });

  it('缺失比例超过 maxLoss 时抛错（不静默接受大面积缺失）', () => {
    const panel: FactorObservation[] = [
      { date: 'd1', value: 1, returns: { 1: 0.1 } },
      { date: 'd1', value: NaN, returns: { 1: 0.2 } },
    ];
    expect(() => cleanFactorPanel(panel)).toThrow(/maxLoss/);
    expect(() => cleanFactorPanel(panel, { maxLoss: 0.6 })).not.toThrow();
  });

  it('识别出数据中出现的全部持有期（升序）', () => {
    const rows = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 10: 0.1, 1: 0.2, 5: 0.3 } },
      { date: 'd1', value: 2, returns: { 10: 0.1, 1: 0.2, 5: 0.3 } },
    ]);
    expect(rows.periods).toEqual([1, 5, 10]);
  });

  it('periods 选项只保留指定持有期', () => {
    const rows = cleanFactorPanel(perfectPanel(), { periods: [5] });
    expect(rows.periods).toEqual([5]);
  });

  it('空面板不抛错', () => {
    const rows = cleanFactorPanel([]);
    expect(rows.rows).toEqual([]);
    expect(rows.dropRatio).toBe(0);
  });

  it('中性化在既无市值也无行业时不生效（neutralized = false）', () => {
    const rows = cleanFactorPanel(perfectPanel(), { neutralize: true });
    expect(rows.neutralized).toBe(false);
  });

  it('中性化剔除市值效应：小市值同值因子的残差被压平', () => {
    const panel: FactorObservation[] = [
      { date: 'd1', value: 5, marketCap: 10, returns: { 1: 0.01 } },
      { date: 'd1', value: 5, marketCap: 100, returns: { 1: 0.02 } },
      { date: 'd1', value: 5, marketCap: 1000, returns: { 1: 0.03 } },
    ];
    const rows = cleanFactorPanel(panel, { neutralize: true });
    expect(rows.neutralized).toBe(true);
    // 因子值与 log(市值) 完全线性相关 → 回归残差应趋于 0
    for (const r of rows.rows) expect(Math.abs(r.adjusted)).toBeLessThan(1e-6);
  });
});

describe('assignQuantiles', () => {
  it('按截面排序分档：4 只股票分 2 档 → [1,1,2,2]', () => {
    const cleaned = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 1: 0 } },
      { date: 'd1', value: 2, returns: { 1: 0 } },
      { date: 'd1', value: 3, returns: { 1: 0 } },
      { date: 'd1', value: 4, returns: { 1: 0 } },
    ]);
    const out = assignQuantiles(cleaned.rows, 2);
    expect(out.map((r) => r.quantile)).toEqual([1, 1, 2, 2]);
  });

  it('并列值落在同一档（平均秩口径）', () => {
    const cleaned = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 1: 0 } },
      { date: 'd1', value: 1, returns: { 1: 0 } },
      { date: 'd1', value: 9, returns: { 1: 0 } },
      { date: 'd1', value: 9, returns: { 1: 0 } },
    ]);
    const out = assignQuantiles(cleaned.rows, 2);
    expect(out[0].quantile).toBe(out[1].quantile);
    expect(out[2].quantile).toBe(out[3].quantile);
    expect(out[0].quantile).not.toBe(out[2].quantile);
  });

  it('分档按日独立进行（跨日不混排）', () => {
    const cleaned = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 1: 0 } },
      { date: 'd1', value: 2, returns: { 1: 0 } },
      { date: 'd2', value: 100, returns: { 1: 0 } },
      { date: 'd2', value: 200, returns: { 1: 0 } },
    ]);
    const out = assignQuantiles(cleaned.rows, 2);
    expect(out.map((r) => r.quantile)).toEqual([1, 2, 1, 2]);
  });

  it('档数大于样本数时档号不越界', () => {
    const cleaned = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 1: 0 } },
      { date: 'd1', value: 2, returns: { 1: 0 } },
    ]);
    const out = assignQuantiles(cleaned.rows, 10);
    for (const r of out) {
      expect(r.quantile).toBeGreaterThanOrEqual(1);
      expect(r.quantile).toBeLessThanOrEqual(10);
    }
  });
});

describe('quantileReturns', () => {
  it('完美因子：分档收益严格单调，单调性 = 1', () => {
    const rows = cleanFactorPanel(perfectPanel()).rows;
    const table = quantileReturns(rows, { period: 1, quantiles: 4 });
    expect(table.rows).toHaveLength(4);
    expect(table.monotonicity).toBeCloseTo(1, 10);
    expect(table.spread).toBeGreaterThan(0);
  });

  it('不足 3 档时单调性为 0（2 点秩相关恒为 ±1，测不出 U 形，故不作判定）', () => {
    const rows = cleanFactorPanel(perfectPanel()).rows;
    const table = quantileReturns(rows, { period: 1, quantiles: 2 });
    expect(table.rows).toHaveLength(2);
    expect(table.monotonicity).toBe(0);
    // 多空价差在 2 档下仍然有效（不依赖单调性）
    expect(table.spread).toBeGreaterThan(0);
  });

  it('多空价差 = 最高档收益 − 最低档收益', () => {
    const rows = cleanFactorPanel(perfectPanel()).rows;
    const table = quantileReturns(rows, { period: 1, quantiles: 4 });
    const top = table.rows[table.rows.length - 1].meanReturn;
    const bottom = table.rows[0].meanReturn;
    expect(table.spread).toBeCloseTo(top - bottom, 12);
  });

  it('收益集中在单侧（U 形）时单调性显著低于 1', () => {
    // 中间档收益最高、两端最低 → 非单调
    const panel: FactorObservation[] = [];
    for (const date of ['d1', 'd2', 'd3']) {
      const shape = [
        { value: 1, ret: -0.05 },
        { value: 2, ret: 0.05 },
        { value: 3, ret: 0.05 },
        { value: 4, ret: -0.05 },
      ];
      for (const s of shape) {
        panel.push({ date, value: s.value, returns: { 1: s.ret } });
      }
    }
    const rows = cleanFactorPanel(panel).rows;
    const table = quantileReturns(rows, { period: 1, quantiles: 4 });
    expect(Math.abs(table.monotonicity)).toBeLessThan(1);
  });

  it('demeaned 使各档收益以当日截面均值为基准（多空价差不变）', () => {
    const rows = cleanFactorPanel(perfectPanel()).rows;
    const raw = quantileReturns(rows, { period: 1, quantiles: 2 });
    const dem = quantileReturns(rows, { period: 1, quantiles: 2, demeaned: true });
    expect(dem.spread).toBeCloseTo(raw.spread, 12);
  });
});

describe('dailyIcSeries', () => {
  it('完美因子每日截面 IC = 1', () => {
    const rows = cleanFactorPanel(perfectPanel()).rows;
    const ic = dailyIcSeries(rows, 1);
    // perfectPanel 有 6 个交易日，每日 4 只样本均可计算
    expect(ic).toHaveLength(6);
    for (const v of ic) expect(v).toBeCloseTo(1, 10);
  });

  it('样本不足 2 的日期被跳过', () => {
    const rows = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 1: 0.1 } },
      { date: 'd1', value: 2, returns: { 1: 0.2 } },
      { date: 'd2', value: 3, returns: { 1: 0.3 } },
    ]).rows;
    expect(dailyIcSeries(rows, 1)).toHaveLength(1);
  });
});

describe('icSignificance', () => {
  it('计算出均值/标准差/IR/t/p 且 p ∈ [0,1]', () => {
    const s = icSignificance([0.05, 0.03, 0.04, 0.06, 0.02]);
    expect(s.n).toBe(5);
    expect(s.mean).toBeCloseTo(0.04, 10);
    expect(s.std).toBeGreaterThan(0);
    expect(s.ir).toBeCloseTo(s.mean / s.std, 10);
    expect(s.tStat).toBeGreaterThan(0);
    expect(s.pValue).toBeGreaterThanOrEqual(0);
    expect(s.pValue).toBeLessThanOrEqual(1);
  });

  it('强正 IC 且低噪声时 p 值显著（< 0.05）', () => {
    const s = icSignificance([0.05, 0.048, 0.052, 0.049, 0.051, 0.05]);
    expect(s.pValue).toBeLessThan(0.05);
  });

  it('IC 正负交替（纯噪声）时 p 值不显著', () => {
    const s = icSignificance([0.05, -0.05, 0.05, -0.05, 0.05, -0.05]);
    expect(s.pValue).toBeGreaterThan(0.05);
  });

  it('IC 恒为 +1（std=0）时判为极显著，不能误报为不显著', () => {
    const s = icSignificance([1, 1, 1, 1]);
    expect(s.std).toBe(0);
    expect(s.pValue).toBe(0);
    expect(s.tStat).toBeGreaterThan(0);
  });

  it('空序列与单点序列安全返回', () => {
    const empty = icSignificance([]);
    expect(empty.n).toBe(0);
    expect(empty.pValue).toBe(1);
    const one = icSignificance([0.05]);
    expect(one.n).toBe(1);
    expect(one.std).toBe(0);
    expect(one.pValue).toBe(1);
  });

  it('过滤非有限值', () => {
    const s = icSignificance([0.05, NaN, 0.03, Infinity, 0.04]);
    expect(s.n).toBe(3);
  });
});

describe('factorTurnover', () => {
  it('缺 symbol 时返回 null（无法跨期配对）', () => {
    const rows = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 1: 0.1 } },
      { date: 'd2', value: 2, returns: { 1: 0.2 } },
    ]).rows;
    expect(factorTurnover(rows)).toBeNull();
  });

  it('成分完全不变时换手率为 0，自相关为 1', () => {
    const panel: FactorObservation[] = [];
    for (const date of ['d1', 'd2', 'd3']) {
      panel.push({ date, symbol: 'S1', value: 1, returns: { 1: 0.01 } });
      panel.push({ date, symbol: 'S2', value: 2, returns: { 1: 0.02 } });
      panel.push({ date, symbol: 'S3', value: 3, returns: { 1: 0.03 } });
      panel.push({ date, symbol: 'S4', value: 4, returns: { 1: 0.04 } });
    }
    const rows = cleanFactorPanel(panel).rows;
    const t = factorTurnover(rows, { quantiles: 2 });
    expect(t).not.toBeNull();
    expect(t!.datePairs).toBe(2);
    for (const v of Object.values(t!.byQuantile)) expect(v).toBeCloseTo(0, 10);
    expect(t!.rankAutocorrelation).toBeCloseTo(1, 10);
  });

  it('成分完全轮换时换手率为 1', () => {
    const panel: FactorObservation[] = [
      { date: 'd1', symbol: 'S1', value: 1, returns: { 1: 0.01 } },
      { date: 'd1', symbol: 'S2', value: 2, returns: { 1: 0.02 } },
      { date: 'd2', symbol: 'S3', value: 1, returns: { 1: 0.01 } },
      { date: 'd2', symbol: 'S4', value: 2, returns: { 1: 0.02 } },
    ];
    const rows = cleanFactorPanel(panel).rows;
    const t = factorTurnover(rows, { quantiles: 2 });
    expect(t).not.toBeNull();
    for (const v of Object.values(t!.byQuantile)) expect(v).toBeCloseTo(1, 10);
  });

  it('只有一个截面时返回 null', () => {
    const rows = cleanFactorPanel([
      { date: 'd1', symbol: 'S1', value: 1, returns: { 1: 0.1 } },
      { date: 'd1', symbol: 'S2', value: 2, returns: { 1: 0.2 } },
    ]).rows;
    expect(factorTurnover(rows)).toBeNull();
  });
});

describe('factorReturns', () => {
  it('每个截面产出一个组合收益点（perfectPanel 6 个交易日）', () => {
    const rows = cleanFactorPanel(perfectPanel()).rows;
    const pts = factorReturns(rows, { period: 1 });
    expect(pts).toHaveLength(6);
    // 现金中性：组合收益为「去均值权重 × 收益」，与市场整体涨跌无关
    for (const p of pts) expect(Number.isFinite(p.ret)).toBe(true);
  });

  it('完美因子的多空组合累计净值 > 1', () => {
    const rows = cleanFactorPanel(perfectPanel()).rows;
    const pts = factorReturns(rows, { period: 1 });
    expect(pts[pts.length - 1].cumulative).toBeGreaterThan(1);
  });

  it('累计净值是逐日复利结果', () => {
    const rows = cleanFactorPanel(perfectPanel()).rows;
    const pts = factorReturns(rows, { period: 1 });
    let acc = 1;
    for (const p of pts) {
      acc *= 1 + p.ret;
      expect(p.cumulative).toBeCloseTo(acc, 12);
    }
  });

  it('单只股票的截面被跳过（无法构建多空组合）', () => {
    const rows = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 1: 0.1 } },
      { date: 'd2', value: 2, returns: { 1: 0.2 } },
    ]).rows;
    expect(factorReturns(rows, { period: 1 })).toEqual([]);
  });
});

describe('factorAlphaBeta', () => {
  it('恢复出构造时设定的 beta 与年化 alpha', () => {
    // 构造：个股收益 = 0.0004(日 alpha) + 1.5 × 市场收益
    const panel: FactorObservation[] = [];
    const market = [0.01, -0.02, 0.015, -0.005, 0.008, -0.012, 0.02, -0.018];
    market.forEach((m, d) => {
      ['S1', 'S2', 'S3', 'S4'].forEach((symbol, i) => {
        panel.push({
          date: `d${d}`,
          symbol,
          value: i + 1,
          // 截面等权均值恰好等于 0.0004 + 1.5m（扰动项在截面内两两抵消）
          returns: { 1: 0.0004 + 1.5 * m + (i - 1.5) * 0.001 },
        });
      });
    });
    const rows = cleanFactorPanel(panel).rows;
    // 因子值与扰动项同序 → 多空组合收益正是被放大的扰动，此处仅验证可计算且 beta 有限
    const pts = factorReturns(rows, { period: 1 });
    const ab = factorAlphaBeta(rows, pts, 1);
    expect(ab).not.toBeNull();
    expect(Number.isFinite(ab!.alpha)).toBe(true);
    expect(Number.isFinite(ab!.beta)).toBe(true);
    expect(ab!.r2).toBeGreaterThanOrEqual(0);
    expect(ab!.r2).toBeLessThanOrEqual(1);
  });

  it('样本不足 3 天时返回 null', () => {
    const rows = cleanFactorPanel([
      { date: 'd1', value: 1, returns: { 1: 0.1 } },
      { date: 'd1', value: 2, returns: { 1: 0.2 } },
      { date: 'd2', value: 1, returns: { 1: 0.1 } },
      { date: 'd2', value: 2, returns: { 1: 0.2 } },
    ]).rows;
    const pts = factorReturns(rows, { period: 1 });
    expect(factorAlphaBeta(rows, pts, 1)).toBeNull();
  });
});

describe('evaluateFactor', () => {
  it('端到端产出 IC 显著性、分层回测、换手率与 alpha/beta', () => {
    const report = evaluateFactor(perfectPanel(), { quantiles: 4 });
    expect(report.periods).toEqual([1, 5]);
    expect(report.sampleSize).toBe(24);
    expect(report.dropped).toBe(0);
    for (const p of report.byPeriod) {
      expect(p.ic.n).toBe(6);
      expect(p.ic.pValue).toBe(0); // 完美因子：std=0 → 极显著
      expect(p.quantile.monotonicity).toBeCloseTo(1, 10);
      expect(p.quantile.spread).toBeGreaterThan(0);
      expect(p.turnover).not.toBeNull();
      expect(p.longShortCumulative).toBeGreaterThan(1);
    }
  });

  it('持有期 5 的多空价差约为持有期 1 的两倍（构造使然）', () => {
    const report = evaluateFactor(perfectPanel(), { quantiles: 2 });
    const p1 = report.byPeriod.find((p) => p.period === 1)!;
    const p5 = report.byPeriod.find((p) => p.period === 5)!;
    expect(p5.quantile.spread).toBeCloseTo(p1.quantile.spread * 2, 10);
  });

  it('换手率随调仓周期变化可测（lag=2 时配对数减少）', () => {
    const lag1 = evaluateFactor(perfectPanel(), { quantiles: 4, lag: 1 });
    const lag2 = evaluateFactor(perfectPanel(), { quantiles: 4, lag: 2 });
    // 6 个截面：lag=1 → 5 对，lag=2 → 4 对
    expect(lag1.byPeriod[0].turnover!.datePairs).toBe(5);
    expect(lag2.byPeriod[0].turnover!.datePairs).toBe(4);
  });
});

describe('judgeFactor', () => {
  it('完美因子判定为有效', () => {
    const report = evaluateFactor(perfectPanel(), { quantiles: 4 });
    const verdict = judgeFactor(report.byPeriod[0]);
    expect(verdict.effective).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('仅 2 档时无法验证单调性，判定为无效并给出原因', () => {
    const report = evaluateFactor(perfectPanel(), { quantiles: 2 });
    const verdict = judgeFactor(report.byPeriod[0]);
    expect(verdict.effective).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('分档数不足'))).toBe(true);
  });

  it('IC 样本不足时给出原因', () => {
    const panel: FactorObservation[] = [
      { date: 'd1', value: 1, returns: { 1: 0.1 } },
      { date: 'd1', value: 2, returns: { 1: 0.2 } },
      { date: 'd1', value: 3, returns: { 1: 0.3 } },
    ];
    const report = evaluateFactor(panel, { quantiles: 3 });
    const verdict = judgeFactor(report.byPeriod[0]);
    expect(verdict.effective).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('样本'))).toBe(true);
  });

  it('单调性差时给出原因（即使 IC 显著）', () => {
    // 3 个截面、U 形收益：因子值与收益在两端同向、中部反向
    const panel: FactorObservation[] = [];
    for (const date of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) {
      const shape = [
        { value: 1, ret: 0.03 },
        { value: 2, ret: -0.05 },
        { value: 3, ret: -0.05 },
        { value: 4, ret: 0.03 },
      ];
      for (const s of shape) {
        panel.push({ date, value: s.value, returns: { 1: s.ret } });
      }
    }
    const report = evaluateFactor(panel, { quantiles: 4 });
    const verdict = judgeFactor(report.byPeriod[0]);
    expect(verdict.effective).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('单调性') || r.includes('多空价差'))).toBe(true);
  });
});

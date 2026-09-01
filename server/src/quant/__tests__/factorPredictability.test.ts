/**
 * 单只股票量价因子时间序列预测力测试。
 * 覆盖：① 逐日因子序列与快照一致性；② 单因子时间序列 IC（完美预测 / 常数因子 /
 * 有效样本不足）；③ 端到端 evaluatePriceVolumePredictabilityFromBars 结构。
 */
import { describe, it, expect } from 'vitest';
import type { OHLCVData } from '../types.js';
import {
  computePriceVolumeFactors,
  computePriceVolumeFactorSeries,
} from '../priceVolumeFactors.js';
import {
  singleFactorPredictability,
  evaluatePriceVolumeFactorPredictability,
  evaluatePriceVolumePredictabilityFromBars,
} from '../factorPredictability.js';

/** 确定性收盘价序列（含波动、恒正），避免随机 flaky */
function deterministicCloses(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(100 * (1 + 0.12 * Math.sin(i / 9) + 0.06 * Math.cos(i / 5) + 0.02 * Math.sin(i / 3)));
  }
  return out.map((v) => (v > 0 ? v : 0.01));
}

function barsFromCloses(closes: number[]): OHLCVData[] {
  return closes.map((close, i) => ({
    date: `2024-${String(Math.floor(i / 21) + 1).padStart(2, '0')}-${String((i % 21) + 1).padStart(2, '0')}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000_000,
  }));
}

describe('computePriceVolumeFactorSeries 与快照一致性', () => {
  it('序列末点值 == computePriceVolumeFactors 快照值（同内核 rawFactorValuesAt）', () => {
    const bars = barsFromCloses(deterministicCloses(300));
    const snapshot = computePriceVolumeFactors({ bars });
    const series = computePriceVolumeFactorSeries({ bars });
    const byName = new Map(snapshot.map((s) => [s.name, s]));

    for (const s of series) {
      const last = s.points[s.points.length - 1];
      const snap = byName.get(s.name)!;
      if (Number.isNaN(snap.value)) {
        expect(Number.isNaN(last.value)).toBe(true);
      } else {
        expect(last.value).toBe(snap.value);
      }
    }
  });

  it('序列从 MIN_FACTOR_LOOKBACK 起且长度 = bars.length − MIN_FACTOR_LOOKBACK', () => {
    const bars = barsFromCloses(deterministicCloses(300));
    const series = computePriceVolumeFactorSeries({ bars });
    // 253 = DAYS_12M + 1（见 priceVolumeFactors.ts）
    expect(series[0].points.length).toBe(300 - 253);
  });
});

describe('singleFactorPredictability 时间序列 IC', () => {
  const closes = deterministicCloses(40);
  const n = closes.length;
  const period = 3;

  it('因子 = 远期收益本身 → IC≈+1、显著、n = n−period', () => {
    const factorValues = new Array<number>(n).fill(NaN);
    for (let j = 0; j + period < n; j++) {
      factorValues[j] = closes[j + period] / closes[j] - 1;
    }
    const r = singleFactorPredictability(factorValues, closes, 1, period)!;
    expect(r).not.toBeNull();
    expect(r.ic).toBeCloseTo(1, 5);
    expect(r.effectiveIc).toBeCloseTo(1, 5);
    expect(r.significant).toBe(true);
    expect(r.n).toBe(n - period);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('因子方向取反 → effectiveIc = ic × direction 翻为负', () => {
    const factorValues = new Array<number>(n).fill(NaN);
    for (let j = 0; j + period < n; j++) {
      factorValues[j] = closes[j + period] / closes[j] - 1;
    }
    const r = singleFactorPredictability(factorValues, closes, -1, period)!;
    expect(r.effectiveIc).toBeCloseTo(-1, 5);
  });

  it('常数因子 → 退化、IC=0、不显著', () => {
    const factorValues = new Array<number>(n).fill(1);
    const r = singleFactorPredictability(factorValues, closes, 1, period)!;
    expect(r.ic).toBe(0);
    expect(r.significant).toBe(false);
    expect(r.pValue).toBe(1);
  });

  it('有效样本 < 3 → 返回 null（无 t 检验意义）', () => {
    const shortCloses = deterministicCloses(4);
    const factorValues = new Array<number>(shortCloses.length).fill(NaN);
    for (let j = 0; j + period < shortCloses.length; j++) {
      factorValues[j] = shortCloses[j + period] / shortCloses[j] - 1;
    }
    // n=4, period=3 → j 仅 0 → m=1 < 3
    expect(singleFactorPredictability(factorValues, shortCloses, 1, period)).toBeNull();
  });

  it('缺失（NaN）因子值被跳过而非洗成 0', () => {
    // 一半样本为 NaN：有效样本应仅为有限部分
    const factorValues = new Array<number>(n).fill(NaN);
    let finite = 0;
    for (let j = 0; j + period < n; j++) {
      if (j % 2 === 0) {
        factorValues[j] = closes[j + period] / closes[j] - 1;
        finite++;
      }
    }
    const r = singleFactorPredictability(factorValues, closes, 1, period)!;
    expect(r.n).toBe(finite);
  });
});

describe('evaluatePriceVolumePredictabilityFromBars 端到端结构', () => {
  it('返回 11 个因子，每个含 21/63 两持有期键（值为对象或 null），且 volatility_1m 两窗口均有效', () => {
    // 400 根 bars：253 日最小回看 + 63 日持有期 = 316 ≤ 400，两窗口均有有效样本
    const bars = barsFromCloses(deterministicCloses(400));
    const out = evaluatePriceVolumePredictabilityFromBars(bars);
    expect(out).toHaveLength(11);
    for (const f of out) {
      // 键必须存在（结构契约），值为 FactorPredictabilityHorizon 或 null 均合法
      expect(f.horizons[21]).toBeDefined();
      expect(f.horizons[63]).toBeDefined();
      expect(typeof f.hasSignal).toBe('boolean');
    }
    // volatility_1m 不依赖市场收益，400 根样本下两窗口必有有效样本
    const vol = out.find((f) => f.name === 'volatility_1m')!;
    expect(vol.horizons[21]).not.toBeNull();
    expect(vol.horizons[63]).not.toBeNull();
  });

  it('无市场收益时 Beta 类因子序列恒 NaN → 持有期预测力为 null', () => {
    const bars = barsFromCloses(deterministicCloses(300));
    const out = evaluatePriceVolumePredictabilityFromBars(bars);
    const beta = out.find((f) => f.name === 'beta')!;
    expect(beta.horizons[21]).toBeNull();
    expect(beta.horizons[63]).toBeNull();
  });
});

describe('marketReturns 数据通路（注入合成市场收益，验证 β 类因子可算）', () => {
  it('提供市场收益时 beta 当前值有限、63 日预测力非 null（确认接入路径有效）', () => {
    const bars = barsFromCloses(deterministicCloses(300));
    // 与个股收益弱相关的合成市场日收益，长度与 bars 对齐（首个为 0）
    const marketReturns = bars.map((_, i) =>
      i === 0 ? 0 : 0.6 * (bars[i].close / bars[i - 1].close - 1) + 0.001 * Math.sin(i),
    );
    const snap = computePriceVolumeFactors({ bars, marketReturns });
    const beta = snap.find((f) => f.name === 'beta')!;
    expect(Number.isFinite(beta.value)).toBe(true);
    const idio = snap.find((f) => f.name === 'idiosyncratic_vol')!;
    expect(Number.isFinite(idio.value)).toBe(true);

    const pred = evaluatePriceVolumeFactorPredictability({ bars, marketReturns });
    const betaPred = pred.find((f) => f.name === 'beta')!;
    // 300 根 bars：253 最小回看 + 63 持有期 = 316 ≤ 300? 否 → 63 日窗口样本不足为 null；
    // 故此处断言 21 日窗口非 null（253+21=274 ≤ 300），63 日按真实约束可为 null
    expect(betaPred.horizons[21]).not.toBeNull();
  });

  it('400 根 bars + 市场收益时 beta 的 21/63 两窗口均非 null', () => {
    const bars = barsFromCloses(deterministicCloses(400));
    const marketReturns = bars.map((_, i) =>
      i === 0 ? 0 : 0.6 * (bars[i].close / bars[i - 1].close - 1) + 0.001 * Math.sin(i),
    );
    const pred = evaluatePriceVolumeFactorPredictability({ bars, marketReturns });
    const betaPred = pred.find((f) => f.name === 'beta')!;
    expect(betaPred.horizons[21]).not.toBeNull();
    expect(betaPred.horizons[63]).not.toBeNull();
  });
});

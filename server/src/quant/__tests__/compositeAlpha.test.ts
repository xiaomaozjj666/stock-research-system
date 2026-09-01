/**
 * 多因子加权组合 alpha 测试。
 * 覆盖：① 全显著同向 → alpha>0、方向 up、一致率 1；② 含反向显著因子 → 方向取决于加权、
 * 一致率 < 1；③ 无显著因子 → alpha=0、方向 neutral、无信号；④ 21/63 窗口各自结算、
 * 跨窗口多数表决（平票→neutral）；⑤ computeCompositeAlphaFromBars 结构正确。
 */
import { describe, it, expect } from 'vitest';
import {
  computeCompositeAlpha,
  computeCompositeAlphaFromBars,
  factorOverlayFromCompositeAlpha,
} from '../compositeAlpha.js';
import type { FactorPredictability, FactorPredictabilityHorizon } from '../factorPredictability.js';
import type { PriceVolumeFactorName, FactorCategory } from '../priceVolumeFactors.js';
import type { OHLCVData } from '../types.js';

function sig(
  ic: number,
  effectiveIc: number,
  tStat: number,
  pValue: number,
  n: number,
): FactorPredictabilityHorizon {
  return { ic, effectiveIc, tStat, pValue, significant: pValue < 0.05, n };
}

function mk(
  name: PriceVolumeFactorName,
  direction: 1 | -1,
  category: FactorCategory,
  h21: FactorPredictabilityHorizon | null,
  h63: FactorPredictabilityHorizon | null,
): FactorPredictability {
  return {
    name,
    direction,
    category,
    horizons: { 21: h21, 63: h63 },
    hasSignal: Boolean(h21?.significant || h63?.significant),
  };
}

describe('computeCompositeAlpha — 加权合成', () => {
  it('全显著同向因子 → alpha>0、方向 up、一致率 1', () => {
    const pred: FactorPredictability[] = [
      mk('volatility_1m', -1, 'volatility', sig(0.3, 0.3, 5, 0.001, 100), null),
      mk('reversal_1m', -1, 'reversal', sig(0.4, 0.4, 8, 0.0001, 100), null),
      mk('amihud_illiquidity', 1, 'liquidity', sig(0.2, 0.2, 3, 0.005, 100), null),
    ];
    const r = computeCompositeAlpha(pred);
    const h21 = r.horizons.find((h) => h.period === 21)!;
    // weightedEdge = 5*0.3 + 8*0.4 + 3*0.2 = 5.3；weightSum = 16；alpha = 0.33125
    expect(h21.alpha).toBeCloseTo(5.3 / 16, 6);
    expect(h21.direction).toBe('up');
    expect(h21.significantCount).toBe(3);
    expect(h21.evaluableCount).toBe(3);
    expect(h21.agreement).toBe(1);
    // 63 窗口全 null → 该窗口 neutral、无显著
    const h63 = r.horizons.find((h) => h.period === 63)!;
    expect(h63.significantCount).toBe(0);
    expect(h63.direction).toBe('neutral');
    // 跨窗口多数表决：21 up / 63 neutral → up
    expect(r.hasSignal).toBe(true);
    expect(r.overallDirection).toBe('up');
  });

  it('含反向显著因子 → 方向由加权决定、一致率 < 1', () => {
    const pred: FactorPredictability[] = [
      mk('reversal_1m', -1, 'reversal', sig(0.4, 0.4, 8, 0.0001, 100), null),
      mk('momentum_12_1', 1, 'momentum', sig(-0.3, -0.3, 6, 0.001, 100), null),
    ];
    const r = computeCompositeAlpha(pred);
    const h21 = r.horizons.find((h) => h.period === 21)!;
    // weightedEdge = 8*0.4 + 6*(-0.3) = 1.4；weightSum = 14；alpha = 0.1 → up
    expect(h21.alpha).toBeCloseTo(0.1, 6);
    expect(h21.direction).toBe('up');
    expect(h21.significantCount).toBe(2);
    expect(h21.agreement).toBeCloseTo(0.5, 6);
    expect(r.overallDirection).toBe('up');
  });

  it('反向因子权重更大 → 组合翻为 down', () => {
    const pred: FactorPredictability[] = [
      mk('reversal_1m', -1, 'reversal', sig(0.3, 0.3, 3, 0.005, 100), null),
      mk('momentum_12_1', 1, 'momentum', sig(-0.5, -0.5, 10, 0.0001, 100), null),
    ];
    const r = computeCompositeAlpha(pred);
    const h21 = r.horizons.find((h) => h.period === 21)!;
    // weightedEdge = 3*0.3 + 10*(-0.5) = -4.1；weightSum = 13；alpha ≈ -0.315
    expect(h21.alpha).toBeCloseTo(-4.1 / 13, 6);
    expect(h21.direction).toBe('down');
    expect(h21.agreement).toBeCloseTo(0.5, 6);
    expect(r.overallDirection).toBe('down');
  });

  it('无显著因子 → alpha=0、方向 neutral、无信号', () => {
    const pred: FactorPredictability[] = [
      mk('volatility_1m', -1, 'volatility', sig(0.05, 0.05, 0.5, 0.6, 100), null),
      mk('reversal_1m', -1, 'reversal', null, null),
    ];
    const r = computeCompositeAlpha(pred);
    const h21 = r.horizons.find((h) => h.period === 21)!;
    expect(h21.alpha).toBe(0);
    expect(h21.direction).toBe('neutral');
    expect(h21.significantCount).toBe(0);
    expect(h21.evaluableCount).toBe(1);
    expect(h21.agreement).toBe(0);
    expect(r.hasSignal).toBe(false);
    expect(r.overallDirection).toBe('neutral');
  });

  it('21/63 窗口各自结算、跨窗口平票 → neutral', () => {
    const pred: FactorPredictability[] = [
      mk(
        'reversal_1m',
        -1,
        'reversal',
        sig(0.4, 0.4, 6, 0.0001, 100),
        sig(-0.3, -0.3, 5, 0.001, 100),
      ),
    ];
    const r = computeCompositeAlpha(pred);
    const h21 = r.horizons.find((h) => h.period === 21)!;
    const h63 = r.horizons.find((h) => h.period === 63)!;
    expect(h21.direction).toBe('up');
    expect(h63.direction).toBe('down');
    // 一票 up 一票 down → 平票 → neutral
    expect(r.overallDirection).toBe('neutral');
    expect(r.hasSignal).toBe(true);
  });

  it('主导贡献因子按 |加权贡献| 降序取前 3', () => {
    const pred: FactorPredictability[] = [
      mk('volatility_1m', 1, 'volatility', sig(0.4, 0.4, 8, 0.0001, 100), null),
      mk('reversal_1m', 1, 'reversal', sig(0.2, 0.2, 3, 0.005, 100), null),
      mk('momentum_12_1', 1, 'momentum', sig(0.35, 0.35, 7, 0.0001, 100), null),
      mk('amihud_illiquidity', 1, 'liquidity', sig(0.1, 0.1, 2, 0.01, 100), null),
    ];
    const r = computeCompositeAlpha(pred);
    const h21 = r.horizons.find((h) => h.period === 21)!;
    expect(h21.topContributors).toHaveLength(3);
    // 贡献 = |w·effectiveIc|：volatility_1m=3.2, momentum_12_1=2.45, reversal_1m=0.6, amihud=0.2
    expect(h21.topContributors[0].name).toBe('volatility_1m');
    expect(h21.topContributors[1].name).toBe('momentum_12_1');
    expect(h21.topContributors[2].name).toBe('reversal_1m');
  });
});

describe('factorOverlayFromCompositeAlpha — 组合 alpha → 回测叠加层', () => {
  it('看多（overallAlpha>0）→ direction up、posture 由 alpha 推导', () => {
    const ca = computeCompositeAlpha([
      mk('reversal_1m', -1, 'reversal', sig(0.4, 0.4, 8, 0.0001, 100), null),
      mk('momentum_12_1', 1, 'momentum', sig(0.3, 0.3, 6, 0.001, 100), null),
    ]);
    expect(ca.overallDirection).toBe('up');
    expect(ca.overallAlpha).toBeGreaterThan(0);
    const overlay = factorOverlayFromCompositeAlpha(ca);
    expect(overlay.direction).toBe('up');
    expect(overlay.alpha).toBeCloseTo(ca.overallAlpha, 10);
    expect(overlay.posture).toBeCloseTo(0.5 + 0.5 * ca.overallAlpha, 10);
    expect(overlay.posture).toBeGreaterThan(0.5);
  });

  it('看空（overallAlpha<0）→ direction down、posture<0.5', () => {
    const ca = computeCompositeAlpha([
      mk('reversal_1m', -1, 'reversal', sig(0.3, 0.3, 3, 0.005, 100), null),
      mk('momentum_12_1', 1, 'momentum', sig(-0.5, -0.5, 10, 0.0001, 100), null),
    ]);
    expect(ca.overallDirection).toBe('down');
    expect(ca.overallAlpha).toBeLessThan(0);
    const overlay = factorOverlayFromCompositeAlpha(ca);
    expect(overlay.direction).toBe('down');
    expect(overlay.posture).toBeLessThan(0.5);
  });

  it('overallAlpha 恒为各持有期 alpha 均值（含平票抵消 → 趋于 0）', () => {
    const ca = computeCompositeAlpha([
      mk(
        'reversal_1m',
        -1,
        'reversal',
        sig(0.4, 0.4, 6, 0.0001, 100),
        sig(-0.3, -0.3, 5, 0.001, 100),
      ),
    ]);
    const h21 = ca.horizons.find((h) => h.period === 21)!.alpha;
    const h63 = ca.horizons.find((h) => h.period === 63)!.alpha;
    expect(ca.overallAlpha).toBeCloseTo((h21 + h63) / 2, 10);
  });
});

describe('computeCompositeAlphaFromBars — 端到端结构', () => {
  it('确定性 bars 返回合法结构（两窗口、alpha 有限）', () => {
    const bars: OHLCVData[] = [];
    let close = 100;
    for (let i = 0; i < 360; i++) {
      close *= 1 + 0.004 * Math.sin(i * 0.3) + 0.001;
      bars.push({
        date: new Date(2023, 0, 1 + i).toISOString().slice(0, 10),
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume: 1_000_000 + (i % 7) * 10_000,
        isSimulated: false,
      });
    }
    const marketReturns = bars.map((_, i) =>
      i === 0 ? 0 : 0.6 * (bars[i].close / bars[i - 1].close - 1) + 0.001 * Math.sin(i),
    );
    const r = computeCompositeAlphaFromBars(bars, marketReturns);
    expect(r.horizons).toHaveLength(2);
    for (const h of r.horizons) {
      expect(Number.isFinite(h.alpha)).toBe(true);
      expect(['up', 'down', 'neutral']).toContain(h.direction);
      expect(h.significantCount).toBeGreaterThanOrEqual(0);
    }
  });
});

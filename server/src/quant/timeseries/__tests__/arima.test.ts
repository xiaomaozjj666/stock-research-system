import { describe, it, expect } from 'vitest';
import { fitArima, arimaForecastOneStep, differenceSeries } from '../arima.js';
import { gaussianStream } from '../linalg.js';

/** 白噪声价格路径 */
function whiteNoisePrices(n: number, seed: number): number[] {
  const g = gaussianStream(seed);
  return Array.from({ length: n }, () => 100 + 0.5 * g());
}

/** AR(1) 路径：y_t = c + φ·y_{t-1} + ε_t */
function ar1(n: number, phi: number, c: number, seed: number): number[] {
  const g = gaussianStream(seed);
  const out: number[] = [c / (1 - phi)];
  for (let i = 1; i < n; i++) out.push(c + phi * out[i - 1] + g());
  return out;
}

describe('differenceSeries', () => {
  it('一阶/二阶差分结果正确', () => {
    expect(differenceSeries([1, 3, 6, 10], 1)).toEqual([2, 3, 4]);
    expect(differenceSeries([1, 3, 6, 10], 2)).toEqual([1, 1]);
  });
});

describe('fitArima：AR(1) 识别与参数恢复', () => {
  const data = ar1(700, 0.6, 0.05, 61);
  const fit = fitArima(data, { d: 0, pMax: 4 });

  it('φ 恢复到有限样本误差区间内', () => {
    expect(fit.p).toBeGreaterThanOrEqual(1);
    const phi1 = fit.coefficients.phi[0];
    expect(phi1).toBeGreaterThan(0.45);
    expect(phi1).toBeLessThan(0.75);
    expect(Number.isFinite(fit.stdErrors.phi[0])).toBe(true);
  });

  it('定阶轨迹完整，选中阶的 AIC/BIC 存在', () => {
    expect(fit.selection.length).toBe(5); // p = 0..4
    expect(Number.isFinite(fit.aic)).toBe(true);
    expect(fit.bic).toBeGreaterThanOrEqual(fit.aic);
  });

  it('残差通过 Ljung-Box 白噪声诊断（AR 已吸收自相关）', () => {
    expect(fit.ljungBox.pValue).toBeGreaterThan(0.01);
    expect(fit.ljungBox.df).toBeGreaterThan(0);
  });

  it('单位根提示对平稳序列不报警', () => {
    expect(fit.unitRootHint).not.toBeNull();
    expect(fit.unitRootHint!.rejectAt5).toBe(true); // 平稳 AR → 拒绝单位根
  });
});

describe('fitArima：白噪声序列', () => {
  it('AR 阶数应选得很低（无自相关可吸收）', () => {
    const fit = fitArima(whiteNoisePrices(500, 71), { d: 0, pMax: 4 });
    expect(fit.p).toBeLessThanOrEqual(2);
  });
});

describe('arimaForecastOneStep', () => {
  it('d=1 时预测 = 末期值 + 差分预测（量纲还原正确）', () => {
    const prices = ar1(300, 0.5, 0.02, 81).map((v) => 100 + v * 0.1);
    const fit = fitArima(prices, { d: 1, pMax: 2 });
    const f = arimaForecastOneStep(fit, prices);
    // 预测不应离末期值太远（日频量级）
    const last = prices[prices.length - 1];
    expect(Math.abs(f - last)).toBeLessThan(last * 0.05);
  });

  it('d=0 时预测为水平量纲', () => {
    // c=5、φ=0.4 → 均值回复中心 c/(1−φ)=8.33，序列远离 0，相对偏差口径有效
    const data = ar1(300, 0.4, 5, 91);
    const fit = fitArima(data, { d: 0, pMax: 2 });
    const f = arimaForecastOneStep(fit, data);
    // 预测不应离末期值太远（相对偏差 < 50%，序列量纲无关）
    const last = data[data.length - 1];
    expect(Math.abs(f - last) / Math.max(Math.abs(last), 1e-6)).toBeLessThan(0.5);
  });
});

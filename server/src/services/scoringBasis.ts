/**
 * 评分基准（Scoring Basis）
 * 行业 PE / 资产负债率基准与债务风险打分——单一事实来源。
 * scoreEngine 与 factors 均从此处导入，避免循环依赖与基准漂移。
 */
import { safeDiv } from './safeDiv.js';

/**
 * 行业 PE 基准（A 股行业中枢近似值）。
 * 行业名与 data/industryPeers.ts 的 `industry` 字段对齐，未覆盖的行业回落到 20。
 */
export const INDUSTRY_PE_BENCHMARK: Record<string, number> = {
  银行: 6,
  保险: 10,
  证券: 18,
  房地产: 10,
  建筑: 8,
  钢铁: 12,
  煤炭: 10,
  石油石化: 11,
  电力: 18,
  公用事业: 15,
  航空机场: 25,
  物流: 18,
  汽车: 20,
  工程机械: 18,
  化工: 20,
  建材: 15,
  家电: 15,
  纺织服装: 18,
  造纸: 16,
  农业: 25,
  零售: 22,
  食品饮料: 28,
  白酒: 30,
  啤酒: 32,
  消费品: 25,
  传媒: 30,
  通信: 25,
  计算机: 40,
  消费电子: 30,
  半导体: 55,
  光伏: 20,
  新能源车: 30,
  新能源: 45,
  军工: 45,
  有色金属: 18,
  医药: 32,
  医疗器械: 35,
  科技: 40,
  制造业: 20,
};

/**
 * 行业资产负债率基准（%）。
 * 银行/保险/地产/建筑等属于天然高杠杆经营，若与制造业用同一把尺子衡量，
 * 会导致整个板块的风险维度被系统性判为 0 分，评分完全失去区分度。
 */
export const INDUSTRY_DEBT_BENCHMARK: Record<string, number> = {
  银行: 92,
  保险: 88,
  证券: 78,
  房地产: 78,
  建筑: 76,
  航空机场: 70,
  钢铁: 60,
  汽车: 60,
  工程机械: 58,
  电力: 60,
  物流: 55,
  零售: 58,
  家电: 60,
  建材: 50,
  化工: 50,
  石油石化: 52,
  煤炭: 50,
};
const DEFAULT_DEBT_BENCHMARK = 45;

/**
 * 按行业基准折算负债风险得分（0-7，分越高风险越低）。
 * 低于基准 60% 视为稳健给满分，超过基准 25% 视为高危给 0 分，中间线性插值。
 */
export function scoreDebtRisk(debtRatio: number, industry: string): number {
  const bench = INDUSTRY_DEBT_BENCHMARK[industry] ?? DEFAULT_DEBT_BENCHMARK;
  const safeLine = bench * 0.6;
  const dangerLine = bench * 1.25;
  if (!isFinite(debtRatio) || debtRatio <= safeLine) return 7;
  if (debtRatio >= dangerLine) return 0;
  return 7 * (1 - (debtRatio - safeLine) / (dangerLine - safeLine));
}

/** 行业 PE 基准查询（未知行业回落默认 20） */
export function industryPEBenchmark(industry: string): number {
  return INDUSTRY_PE_BENCHMARK[industry] ?? 20;
}

/** 行业负债基准查询（未知行业回落默认 45） */
export function industryDebtBenchmark(industry: string): number {
  return INDUSTRY_DEBT_BENCHMARK[industry] ?? DEFAULT_DEBT_BENCHMARK;
}

/** 安全除法再导出，便于统一入口 */
export { safeDiv };

/** 计算数组的波动系数（标准差，基于环比收益） */
export function calculateVolatility(values: number[]): number {
  if (values.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] !== 0) {
      returns.push((values[i] - values[i - 1]) / Math.abs(values[i - 1]));
    }
  }
  if (returns.length === 0) return 0;
  const mean = safeDiv(
    returns.reduce((a, b) => a + b, 0),
    returns.length,
  );
  const variance = safeDiv(
    returns.reduce((s, r) => s + (r - mean) ** 2, 0),
    returns.length,
  );
  return Math.sqrt(variance);
}

/** 安全 CAGR 计算：起始值<=0时返回0避免NaN */
export function safeCAGR(startVal: number, endVal: number, years: number): number {
  if (years <= 0) return 0;
  if (startVal <= 0 || endVal <= 0) return 0;
  const result = (Math.pow(endVal / startVal, 1 / years) - 1) * 100;
  return isFinite(result) ? result : 0;
}

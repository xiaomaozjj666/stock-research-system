/**
 * 内置估值建模（Valuation Model）——两阶段 EPS 贴现 + 可比公司表
 * ============================================================================
 * 把「估值只停留在倍数分位」往前推一步：给定显式假设（显性期增速 / 永续增速 /
 * 折现率），产出每股内在价值、逐期现金流表与敏感性矩阵；辅以同业中位数对比，
 * 回答「现价隐含了什么假设、相对同业贵还是便宜」。
 *
 * 口径与诚实边界（写进 limitations，随结果返回）：
 *  - 模型是 **EPS 贴现近似**，不是严格 FCFF/FCFE：未单独建模再投资率与净债务，
 *    隐含假设「EPS ≈ 可分配自由现金流」。对高资本开支/高杠杆公司会系统性偏乐观，
 *    结论应与 PB 分位、经营现金流交叉印证；
 *  - 永续增速 g2 **必须严格小于折现率 r**（Gordon 终值在 g2 ≥ r 时发散），入参
 *    违反时如实抛错而不是给出天文数字；
 *  - 敏感性矩阵逐格独立计算（每格一次完整贴现），纯函数无状态；
 *  - 可比表来自 dataService 组装的 peerComparison（同业 peers 当前估值），样本
 *    过滤 PE/PB 非正值后取中位数——中位数比均值抗离群。
 *
 * 全部纯函数、确定性、零依赖（与 quant 内核同一纪律）。
 */
import type { FinancialData, ValuationData } from '../types.js';

export interface DcfAssumptions {
  /** 显性期年增速（小数，如 0.12） */
  growthRate1: number;
  /** 显性期年数（默认 5） */
  explicitYears: number;
  /** 永续增速（小数，须 < discountRate） */
  growthRate2: number;
  /** 折现率（小数，如 0.09） */
  discountRate: number;
  /** 基期每股收益（元） */
  baseEps: number;
}

export interface DcfCashFlowRow {
  /** 第 t 年（1 起） */
  year: number;
  /** 该年 EPS */
  eps: number;
  /** 折现因子 1/(1+r)^t */
  discountFactor: number;
  /** 现值 */
  presentValue: number;
}

export interface DcfResult {
  /** 每股内在价值（显性期现值 + 终值现值） */
  fairValue: number;
  /** 显性期现值合计 */
  explicitValue: number;
  /** 终值（未折现） */
  terminalValue: number;
  /** 终值现值 */
  discountedTerminalValue: number;
  cashFlows: DcfCashFlowRow[];
  assumptions: DcfAssumptions;
}

/** 单元格错误（g2 ≥ r 等非法假设）时给 NaN，让矩阵如实显示不可算 */
export function twoStageEpsDcf(input: DcfAssumptions): DcfResult {
  const { baseEps, growthRate1, growthRate2, discountRate, explicitYears } = input;
  if (!(baseEps > 0)) throw new Error('baseEps 需为正数');
  if (!(discountRate > 0)) throw new Error('discountRate 需为正数');
  if (!(Number.isInteger(explicitYears) && explicitYears >= 1 && explicitYears <= 15)) {
    throw new Error('explicitYears 需为 1-15 的整数');
  }
  if (growthRate2 >= discountRate) {
    throw new Error(
      `永续增速 g2（${(growthRate2 * 100).toFixed(1)}%）必须严格小于折现率 r（${(discountRate * 100).toFixed(1)}%），否则终值发散`,
    );
  }

  const cashFlows: DcfCashFlowRow[] = [];
  let explicitValue = 0;
  let eps = baseEps;
  for (let t = 1; t <= explicitYears; t++) {
    eps = eps * (1 + growthRate1);
    const discountFactor = 1 / (1 + discountRate) ** t;
    const presentValue = eps * discountFactor;
    explicitValue += presentValue;
    cashFlows.push({
      year: t,
      eps: round2(eps),
      discountFactor: round4(discountFactor),
      presentValue: round2(presentValue),
    });
  }

  // 终值：显性期末 EPS 的 Gordon 永续（g2 < r 已在校验中强制）
  const terminalEps = eps * (1 + growthRate2);
  const terminalValue = terminalEps / (discountRate - growthRate2);
  const discountedTerminalValue = terminalValue / (1 + discountRate) ** explicitYears;

  return {
    fairValue: round2(explicitValue + discountedTerminalValue),
    explicitValue: round2(explicitValue),
    terminalValue: round2(terminalValue),
    discountedTerminalValue: round2(discountedTerminalValue),
    cashFlows,
    assumptions: { ...input },
  };
}

export interface SensitivityMatrix {
  /** 折现率轴（小数，升序） */
  discountRates: number[];
  /** 显性期增速轴（小数，升序） */
  growthRates1: number[];
  /** [i][j] = r_i × g1_j 下的每股价值（非法假设为 NaN） */
  matrix: number[][];
}

/** 敏感性矩阵：r × g1 双轴，g2/explicitYears/baseEps 固定 */
export function sensitivityMatrix(
  baseEps: number,
  discountRates: number[],
  growthRates1: number[],
  growthRate2: number,
  explicitYears: number,
): SensitivityMatrix {
  const rAxis = [...discountRates].sort((a, b) => a - b);
  const gAxis = [...growthRates1].sort((a, b) => a - b);
  const matrix = rAxis.map((r) =>
    gAxis.map((g) => {
      // g2 ≥ r 的格子（低折现率 × 高永续）如实置 NaN
      if (growthRate2 >= r) return NaN;
      try {
        return twoStageEpsDcf({
          baseEps,
          growthRate1: g,
          growthRate2,
          discountRate: r,
          explicitYears,
        }).fairValue;
      } catch {
        return NaN;
      }
    }),
  );
  return { discountRates: rAxis, growthRates1: gAxis, matrix };
}

// === 可比公司表 ===

export interface ComparableRow {
  code: string;
  name: string;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  marketCap: number | null;
}

export interface ComparableAnalysis {
  /** 过滤掉 PE/PB 非正后的有效样本 */
  peers: ComparableRow[];
  sampleSize: number;
  medianPe: number | null;
  medianPb: number | null;
  medianRoe: number | null;
  /** 本股相对同业中位数的折溢价（正=溢价，小数；样本不足为 null） */
  pePremiumPct: number | null;
  pbPremiumPct: number | null;
  /** 中位数 PE × 本股 EPS 的隐含每股价值（eps 缺失为 null） */
  impliedValueByMedianPe: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

/** 组装可比分析：peers 过滤非正估值 → 中位数 → 本股折溢价 */
export function buildComparableAnalysis(
  self: { code: string; name: string; pe: number; pb: number; roe: number | null; eps: number },
  peerComparison: ValuationData['peerComparison'],
): ComparableAnalysis {
  const peers: ComparableRow[] = peerComparison
    .filter((p) => p.pe > 0 && p.pb > 0)
    .map((p) => ({
      code: p.code,
      name: p.name,
      pe: round2(p.pe),
      pb: round2(p.pb),
      roe: p.roe != null ? round2(p.roe) : null,
      marketCap: p.marketCap != null ? round2(p.marketCap) : null,
    }));

  const medianPe = median(peers.map((p) => p.pe as number));
  const medianPb = median(peers.map((p) => p.pb as number));
  const medianRoe = median(peers.map((p) => p.roe as number).filter((v): v is number => v != null));

  const pePremium = medianPe !== null && self.pe > 0 ? round4(self.pe / medianPe - 1) : null;
  const pbPremium = medianPb !== null && self.pb > 0 ? round4(self.pb / medianPb - 1) : null;
  const impliedValue = medianPe !== null && self.eps > 0 ? round2(medianPe * self.eps) : null;

  return {
    peers,
    sampleSize: peers.length,
    medianPe,
    medianPb,
    medianRoe,
    pePremiumPct: pePremium,
    pbPremiumPct: pbPremium,
    impliedValueByMedianPe: impliedValue,
  };
}

// === 组合入口 ===

export interface ValuationModelResult {
  model: 'two_stage_eps_dcf';
  code: string;
  fairValue: number | null;
  currentPrice: number;
  /** 现价相对内在价值的折溢价（正=高估，%；fairValue 不可算为 null） */
  upsidePct: number | null;
  dcf: DcfResult | null;
  sensitivity: SensitivityMatrix | null;
  comparables: ComparableAnalysis;
  assumptions: {
    /** 基期 EPS（自动取最新年报或调用方覆盖） */
    baseEps: number;
    /** 显性期增速：显式覆盖或 EPS 3 年 CAGR 钳制 [-0.2, 0.3] */
    growthRate1: number;
    growthRate1Source: 'input' | 'eps_cagr_3y';
    growthRate2: number;
    discountRate: number;
    explicitYears: number;
  };
  limitations: string[];
}

/** 最近 years 年 EPS 复合增速（取最近 years+1 个有效值首尾法；不足或非正返回 null） */
export function epsCagr(epsSeries: number[], years = 3): number | null {
  const valid = epsSeries.filter((v) => Number.isFinite(v) && v > 0);
  if (valid.length < years + 1) return null;
  const window = valid.slice(-(years + 1));
  const first = window[0];
  const last = window[window.length - 1];
  if (!(first > 0) || !(last > 0)) return null;
  return Math.round(((last / first) ** (1 / years) - 1) * 10000) / 10000;
}

export interface ValuationModelOptions {
  /** 覆盖自动推导的假设（未提供的字段用默认/推导值） */
  growthRate1?: number;
  growthRate2?: number;
  discountRate?: number;
  explicitYears?: number;
  baseEps?: number;
}

/**
 * 组合入口：从财务与估值数据自动推导默认假设并执行 DCF + 可比表。
 * 任何「数据不足以建模」的情况都通过 dcf=null + limitations 如实披露，不伪造数值。
 */
export function runValuationModel(
  code: string,
  financial: FinancialData,
  valuation: ValuationData,
  options: ValuationModelOptions = {},
): ValuationModelResult {
  const limitations = [
    'EPS 贴现近似：未建模再投资率与净债务，对高资本开支/高杠杆公司偏乐观，结论需与经营现金流和 PB 分位交叉印证',
    '终值对 g2/r 极其敏感：g2 接近 r 时终值主导估值，请结合敏感性矩阵解读而非只看单点',
  ];

  // 基期 EPS：优先调用方覆盖 → 最新年报 EPS
  const baseEpsInput = options.baseEps ?? financial.eps[financial.eps.length - 1];
  const baseEps =
    Number.isFinite(baseEpsInput) && (baseEpsInput as number) > 0 ? (baseEpsInput as number) : null;

  // 显性期增速：优先调用方覆盖 → EPS 3 年 CAGR（钳制 [-20%, 30%]，避免历史异常外推）
  let growthRate1 = options.growthRate1;
  let growthRate1Source: 'input' | 'eps_cagr_3y' = 'input';
  if (growthRate1 === undefined || !Number.isFinite(growthRate1)) {
    const cagr = epsCagr(financial.eps, 3);
    growthRate1 = cagr === null ? 0.08 : Math.max(-0.2, Math.min(0.3, cagr));
    growthRate1Source = 'eps_cagr_3y';
    if (cagr === null) {
      limitations.push(
        'EPS 历史不足 4 年有效值，显性期增速回落到 8% 通用假设——建议显式传入 growthRate1',
      );
    }
  }

  const discountRate = options.discountRate ?? 0.09;
  const growthRate2 = options.growthRate2 ?? 0.03;
  const explicitYears = options.explicitYears ?? 5;

  const assumptions = {
    baseEps: baseEps ?? NaN,
    growthRate1: round4(growthRate1),
    growthRate1Source,
    growthRate2: round4(growthRate2),
    discountRate: round4(discountRate),
    explicitYears,
  };

  let dcf: DcfResult | null = null;
  let sensitivity: SensitivityMatrix | null = null;
  if (baseEps === null) {
    limitations.push('最新年报 EPS 缺失或非正，DCF 不可执行（可比表仍有效）');
  } else {
    try {
      dcf = twoStageEpsDcf({ baseEps, growthRate1, growthRate2, discountRate, explicitYears });
      sensitivity = sensitivityMatrix(
        baseEps,
        [0.07, 0.08, 0.09, 0.1, 0.12],
        [
          assumptions.growthRate1 - 0.06,
          assumptions.growthRate1 - 0.03,
          assumptions.growthRate1,
          assumptions.growthRate1 + 0.03,
          assumptions.growthRate1 + 0.06,
        ],
        growthRate2,
        explicitYears,
      );
    } catch (err) {
      limitations.push(`DCF 未执行：${(err as Error).message}`);
    }
  }

  const selfRoe = financial.roe[financial.roe.length - 1];
  const comparables = buildComparableAnalysis(
    {
      code,
      name: '',
      pe: valuation.pe,
      pb: valuation.pb,
      roe: Number.isFinite(selfRoe) ? (selfRoe as number) : null,
      eps: baseEps ?? NaN,
    },
    valuation.peerComparison,
  );
  if (comparables.sampleSize < 3) {
    limitations.push(
      `可比样本仅 ${comparables.sampleSize} 个（过滤非正估值后），中位数参考意义有限`,
    );
  }

  const upsidePct =
    dcf !== null && valuation.currentPrice > 0
      ? Math.round((dcf.fairValue / valuation.currentPrice - 1) * 10000) / 100
      : null;

  return {
    model: 'two_stage_eps_dcf',
    code,
    fairValue: dcf?.fairValue ?? null,
    currentPrice: valuation.currentPrice,
    upsidePct,
    dcf,
    sensitivity,
    comparables,
    assumptions,
    limitations,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

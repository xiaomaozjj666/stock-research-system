/**
 * 量价因子库（Price-Volume Factors）
 * --------------------------------------------------------------------------
 * 补齐原因子库的空白：`services/factors.ts` 的 21 个因子全部来自财务与估值数据，
 * 而 A 股量化实证中最强的因子恰恰是量价类——它们与基本面因子相关性极低
 * （月均 |r| < 0.06），是独立的增量信息源。
 *
 * ⚠️ 最关键的一条：A 股不存在美股意义上的动量效应，而是显著的短期反转。
 *    直接套用 Jegadeesh-Titman「12 减 1 月」动量在 A 股 IC 为负、多空年化亏损，
 *    这是移植海外因子时最常见的翻车点。本模块所有方向均按 A 股实证校正，
 *    并在 `aShareAdjusted` 字段显式标注哪些因子做过方向翻转。
 *
 * 方向约定：`direction = 1` 表示因子值越高预期收益越高；`-1` 表示越低越好。
 * 调用方合成综合分时应先乘 direction，不要直接用裸值加权。
 *
 * 实证依据（第三方研究，非收益承诺，随市场结构变化需重新校准）：
 *  - 中信建投《异质信念在量化选股中的应用》2025-12-30：
 *      SIGMA（波动率类）IC −8.69%、年化 ICIR −3.39、年化多空 22.41%、Sharpe 2.11
 *      trading_hb_2（换手率分离）IC +7.25%、年化 ICIR 2.88、年化多空 21.17%、Sharpe 2.03
 *  - BigQuant 全样本实证（2015—2025，5,487 只含 324 只退市股）：
 *      价格动量 3 月回看 skip=0：IC −0.032、ICIR −0.244、T = −2.66（反转显著）
 *      残差动量 6 月回看 skip=1：IC +0.0086、ICIR +0.1512、T = +1.47（方向为正）
 *      动量与 PE / ROE 的月均相关系数 < 0.06 → 独立于基本面
 *  - 融量科技 2026-01：换手率相对强度反转 −(MA20/MA120)，IC 0.0363、Sharpe 1.4484
 *
 * 所有导出函数为纯函数，无副作用，可独立单测。
 */

import type { OHLCVData } from './types.js';
import { olsRegression } from './factorStats.js';

/** 年化用的交易日数 */
const TRADING_DAYS_PER_YEAR = 252;
/** 一个月 ≈ 21 个交易日 */
const DAYS_1M = 21;
/** 三个月 ≈ 63 个交易日 */
const DAYS_3M = 63;
/** 六个月 ≈ 126 个交易日 */
const DAYS_6M = 126;
/** 一年 ≈ 252 个交易日 */
const DAYS_12M = 252;
/** 残差动量 / 特异波动率回归用的滚动窗口（交易日） */
const RESID_WINDOW = 252;

export type PriceVolumeFactorName =
  | 'volatility_1m'
  | 'volatility_3m'
  | 'idiosyncratic_vol'
  | 'reversal_1m'
  | 'reversal_3m'
  | 'residual_momentum_6m'
  | 'momentum_12_1'
  | 'turnover_ratio_reversal'
  | 'amihud_illiquidity'
  | 'beta'
  | 'max_daily_return_1m';

export type FactorCategory =
  'volatility' | 'reversal' | 'momentum' | 'liquidity' | 'volume' | 'risk';

/** 单个量价因子的实证元数据：让方向选择可审计，而不是藏在代码里的魔法符号 */
export interface FactorEvidence {
  name: PriceVolumeFactorName;
  category: FactorCategory;
  direction: 1 | -1;
  /** A 股实证表现摘要（第三方研究结论，随市场结构变化需重新校准） */
  evidence: string;
  /** 是否按 A 股实证做过方向翻转（true = 与美股经典口径相反） */
  aShareAdjusted: boolean;
}

export const A_SHARE_FACTOR_EVIDENCE: Record<PriceVolumeFactorName, FactorEvidence> = {
  volatility_1m: {
    name: 'volatility_1m',
    category: 'volatility',
    direction: -1,
    evidence:
      '低波动异象，全球稳健。中信建投同类 SIGMA 因子 IC −8.69%、年化 ICIR −3.39、Sharpe 2.11',
    aShareAdjusted: false,
  },
  volatility_3m: {
    name: 'volatility_3m',
    category: 'volatility',
    direction: -1,
    evidence: '低波动异象的中期口径，噪声低于 1 月版本但反应更慢',
    aShareAdjusted: false,
  },
  idiosyncratic_vol: {
    name: 'idiosyncratic_vol',
    category: 'volatility',
    direction: -1,
    evidence: 'Ang et al. 特异波动率异象：剥离市场 Beta 后的残差波动越高，预期收益越低',
    aShareAdjusted: false,
  },
  reversal_1m: {
    name: 'reversal_1m',
    category: 'reversal',
    direction: -1,
    evidence: 'A 股散户结构导致短期过度反应；反转效应在 skip=0 时最强，skip=1 后显著衰减',
    aShareAdjusted: true,
  },
  reversal_3m: {
    name: 'reversal_3m',
    category: 'reversal',
    direction: -1,
    evidence: 'A 股最优反转参数（3 月回看 skip=0）：IC −0.032、ICIR −0.244、T = −2.66，统计显著',
    aShareAdjusted: true,
  },
  residual_momentum_6m: {
    name: 'residual_momentum_6m',
    category: 'momentum',
    direction: 1,
    evidence:
      '剥离市场与行业系统性收益后方向由负转正：IC +0.0086、ICIR +0.1512。A 股板块轮动快，含行业暴露的原始动量整体为负',
    aShareAdjusted: true,
  },
  momentum_12_1: {
    name: 'momentum_12_1',
    category: 'momentum',
    direction: -1,
    evidence:
      'Jegadeesh-Titman 经典动量在 A 股方向为负（多空年化 −6.80%），与美股相反。保留仅作对照，实盘请用 residual_momentum_6m 或反转类',
    aShareAdjusted: true,
  },
  turnover_ratio_reversal: {
    name: 'turnover_ratio_reversal',
    category: 'volume',
    direction: 1,
    evidence: '换手率相对强度反转 −(MA20/MA120)：IC 0.0363、Sharpe 1.4484；短期换手过热预示回调',
    aShareAdjusted: false,
  },
  amihud_illiquidity: {
    name: 'amihud_illiquidity',
    category: 'liquidity',
    direction: 1,
    evidence:
      'Amihud(2002) 非流动性溢价：单位成交额引发的价格冲击越大，要求的补偿收益越高。与市值高度相关，务必中性化后使用',
    aShareAdjusted: false,
  },
  beta: {
    name: 'beta',
    category: 'risk',
    direction: -1,
    evidence: '低 Beta 异象：高 Beta 股票被杠杆受限投资者回避、被投机资金高估',
    aShareAdjusted: false,
  },
  max_daily_return_1m: {
    name: 'max_daily_return_1m',
    category: 'risk',
    direction: -1,
    evidence:
      'Bali et al. 彩票偏好：投资者愿为极端正收益的小概率买单，导致这类股票被高估、后续跑输',
    aShareAdjusted: false,
  },
};

/** 计算因子所需的上下文 */
export interface PriceVolumeFactorContext {
  /** 个股日线，按日期升序 */
  bars: OHLCVData[];
  /**
   * 市场日收益序列，按日期升序，与 bars 尾部对齐（等权全市场或基准指数）。
   * 提供时可计算 Beta、特异波动率与残差动量；缺失时这三个因子返回 NaN。
   */
  marketReturns?: number[];
  /** 流通股本（股）；提供时换手类因子用真实换手率，否则退化为成交量代理 */
  floatShares?: number;
}

export interface PriceVolumeFactor {
  name: PriceVolumeFactorName;
  /** 原始因子值；数据不足时为 NaN（调用方应剔除，不要当成 0） */
  value: number;
  /** +1 = 值越高预期收益越高；−1 = 值越低预期收益越高 */
  direction: 1 | -1;
  category: FactorCategory;
  /** 实证依据摘要 */
  evidence: string;
  /** 是否按 A 股实证做过方向翻转 */
  aShareAdjusted: boolean;
}

function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    out.push(prev > 0 ? closes[i] / prev - 1 : 0);
  }
  return out;
}

/** 年化已实现波动率（样本标准差，ddof=1），单位：% */
function annualizedVolPct(returns: number[]): number {
  if (returns.length < 2) return NaN;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

/** 区间累计收益（%），需 close 序列长度 > offset */
function cumulativeReturnPct(closes: number[], offset: number): number {
  if (!(offset > 0) || closes.length <= offset) return NaN;
  const base = closes[closes.length - 1 - offset];
  if (!(base > 0)) return NaN;
  return (closes[closes.length - 1] / base - 1) * 100;
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

/**
 * 计算全部量价因子。
 *
 * 数据不足的因子返回 NaN——调用方必须显式剔除，切勿把 NaN 当 0 参与加权，
 * 否则等价于给「无法计算」的标的安了一个居中的因子值。
 */
export function computePriceVolumeFactors(ctx: PriceVolumeFactorContext): PriceVolumeFactor[] {
  const closes = ctx.bars.map((b) => b.close);
  const rets = dailyReturns(closes);
  const turnovers = buildTurnovers(ctx.bars, ctx.floatShares);
  const amihud = buildAmihud(ctx.bars, rets);
  const raw = rawFactorValuesAt(
    closes,
    rets,
    turnovers,
    amihud,
    ctx.marketReturns,
    ctx.floatShares,
    ctx.bars.length - 1,
  );
  return (Object.keys(A_SHARE_FACTOR_EVIDENCE) as PriceVolumeFactorName[]).map((name) => {
    const meta = A_SHARE_FACTOR_EVIDENCE[name];
    return {
      name,
      value: raw[name],
      direction: meta.direction,
      category: meta.category,
      evidence: meta.evidence,
      aShareAdjusted: meta.aShareAdjusted,
    };
  });
}

/**
 * 逐日因子序列所需的最小回看长度（交易日）。
 * momentum_12_1 需要 252 根收盘价（closes.length > 252），故序列从索引 252 起算，
 * 此前因子值恒为 NaN（由 rawFactorValuesAt 按各自窗口自然返回）。
 */
const MIN_FACTOR_LOOKBACK = DAYS_12M + 1;

/** 换手率序列：有流通股本用真实换手率，否则退化为成交量（手）代理 */
function buildTurnovers(bars: OHLCVData[], floatShares?: number): number[] {
  return bars.map((b) => {
    const shares = b.volume * 100;
    if (floatShares && floatShares > 0) return shares / floatShares;
    return b.volume;
  });
}

/** Amihud 非流动性：mean(|r| / 成交额)，×1e6 放大到可读量级 */
function buildAmihud(bars: OHLCVData[], rets: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const amount = bars[i].volume * 100 * bars[i].close;
    if (amount > 0) out.push((Math.abs(rets[i - 1]) / amount) * 1e6);
  }
  return out;
}

/**
 * 在「截至 endIdx（含）的截面前缀」上计算全部原始因子值。
 *
 * 所有公式与原 computePriceVolumeFactors 完全一致，区别仅在于切片范围限定在
 * 前缀 [0, endIdx]：当 endIdx = bars.length − 1 时结果逐字等价于旧版。
 * 回看窗口不足时对应因子自然返回 NaN（如 endIdx < 252 时 momentum_12_1 为 NaN），
 * 调用方据此逐日过滤，无需额外标记。
 *
 * 这是「逐日因子序列」与「时间序列 IC」的共享内核：把同一个函数作用在每个历史
 * 日期前缀上，即可得到因子随时间的演化，进而判定其对该股票自身远期收益的预测力。
 */
export function rawFactorValuesAt(
  closes: number[],
  rets: number[],
  turnovers: number[],
  amihud: number[],
  marketReturns: number[] | undefined,
  floatShares: number | undefined,
  endIdx: number,
): Record<PriceVolumeFactorName, number> {
  const pc = closes.slice(0, endIdx + 1);
  const pr = rets.slice(0, endIdx);
  const pt = turnovers.slice(0, endIdx + 1);
  const pa = amihud.slice(0, endIdx);
  const pm = marketReturns ? marketReturns.slice(0, endIdx) : undefined;

  // 市场回归：Beta、特异波动率与残差动量共用同一条 OLS
  let beta = NaN;
  let idioVol = NaN;
  let residualMomentum = NaN;
  if (pm && pm.length > 0) {
    const window = Math.min(RESID_WINDOW, pr.length, pm.length);
    if (window >= 20) {
      const y = pr.slice(pr.length - window);
      const x = pm.slice(pm.length - window);
      const { coefficients, residuals, fullRank } = olsRegression(y, [x]);
      if (fullRank) {
        beta = coefficients[1];
        idioVol = annualizedVolPct(residuals);
        // 残差动量：跳过最近 1 个月，累加此前 6 个月的残差
        const end = residuals.length - DAYS_1M;
        const start = end - DAYS_6M;
        if (start >= 0 && end > start) {
          residualMomentum = residuals.slice(start, end).reduce((a, b) => a + b, 0) * 100;
        }
      }
    }
  }

  const raw: Record<PriceVolumeFactorName, number> = {
    volatility_1m: annualizedVolPct(pr.slice(-DAYS_1M)),
    volatility_3m: annualizedVolPct(pr.slice(-DAYS_3M)),
    idiosyncratic_vol: idioVol,
    reversal_1m: cumulativeReturnPct(pc, DAYS_1M),
    reversal_3m: cumulativeReturnPct(pc, DAYS_3M),
    residual_momentum_6m: residualMomentum,
    // 12−1 动量：t−252 到 t−21 的累计收益
    momentum_12_1: (() => {
      if (pc.length <= DAYS_12M) return NaN;
      const base = pc[pc.length - 1 - DAYS_12M];
      const mid = pc[pc.length - 1 - DAYS_1M];
      if (!(base > 0) || !(mid > 0)) return NaN;
      return (mid / base - 1) * 100;
    })(),
    turnover_ratio_reversal: (() => {
      if (pt.length < 120) return NaN;
      const short = mean(pt.slice(-20));
      const long = mean(pt.slice(-120));
      if (!Number.isFinite(short) || !Number.isFinite(long) || long === 0) return NaN;
      return -(short / long);
    })(),
    amihud_illiquidity: mean(pa.slice(-DAYS_3M)),
    beta,
    max_daily_return_1m: (() => {
      const recent = pr.slice(-DAYS_1M);
      return recent.length > 0 ? Math.max(...recent) * 100 : NaN;
    })(),
  };
  return raw;
}

export interface PriceVolumeFactorSeriesPoint {
  /** YYYY-MM-DD */
  date: string;
  /** 当日因子值；回看不足时为 NaN */
  value: number;
}

export interface PriceVolumeFactorSeries {
  name: PriceVolumeFactorName;
  direction: 1 | -1;
  category: FactorCategory;
  evidence: string;
  aShareAdjusted: boolean;
  /** 按日期升序的逐日因子值（从 MIN_FACTOR_LOOKBACK 起，此前为 NaN 已剔除） */
  points: PriceVolumeFactorSeriesPoint[];
}

/**
 * 计算每只量价因子的逐日序列。
 *
 * 因子值在每个历史日期 `i` 处用 [0, i] 前缀重算（即「截至当日」的因子），从而把
 * 单点快照扩展成时间序列——这是判定「该因子对这只股票自身远期收益有无预测力」
 * （时间序列 IC）的前置数据。序列从 MIN_FACTOR_LOOKBACK 起，此前窗口不足恒为 NaN。
 *
 * 纯函数、无副作用；与 computePriceVolumeFactors 共享 rawFactorValuesAt 内核，
 * 故 endIdx = bars.length − 1 的截面值与 computePriceVolumeFactors 完全一致。
 */
export function computePriceVolumeFactorSeries(
  ctx: PriceVolumeFactorContext,
): PriceVolumeFactorSeries[] {
  const closes = ctx.bars.map((b) => b.close);
  const rets = dailyReturns(closes);
  const turnovers = buildTurnovers(ctx.bars, ctx.floatShares);
  const amihud = buildAmihud(ctx.bars, rets);
  const dates = ctx.bars.map((b) => b.date);
  const names = Object.keys(A_SHARE_FACTOR_EVIDENCE) as PriceVolumeFactorName[];

  // 单次遍历：[0, i] 前缀上重算全部因子，把每个因子的值分发到各自序列，避免 11× 冗余
  const buckets: Record<PriceVolumeFactorName, PriceVolumeFactorSeriesPoint[]> = {} as Record<
    PriceVolumeFactorName,
    PriceVolumeFactorSeriesPoint[]
  >;
  for (const n of names) buckets[n] = [];
  for (let i = MIN_FACTOR_LOOKBACK; i < ctx.bars.length; i++) {
    const raw = rawFactorValuesAt(
      closes,
      rets,
      turnovers,
      amihud,
      ctx.marketReturns,
      ctx.floatShares,
      i,
    );
    for (const n of names) buckets[n].push({ date: dates[i], value: raw[n] });
  }

  return names.map((name) => {
    const meta = A_SHARE_FACTOR_EVIDENCE[name];
    return {
      name,
      direction: meta.direction,
      category: meta.category,
      evidence: meta.evidence,
      aShareAdjusted: meta.aShareAdjusted,
      points: buckets[name],
    };
  });
}

/** 样本过滤判定输入 */
export interface HygieneInput {
  /** 是否 ST / *ST */
  isST?: boolean;
  /** 当日是否停牌 */
  isSuspended?: boolean;
  /** 上市日期（YYYY-MM-DD） */
  listingDate?: string;
  /** 计算基准日（YYYY-MM-DD），用于判定上市天数 */
  asOf?: string;
  /**
   * 是否处于全市场最小市值分位（Liu-Stambaugh-Yuan：最小 30% 的股票定价由
   * 借壳/壳价值驱动而非基本面，会污染因子检验；做因子研究时应剔除） */
  inSmallestDecile?: boolean;
  /** 是否含退市股（因子研究必须包含，否则系统性高估收益） */
  delisted?: boolean;
}

export interface HygieneVerdict {
  /** 是否应从因子研究样本中剔除 */
  exclude: boolean;
  reasons: string[];
}

/**
 * A 股因子研究的样本卫生检查。
 *
 * 幸存者偏差是最隐蔽的一类错误：只保留「当前仍在市」的股票做回测，
 * 等于把退市的亏损股隐性排除，会系统性高估策略收益。
 * 实证中退市股占比约 5.9%，剔除后结论不可信——所以本函数不把 delisted 判为剔除，
 * 而是在 verdict 里给出提示。
 */
export function checkSampleHygiene(input: HygieneInput): HygieneVerdict {
  const reasons: string[] = [];
  if (input.isST) reasons.push('ST/*ST：涨跌幅限制与退市风险使价格行为失真');
  if (input.isSuspended) reasons.push('停牌：价格不连续，因子值不可信');
  if (input.inSmallestDecile) {
    reasons.push('最小市值分位：定价由壳价值驱动而非基本面（Liu-Stambaugh-Yuan 建议剔除）');
  }
  if (input.listingDate && input.asOf) {
    const days = (Date.parse(input.asOf) - Date.parse(input.listingDate)) / (24 * 60 * 60 * 1000);
    if (Number.isFinite(days) && days < 60) {
      reasons.push(`次新股（上市 ${Math.floor(days)} 天 < 60 日）：新股定价机制与常态不同`);
    }
  }
  return { exclude: reasons.length > 0, reasons };
}

/** 交易成本口径（月度调仓，BigQuant 实证采用） */
export const A_SHARE_MONTHLY_COST = {
  /** 佣金（双边） */
  commission: 0.0003,
  /** 印花税（卖出单边） */
  stampDuty: 0.001,
  /** 冲击成本（双边估算） */
  impact: 0.002,
  /** 滑点（双边） */
  slippage: 0.001,
  /** 完整换仓总成本（每次换仓） */
  get perRebalance() {
    return this.commission + this.stampDuty + this.impact + this.slippage;
  },
} as const;

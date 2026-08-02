/**
 * 预测模型（Prediction Model）
 * --------------------------------------------------------------------------
 * 对「未来收益与情景」的严谨量化估计，替代原 scenarioEngine 中的魔法权重
 * (0.4/0.3/0.3) 与随意目标价倍数(0.9/1.2 等)。
 *
 * 模型结构：
 *   期望收益 E[r] = 因子组合贡献 + 估值均值回复
 *     · 因子组合贡献 = FACTOR_GAIN × compositeZ(因子z, 最优权重)
 *       —— compositeZ 来自 factorAnalytics，权重可由 IC/IR 校准得到；
 *     · 估值均值回复 = REVERT_STRENGTH × (50 − PE分位)/100
 *       —— 低估(分位<50)贡献正向收益，高估贡献负向，@[−0.3,0.3] 夹紧；
 *     · E[r] 整体夹紧到 [−0.5, 0.8]（保守区间）。
 *
 *   情景概率 = softmax(三档 logit / 温度 T)，保证 Σ = 1（天然归一，无需事后缩放）。
 *   目标价区间 = 期望目标价 × (1 ± σ)，期望目标价 = 当前价 × (1 + E[r])。
 *
 *   验证：validatePredictionModel 在样本面板上回测方向准确率与 RMSE。
 */
import type { FinancialData, ValuationData, StockInfo } from '../types.js';
import { extractFactors, buildFactorZScores } from './factors.js';
import { compositeZ, crossSectionalZScore } from '../quant/factorAnalytics.js';

/** 每单位合成 z 对应的年化期望收益贡献（保守，0.12 → z=1 约 +12%） */
const FACTOR_GAIN = 0.12;
/** 新闻情绪 z 分对应的年化期望收益贡献（保守，0.08 → z=1 约 +8%） */
const NEWS_GAIN = 0.08;
/** 估值均值回复强度 */
const REVERT_STRENGTH = 0.4;
/** 期望收益夹紧区间 */
const RETURN_FLOOR = -0.5;
const RETURN_CEIL = 0.8;
/** softmax 温度：越小分布越尖锐 */
const SOFTMAX_TEMPERATURE = 0.5;
/** 目标价区间半宽（相对期望目标价） */
const TARGET_BAND = 0.25;

export interface ExpectedReturnInput {
  /** 因子 z 分数（由 factors.buildFactorZScores 或截面 z 得到） */
  zByFactor: Record<string, number>;
  /** PE 历史分位（0-100），越低越低估 */
  pePercentile: number;
  /** 因子最优权重（可选，缺省等权） */
  weights?: Record<string, number>;
  /** 最新消息情绪 z 分（由 newsSignal.aggregateNewsSentiment 得到，可选） */
  newsZ?: number;
}

export interface ExpectedReturnResult {
  expectedReturn: number; // 年化期望收益，∈ [RETURN_FLOOR, RETURN_CEIL]
  factorComponent: number; // 因子贡献
  meanReversion: number; // 估值均值回复贡献
  newsComponent: number; // 最新消息情绪贡献（缺省 0）
}

/** 计算 PE 分位对应的均值回复项（低估为正） */
export function meanReversionComponent(pePercentile: number): number {
  const raw = ((50 - pePercentile) / 100) * REVERT_STRENGTH;
  return Math.max(-0.3, Math.min(0.3, raw));
}

/** 等权（每个因子权重=1；compositeZ 会按权重和归一化，等价于 z 的简单平均） */
function equalWeights(zByFactor: Record<string, number>): Record<string, number> {
  const w: Record<string, number> = {};
  for (const k of Object.keys(zByFactor)) w[k] = 1;
  return w;
}

/** 皮尔逊相关系数（新闻信号与实现收益的线性一致性，用于 newsIC） */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : 0;
}

/** 核心：由因子 z 与 PE 分位计算期望收益（可选叠加最新消息情绪） */
export function expectedForwardReturn(input: ExpectedReturnInput): ExpectedReturnResult {
  // 未提供最优权重时退化为等权（因子仍参与组合，不至贡献归零）
  const hasWeights = input.weights && Object.keys(input.weights).length > 0;
  const effectiveWeights = hasWeights ? input.weights! : equalWeights(input.zByFactor);
  const factorComponent = FACTOR_GAIN * compositeZ(input.zByFactor, effectiveWeights);
  const meanReversion = meanReversionComponent(input.pePercentile);
  // 最新消息情绪贡献：NEWS_GAIN × 新闻 z 分（缺省 0，不影响纯量化结果）
  const newsComponent = NEWS_GAIN * (input.newsZ ?? 0);
  const raw = factorComponent + meanReversion + newsComponent;
  const expectedReturn = Math.max(RETURN_FLOOR, Math.min(RETURN_CEIL, raw));
  return { expectedReturn, factorComponent, meanReversion, newsComponent };
}

/** 便捷封装：直接从财务/估值数据计算期望收益（可选叠加最新消息情绪 z） */
export function expectedForwardReturnFromData(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
  weights?: Record<string, number>,
  newsZ?: number,
): ExpectedReturnResult {
  const factors = extractFactors(financial, valuation, info);
  const zByFactor = buildFactorZScores(factors);
  const peValues = valuation.historicalPE.map((h) => h.pe).sort((a, b) => a - b);
  const pePercentile = peValues.length
    ? (peValues.filter((p) => p <= valuation.pe).length / peValues.length) * 100
    : 50;
  return expectedForwardReturn({ zByFactor, pePercentile, weights, newsZ });
}

/**
 * 由期望收益与 PE 分位生成三情景概率（softmax，Σ = 1）。
 * 情绪得分 s ∈ [−1,1]：s>0 偏多，s<0 偏空。
 *   s = 0.6·clip(E[r]/0.3) + 0.4·clip((50−分位)/50)
 * logit: 乐观=s，中性=0，悲观=−s；softmax(·/T)。
 */
export function scenarioProbabilities(
  expectedReturn: number,
  pePercentile: number,
  sentimentTilt = 0,
  newsTilt = 0,
): { optimistic: number; neutral: number; pessimistic: number } {
  const clip = (x: number) => Math.max(-1, Math.min(1, x));
  const base = (expectedReturn / 0.3) * 0.6 + ((50 - pePercentile) / 50) * 0.4;
  // 叠加有界专家情绪微调与最新消息微调（默认 0，不影响纯量化结果）
  const s = clip(base + clip(sentimentTilt) + clip(newsTilt));
  const logits = { optimistic: s, neutral: 0, pessimistic: -s };
  const keys = ['optimistic', 'neutral', 'pessimistic'] as const;
  const exps = keys.map((k) => Math.exp(logits[k] / SOFTMAX_TEMPERATURE));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = keys.map((k, i) => exps[i] / sum) as number[];
  return {
    optimistic: probs[0],
    neutral: probs[1],
    pessimistic: probs[2],
  };
}

/**
 * 目标价区间：期望目标价 = 当前价 × (1 + E[r])；区间 = 期望目标价 × (1 ± TARGET_BAND)。
 * 价格非负，四舍五入为整数（股价粒度）。
 */
export function targetPriceRange(
  currentPrice: number,
  expectedReturn: number,
  band = TARGET_BAND,
): { low: number; high: number } {
  const expectedTarget = currentPrice * (1 + expectedReturn);
  const low = Math.max(0, expectedTarget * (1 - band));
  const high = Math.max(0, expectedTarget * (1 + band));
  return { low: Math.round(low), high: Math.round(high) };
}

export interface PredictionValidationRow {
  factors: Record<string, number>;
  pePercentile: number;
  forwardReturn: number;
}

export interface PredictionValidationReport {
  directionalAccuracy: number; // 预测方向与实际方向一致比例 ∈ [0,1]
  rmse: number; // 预测收益与实现收益的 RMSE ≥ 0
  n: number;
}

/**
 * 在样本面板上验证预测模型（回测）。
 *  - 对每个因子做截面 z 标准化（跨面板样本）；
 *  - 用 expectedForwardReturn 得到预测收益；
 *  - 与实现收益比较，给出方向准确率与 RMSE。
 * 样本 < 3 返回空报告。
 */
export function validatePredictionModel(
  panel: PredictionValidationRow[],
): PredictionValidationReport {
  if (panel.length < 3) return { directionalAccuracy: 0, rmse: 0, n: panel.length };
  const names = Array.from(new Set(panel.flatMap((r) => Object.keys(r.factors))));
  let correct = 0;
  const sqErr: number[] = [];
  for (const row of panel) {
    const factorVals = names.map((nm) => row.factors[nm] ?? 0);
    const zs = crossSectionalZScore(factorVals);
    const zByFactor: Record<string, number> = {};
    names.forEach((nm, i) => (zByFactor[nm] = zs[i]));
    const er = expectedForwardReturn({ zByFactor, pePercentile: row.pePercentile });
    if (Math.sign(er.expectedReturn) === Math.sign(row.forwardReturn) && er.expectedReturn !== 0) {
      correct++;
    }
    sqErr.push((er.expectedReturn - row.forwardReturn) ** 2);
  }
  return {
    directionalAccuracy: correct / panel.length,
    rmse: Math.sqrt(sqErr.reduce((a, b) => a + b, 0) / sqErr.length),
    n: panel.length,
  };
}

/** 回测行（含可选的最新消息情绪 z 分） */
export interface NewsBacktestRow extends PredictionValidationRow {
  /** 最新消息情绪 z 分（缺省 0，即不含新闻） */
  newsZ?: number;
}

export interface NewsBacktestReport {
  /** 不含新闻的方向准确率 / RMSE */
  baseline: PredictionValidationReport;
  /** 含新闻的方向准确率 / RMSE */
  withNews: PredictionValidationReport;
  /** 方向准确率增量 = withNews − baseline（>0 表示新闻提升方向判断） */
  deltaAccuracy: number;
  /** RMSE 改善 = baseline − withNews（>0 表示新闻降低误差） */
  deltaRmse: number;
  /** 新闻信号的横截面Rank-IC（与实现收益的相关性，绝对值越大越有效） */
  newsIC: number;
  n: number;
}

/**
 * 根据最新消息进行回测（新闻因子有效性检验）。
 * 对每个样本分别计算：
 *   - 不含新闻：newsZ = 0 的预测；
 *   - 含新闻：newsZ = row.newsZ 的预测；
 * 比较两者的方向准确率与 RMSE，并给出新闻信号与实现收益的 Rank-IC。
 * 样本 < 3 或新闻全为 0 返回中性报告（delta=0, newsIC=0）。
 */
export function backtestNewsImpact(panel: NewsBacktestRow[]): NewsBacktestReport {
  const empty = (n: number): PredictionValidationReport => ({ directionalAccuracy: 0, rmse: 0, n });
  if (panel.length < 3) {
    return { baseline: empty(panel.length), withNews: empty(panel.length), deltaAccuracy: 0, deltaRmse: 0, newsIC: 0, n: panel.length };
  }

  const names = Array.from(new Set(panel.flatMap((r) => Object.keys(r.factors))));
  const hasNews = panel.some((r) => typeof r.newsZ === 'number' && r.newsZ !== 0);

  let baseCorrect = 0;
  let newsCorrect = 0;
  const baseSq: number[] = [];
  const newsSq: number[] = [];
  const newsZs: number[] = [];
  const fwdRets: number[] = [];

  for (const row of panel) {
    const factorVals = names.map((nm) => row.factors[nm] ?? 0);
    const zs = crossSectionalZScore(factorVals);
    const zByFactor: Record<string, number> = {};
    names.forEach((nm, i) => (zByFactor[nm] = zs[i]));

    const erBase = expectedForwardReturn({ zByFactor, pePercentile: row.pePercentile, newsZ: 0 });
    const nz = row.newsZ ?? 0;
    const erNews = expectedForwardReturn({ zByFactor, pePercentile: row.pePercentile, newsZ: nz });

    if (Math.sign(erBase.expectedReturn) === Math.sign(row.forwardReturn) && erBase.expectedReturn !== 0) baseCorrect++;
    if (Math.sign(erNews.expectedReturn) === Math.sign(row.forwardReturn) && erNews.expectedReturn !== 0) newsCorrect++;
    baseSq.push((erBase.expectedReturn - row.forwardReturn) ** 2);
    newsSq.push((erNews.expectedReturn - row.forwardReturn) ** 2);

    if (hasNews) {
      newsZs.push(nz);
      fwdRets.push(row.forwardReturn);
    }
  }

  const baseline: PredictionValidationReport = {
    directionalAccuracy: baseCorrect / panel.length,
    rmse: Math.sqrt(baseSq.reduce((a, b) => a + b, 0) / baseSq.length),
    n: panel.length,
  };
  const withNews: PredictionValidationReport = {
    directionalAccuracy: newsCorrect / panel.length,
    rmse: Math.sqrt(newsSq.reduce((a, b) => a + b, 0) / newsSq.length),
    n: panel.length,
  };

  const newsIC = hasNews && newsZs.length >= 3 ? pearson(newsZs, fwdRets) : 0;

  return {
    baseline,
    withNews,
    deltaAccuracy: withNews.directionalAccuracy - baseline.directionalAccuracy,
    deltaRmse: baseline.rmse - withNews.rmse,
    newsIC,
    n: panel.length,
  };
}

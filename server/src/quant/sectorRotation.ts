/**
 * 行业轮动信号模块（Sector Rotation Signal）
 * ----------------------------------------------------------------------------
 * 基于国信证券 DeepSeek 行业轮动研报的"三标尺模型"：
 *   1. 景气度（Prosperity）—— 基本面标尺：营收增速 / 利润增速 / ROE 变化
 *   2. 趋势（Trend）        —— 技术面标尺：行业指数动量（近 20/60 日收益率）+ 相对强弱 RS
 *   3. 拥挤度（Crowding）   —— 资金面标尺：换手率 / 成交额占比 / 北向资金集中度（反向）
 *
 * 综合评分公式（与研报一致）：
 *   compositeScore = 0.4 · 景气度 + 0.4 · 趋势 + 0.2 · (100 − 拥挤度)
 *
 * 推荐分档：
 *   - 综合排名前 20%  → overweight（超配）
 *   - 综合排名后 20%  → underweight（低配）
 *   - 中间 60%       → neutral（标配）
 *
 * 参考方法：
 *   - 国信证券 DeepSeek 行业轮动研报（三标尺模型框架）
 *   - 国盛证券相对强弱 RS 方法（RS 百分位 > 90 视为强势）
 *
 * 设计原则：
 *   - 纯函数，无外部 npm 依赖，无副作用，便于单元测试与离线校准复用
 *   - 截面 z 标准化消除量纲，与 factorAnalytics 模块同构（保持调用方一致体验）
 *   - 拥挤度作为反向标尺：拥挤度越高 → 综合评分越低（资金面过热风险）
 */

/** 综合评分中各标尺权重（景气度 0.4 + 趋势 0.4 + 拥挤度反向 0.2） */
export const SECTOR_WEIGHTS = {
  /** 景气度权重 */
  prosperity: 0.4,
  /** 趋势权重 */
  trend: 0.4,
  /** 拥挤度反向权重 */
  crowding: 0.2,
} as const;

/** 国盛证券 RS 强势阈值：RS 百分位 > 90 视为强势 */
export const RS_STRONG_THRESHOLD = 90;

/** 单行业输入数据：原始指标，由调用方从行情/财务数据中聚合 */
export interface SectorData {
  /** 行业名称 */
  sector: string;
  // —— 景气度（Prosperity）输入 ——
  /** 营收增速（%，YoY） */
  revenueGrowth: number;
  /** 利润增速（%，YoY） */
  profitGrowth: number;
  /** ROE 变化（百分点，同比变化） */
  roeChange: number;
  // —— 趋势（Trend）输入 ——
  /** 行业指数近 20 日收益率（%） */
  momentum20d: number;
  /** 行业指数近 60 日收益率（%） */
  momentum60d: number;
  // —— 拥挤度（Crowding）输入 ——
  /** 换手率（%，行业加权平均） */
  turnoverRate: number;
  /** 成交额占比（%，全 A 股市场占比） */
  volumeRatio: number;
  /** 北向资金集中度（%，持仓占比或净流入占比） */
  northboundConcentration: number;
  // —— 基准 ——
  /** 基准指数近 20 日收益率（%，通常为沪深 300 / 中证 800） */
  benchmarkMomentum20d: number;
}

/** 单行业轮动信号：截面计算后的标尺得分、综合评分、排名与推荐 */
export interface SectorSignal {
  /** 行业名称 */
  sector: string;
  /** 景气度得分 ∈ [0, 100]（越高越景气） */
  prosperity: number;
  /** 趋势得分 ∈ [0, 100]（越高越强） */
  trend: number;
  /** 拥挤度得分 ∈ [0, 100]（越高越拥挤，即风险越高；综合评分中取反向） */
  crowding: number;
  /** 综合评分 ∈ [0, 100]（越高越看好） */
  compositeScore: number;
  /** 排名（1 = 最优，按综合评分降序） */
  rank: number;
  /** 推荐：overweight(超配) / neutral(标配) / underweight(低配) */
  recommendation: 'overweight' | 'neutral' | 'underweight';
}

/** 行业轮动汇总结果：截面所有行业的信号集合 + 推荐 + 文字总结 */
export interface SectorRotationResult {
  /** 日期（YYYY-MM-DD，默认当日） */
  date: string;
  /** 各行业信号（按 rank 升序） */
  signals: SectorSignal[];
  /** 推荐超配的行业（前 20%） */
  topSectors: string[];
  /** 推荐低配的行业（后 20%） */
  bottomSectors: string[];
  /** 文字总结（含行业数量、超配/低配名单、最优/最弱行业） */
  summary: string;
}

/**
 * 截面 z 标准化：z = (x - μ) / σ。
 * σ = 0（常数列或单样本）时返回全 0，避免除零。
 * 与 factorAnalytics.crossSectionalZScore 同构；本模块内置以保持零外部依赖。
 */
function crossSectionalZScore(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return new Array<number>(n).fill(0);
  return values.map((v) => (v - mean) / std);
}

/**
 * 将 z 分映射到 [0, 100]：z=0 → 50，z=±1 → 60/40，线性夹紧。
 * 选择线性映射（而非 tanh）是为了让 0-100 标尺与研报口径一致、行业间差异可读。
 */
function zToScore(z: number): number {
  if (!isFinite(z)) return 50;
  return Math.max(0, Math.min(100, 50 + 10 * z));
}

/** 保留两位小数（消除浮点长尾，便于报告展示与断言） */
function round2(x: number): number {
  if (!isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

/**
 * 计算各行业的相对强弱 RS 百分位（国盛证券方法）。
 * RS_i = momentum20d_i − benchmarkMomentum20d_i（行业相对基准的超额动量）；
 * 按 RS 排序取其横截面分位 ∈ [0, 100]，并列取平均秩，单样本退化返回 50（中性）。
 * 国盛证券经验：RS > 90（即排名前 10%）视为强势行业。
 */
export function relativeStrengthPercentile(sectors: SectorData[]): number[] {
  const n = sectors.length;
  if (n === 0) return [];
  if (n === 1) return [50]; // 单样本无法比较，中性化避免除零

  const rs = sectors.map((s) => s.momentum20d - s.benchmarkMomentum20d);
  // 按值升序排列的原始索引
  const order = rs.map((_, i) => i).sort((a, b) => rs[a] - rs[b]);
  const pct = new Array<number>(n).fill(0);

  let i = 0;
  while (i < n) {
    // 找出与 order[i] 同值的所有并列位置 [i, j]
    let j = i;
    while (j + 1 < n && rs[order[j + 1]] === rs[order[i]]) j++;
    // 平均位置 → 分位（0-based 位置 / (n-1) · 100）
    const avgPos = (i + j) / 2;
    const percentile = (avgPos / (n - 1)) * 100;
    for (let k = i; k <= j; k++) pct[order[k]] = percentile;
    i = j + 1;
  }
  return pct;
}

/**
 * 景气度得分（截面）：
 * 对营收增速、利润增速、ROE 变化分别做截面 z 标准化后取均值，再映射到 [0, 100]。
 * 三个基本面因子等权反映行业整体景气方向。
 */
function calculateProsperity(sectors: SectorData[]): number[] {
  const zRev = crossSectionalZScore(sectors.map((s) => s.revenueGrowth));
  const zPro = crossSectionalZScore(sectors.map((s) => s.profitGrowth));
  const zRoe = crossSectionalZScore(sectors.map((s) => s.roeChange));
  return sectors.map((_, i) => zToScore((zRev[i] + zPro[i] + zRoe[i]) / 3));
}

/**
 * 趋势得分（截面）：
 *   trend = 0.4 · z(momentum20d) + 0.4 · z(momentum60d) + 0.2 · z_RS
 * 其中 z_RS 由 RS 百分位折算：(pct - 50) / 50 ∈ [-1, 1]，
 * 国盛证券方法中 RS>90 视为强势，本实现将其作为 z 分参与加权。
 */
function calculateTrend(sectors: SectorData[]): number[] {
  const zM20 = crossSectionalZScore(sectors.map((s) => s.momentum20d));
  const zM60 = crossSectionalZScore(sectors.map((s) => s.momentum60d));
  const rsPct = relativeStrengthPercentile(sectors);
  // RS 百分位 [0,100] → z 近似 [-1, 1]：50% 中性对应 z=0
  const zRS = rsPct.map((p) => (p - 50) / 50);
  return sectors.map((_, i) =>
    zToScore(0.4 * zM20[i] + 0.4 * zM60[i] + 0.2 * zRS[i]),
  );
}

/**
 * 拥挤度得分（截面）：
 * 对换手率、成交额占比、北向资金集中度分别做截面 z 标准化后取均值，再映射到 [0, 100]。
 * 拥挤度得分越高，代表资金面越拥挤（风险越高），下游综合评分中取反向（100 − crowding）。
 */
function calculateCrowding(sectors: SectorData[]): number[] {
  const zTurn = crossSectionalZScore(sectors.map((s) => s.turnoverRate));
  const zVol = crossSectionalZScore(sectors.map((s) => s.volumeRatio));
  const zNb = crossSectionalZScore(sectors.map((s) => s.northboundConcentration));
  return sectors.map((_, i) => zToScore((zTurn[i] + zVol[i] + zNb[i]) / 3));
}

/**
 * 生成文字总结：覆盖行业数量、超配/低配名单、最优/最弱行业。
 */
function buildSummary(
  signals: SectorSignal[],
  topSectors: string[],
  bottomSectors: string[],
): string {
  const n = signals.length;
  if (n === 0) return '无行业数据';
  const top = signals[0];
  const bottom = signals[n - 1];
  const topNames = topSectors.join('、') || '无';
  const bottomNames = bottomSectors.join('、') || '无';
  return (
    `本期共评估 ${n} 个行业。` +
    `超配：${topNames}；低配：${bottomNames}。` +
    `综合评分最优：${top.sector}（${top.compositeScore}）；最弱：${bottom.sector}（${bottom.compositeScore}）。`
  );
}

/**
 * 行业轮动主入口：基于三标尺模型计算行业轮动信号。
 *
 * 计算流程：
 *   1. 截面 z 标准化 → 三标尺得分（景气度/趋势/拥挤度，均 ∈ [0, 100]）
 *   2. 综合评分 = 0.4·prosperity + 0.4·trend + 0.2·(100 − crowding)
 *   3. 综合评分降序排名（1 = 最优）
 *   4. 推荐分档：rank ≤ ⌈0.2n⌉ → overweight；rank > n − ⌈0.2n⌉ → underweight
 *   5. 按 rank 升序输出，便于调用方消费
 *
 * 空输入（[] 或 null/undefined）安全降级为空结果。
 */
export function calculateSectorRotation(sectors: SectorData[]): SectorRotationResult {
  const date = new Date().toISOString().slice(0, 10);

  // 空输入安全降级
  if (!sectors || sectors.length === 0) {
    return {
      date,
      signals: [],
      topSectors: [],
      bottomSectors: [],
      summary: '无行业数据',
    };
  }

  // 1) 三标尺截面得分
  const prosperity = calculateProsperity(sectors);
  const trend = calculateTrend(sectors);
  const crowding = calculateCrowding(sectors);

  // 2) 综合评分（拥挤度取反向：100 − crowding）
  const signals: SectorSignal[] = sectors.map((s, i) => {
    const compositeScore =
      SECTOR_WEIGHTS.prosperity * prosperity[i] +
      SECTOR_WEIGHTS.trend * trend[i] +
      SECTOR_WEIGHTS.crowding * (100 - crowding[i]);
    return {
      sector: s.sector,
      prosperity: round2(prosperity[i]),
      trend: round2(trend[i]),
      crowding: round2(crowding[i]),
      compositeScore: round2(compositeScore),
      rank: 0, // 占位，待排名
      recommendation: 'neutral' as const,
    };
  });

  // 3) 综合评分降序排名（1 = 最优）
  const indexed = signals.map((sig, i) => ({ sig, i }));
  indexed.sort((a, b) => b.sig.compositeScore - a.sig.compositeScore);
  indexed.forEach((entry, rankZero) => {
    signals[entry.i].rank = rankZero + 1;
  });

  // 4) 推荐分档：前 20% overweight，后 20% underweight，中间 neutral
  const n = signals.length;
  const topK = Math.max(1, Math.ceil(n * 0.2));
  const bottomK = Math.max(1, Math.ceil(n * 0.2));
  for (const sig of signals) {
    if (sig.rank <= topK) {
      sig.recommendation = 'overweight';
    } else if (sig.rank > n - bottomK) {
      sig.recommendation = 'underweight';
    } else {
      sig.recommendation = 'neutral';
    }
  }

  // 5) 按 rank 升序输出，便于调用方消费
  const sorted = [...signals].sort((a, b) => a.rank - b.rank);
  const topSectors = sorted
    .filter((s) => s.recommendation === 'overweight')
    .map((s) => s.sector);
  const bottomSectors = sorted
    .filter((s) => s.recommendation === 'underweight')
    .map((s) => s.sector);

  // 6) 文字总结
  const summary = buildSummary(sorted, topSectors, bottomSectors);

  return {
    date,
    signals: sorted,
    topSectors,
    bottomSectors,
    summary,
  };
}

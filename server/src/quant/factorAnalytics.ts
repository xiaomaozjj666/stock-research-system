/**
 * 因子分析内核（Factor Analytics）
 * --------------------------------------------------------------------------
 * 这是「评分/预测所选因子必须最优 + 经过验证」的数学基础，遵循 Grinold & Kahn
 * 多因子组合框架：
 *   1. 信息系数 IC  —— 因子排序与未来收益排序的一致性（Spearman 秩相关）。
 *   2. 信息比率 IR  —— mean(IC) / std(IC)，衡量因子的稳定性与可重复性。
 *   3. 最优加权    —— 保留统计有效(IC/IR 达标)的因子，按 |IR|（或单截面时按 |IC|）
 *                     分配权重，使组合的信息比率最大化：IR_combo = sqrt(Σ IR_i²)。
 *   4. 组合与映射  —— 截面 z 标准化→加权合成→逻辑斯蒂映射到 [0,max]。
 *   5. 验证        —— 在样本面板上回测模型的预测方向与幅度（方向准确率 + RMSE）。
 *
 * 所有函数均为纯函数，无副作用，便于单元测试与离线校准复用。
 */

/** 平均秩（处理并列值）：返回与输入等长、元素为平均秩(0-based)的数组。 */
export function averageRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => [v, i] as [number, number]);
  indexed.sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j][0] === indexed[i][0]) j++;
    const avg = (i + j - 1) / 2; // 并列取平均秩
    for (let k = i; k < j; k++) ranks[indexed[k][1]] = avg;
    i = j;
  }
  return ranks;
}

/**
 * Spearman 秩信息系数（Rank IC）。
 * 输入：因子值序列 factor、对应未来收益序列 forward（长度须一致）。
 * 输出：秩相关系数 ∈ [-1, 1]；样本不足或退化时返回 0。
 */
export function spearmanRankIC(factor: number[], forward: number[]): number {
  if (factor.length !== forward.length || factor.length < 2) return 0;
  const rf = averageRanks(factor);
  const rfd = averageRanks(forward);
  const n = rf.length;
  const meanF = rf.reduce((a, b) => a + b, 0) / n;
  const meanD = rfd.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let df = 0;
  let dd = 0;
  for (let i = 0; i < n; i++) {
    const a = rf[i] - meanF;
    const b = rfd[i] - meanD;
    num += a * b;
    df += a * a;
    dd += b * b;
  }
  const den = Math.sqrt(df * dd);
  return den > 0 ? num / den : 0;
}

/**
 * 信息比率 IR = mean(IC) / std(IC)。
 * 衡量因子的稳定性：通常 |IR| ≥ 0.5 视为有效，≥ 1.0 为优秀。
 * 序列长度 < 2 或 std=0 时：std=0 表示完全稳定，按符号给极大 IR；否则返回 0。
 */
export function informationRatio(icSeries: number[]): number {
  if (icSeries.length < 2) return 0;
  const mean = icSeries.reduce((a, b) => a + b, 0) / icSeries.length;
  const variance = icSeries.reduce((s, v) => s + (v - mean) ** 2, 0) / icSeries.length;
  const std = Math.sqrt(variance);
  if (std === 0) return mean !== 0 ? Math.sign(mean) * 99 : 0;
  return mean / std;
}

/**
 * 截面 z 标准化：z = (x - μ) / σ。
 * σ = 0（含常数列或单样本）时返回全 0，避免除零。
 */
export function crossSectionalZScore(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return new Array<number>(n).fill(0);
  return values.map((v) => (v - mean) / std);
}

/**
 * Winsorize 缩尾：将两端极端值截断到 [lo, hi] 分位，提升稳健性。
 * 分位数采用线性插值；p 默认 0.05（两端各截 5%）。
 */
export function winsorize(values: number[], p = 0.05): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [values[0]];
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number): number => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const lo = quantile(p);
  const hi = quantile(1 - p);
  return values.map((v) => (v < lo ? lo : v > hi ? hi : v));
}

export interface FactorCandidate {
  /** 因子名 */
  name: string;
  /** 该因子逐期 / 逐截面的 IC 序列（至少 1 个） */
  icSeries: number[];
}

export interface SelectedFactor {
  name: string;
  /** 归一化权重，Σ = 1 */
  weight: number;
  /** 平均 IC */
  ic: number;
  /** 信息比率 */
  ir: number;
}

export interface FactorSelectionOptions {
  /** 平均 |IC| 下限，低于视为统计无效并剔除（默认 0.02） */
  minAbsIC?: number;
  /** |IR| 下限，仅在 IC 序列长度 ≥ 2 时生效（默认 0.3） */
  minAbsIR?: number;
}

/**
 * 最优因子选择（Grinold & Kahn）。
 *  - 剔除平均 |IC| 不达标者；当 IC 序列可估计 IR 时（长度 ≥ 2），再剔除 |IR| 不达标者。
 *  - 对保留因子按「有效性」分配权重：多截面时按 |IR|，单截面时按 |IC|（无 IR 可用）。
 *  - 权重归一化 Σ = 1。无任何有效因子时回退为等权，保证调用方始终拿到可用权重。
 * 组合信息比率上界满足 IR_combo = sqrt(Σ IR_i²)，即「分散化提升稳定性」。
 */
export function selectOptimalFactors(
  candidates: FactorCandidate[],
  opts: FactorSelectionOptions = {},
): SelectedFactor[] {
  const minAbsIC = opts.minAbsIC ?? 0.02;
  const minAbsIR = opts.minAbsIR ?? 0.3;

  const scored = candidates.map((c) => {
    const valid = c.icSeries.filter((v) => isFinite(v));
    const ic = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
    const ir = informationRatio(valid);
    const hasIR = valid.length >= 2;
    const effective = hasIR ? Math.abs(ir) : Math.abs(ic);
    const keep = Math.abs(ic) >= minAbsIC && (!hasIR || Math.abs(ir) >= minAbsIR);
    return { name: c.name, ic, ir, effective, keep };
  });

  let kept = scored.filter((s) => s.keep);
  if (kept.length === 0) kept = scored; // 回退等权

  const totalEff = kept.reduce((s, f) => s + f.effective, 0);
  // 全部保留因子有效性为 0 时（如 IC 序列均值恰为 0），显式回退等权；
  // 否则 0/totalEff 会让 Σweight=0，违反「归一化 Σ=1」契约并使下游 compositeZ 恒为 0
  if (totalEff <= 0) {
    return kept
      .map((f) => ({ name: f.name, ic: f.ic, ir: f.ir, weight: 1 / kept.length }))
      .sort((a, b) => b.weight - a.weight);
  }
  return kept
    .map((f) => ({
      name: f.name,
      ic: f.ic,
      ir: f.ir,
      weight: f.effective / totalEff,
    }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * 组合 z 分数：对若干因子的 z 值按权重加权求和（最优组合），返回合成 z（未裁剪）。
 * 缺失因子自动跳过；权重和为 0 时返回 0。
 */
export function compositeZ(
  zByFactor: Record<string, number>,
  weights: Record<string, number>,
): number {
  let s = 0;
  let wsum = 0;
  for (const [name, w] of Object.entries(weights)) {
    const z = zByFactor[name];
    if (z === undefined || !isFinite(z)) continue;
    s += w * z;
    wsum += w;
  }
  return wsum > 0 ? s / wsum : 0;
}

/**
 * 将合成 z 逻辑斯蒂映射到 [0, max]：z = 0 → max/2，单调递增、平滑有界。
 * zScale 控制灵敏度（z = ±zScale 约对应 0.12/0.88 分位）。
 */
export function zToScore(z: number, max: number, zScale = 2): number {
  if (Number.isNaN(z)) return 0;
  if (z === Infinity) return max;
  if (z === -Infinity) return 0;
  const raw = 0.5 + 0.5 * Math.tanh(z / zScale);
  return Math.max(0, Math.min(max, Math.round(raw * max)));
}

/** 面板的一行：某股票在某时点的因子值与未来实现收益 */
export interface FactorPanelRow {
  factors: Record<string, number>;
  forwardReturn: number;
  /**
   * 样本日期（YYYY-MM-DD，qlib calc_ic 口径）。
   * 提供时（要求每行都有），validateFactorModel 按「每日截面」分组计算每日 IC 序列
   * （组内样本 ≥2 才计），再聚合 IC / ICIR（= mean/std，qlib ICIR 口径）——
   * 避免把不同日期的样本混入同一个秩相关（跨期秩混合会扭曲 IC）。
   * 缺省时保持向后兼容：全样本单 IC。
   */
  date?: string;
}

/** 因子模型验证的缺失处理与筛选参数 */
export interface FactorValidationOptions extends FactorSelectionOptions {
  /**
   * 允许丢弃的最大缺失比例 ∈ [0,1]；实际丢弃比例超出时抛错（默认 0.25，alphalens 同默认）。
   * 缺失行 = 因子值非有限、或该因子键不存在的样本。
   *
   * 背景：此前这类样本被 `?? 0` 当成真实的 0 参与排序与标准化，等价于把
   * 「数据缺失」伪装成「因子值中位数偏下」，会系统性污染 IC 方向与权重大小。
   * 现按 alphalens `get_clean_factor_and_forward_returns` 口径显式丢弃，
   * 并在丢弃比例过大时抛错——静默接受大面积缺失比报错更危险。
   */
  maxLoss?: number;
}

export interface FactorValidationReport {
  /** 每个因子的 IC / IR / ICIR / 是否入选 / 权重 */
  perFactor: {
    name: string;
    ic: number;
    ir: number;
    icir?: number;
    selected: boolean;
    weight: number;
  }[];
  /** 模型预测方向与实际方向一致的比例 ∈ [0,1] */
  directionalAccuracy: number;
  /** 预测收益（组合z×已实现波动）与实现收益的 RMSE ≥ 0 */
  rmse: number;
  /** 输入面板样本数 */
  n: number;
  /** 因因子值缺失被丢弃的样本数 */
  dropped: number;
  /** 实际参与计算的样本数 = n − dropped */
  used: number;
}

/**
 * 在样本面板上验证因子模型（离线校准 / 回测）。
 *  - 对每个因子计算 Spearman IC：面板每行都有 date 时按「每日截面」分组算每日 IC 序列
 *    （qlib calc_ic 口径），否则全样本单 IC（向后兼容）；
 *  - 用 selectOptimalFactors 选出最优权重（多截面路径自动按 |IR|=|ICIR| 加权）；
 *  - 以「组合 z × 已实现收益波动」作为预测收益，与实现收益比较，
 *    给出方向准确率与 RMSE，作为模型有效性的量化证据。
 * 面板样本 < 3 时直接返回空报告（样本不足，无法验证）。
 */
export function validateFactorModel(
  panel: FactorPanelRow[],
  opts: FactorValidationOptions = {},
): FactorValidationReport {
  const empty: FactorValidationReport = {
    perFactor: [],
    directionalAccuracy: 0,
    rmse: 0,
    n: panel.length,
    dropped: panel.length,
    used: 0,
  };
  if (panel.length < 3) return empty;

  const names = Array.from(new Set(panel.flatMap((row) => Object.keys(row.factors))));

  // 缺失处理：任一因子值非有限（含键不存在）的整行丢弃。
  // 不能用 `?? 0` 兜底——那会把缺失伪装成真实的 0，使其参与截面排序与 z 标准化，
  // 等价于给「数据缺失」的标的安了一个偏低的因子值，方向性污染 IC。
  const complete = panel.filter((row) =>
    names.every((name) => Number.isFinite(row.factors?.[name])),
  );
  const dropped = panel.length - complete.length;
  const dropRatio = panel.length > 0 ? dropped / panel.length : 0;
  const maxLoss = opts.maxLoss ?? 0.25;
  if (dropRatio > maxLoss) {
    throw new Error(
      `因子面板缺失过大：丢弃 ${dropped}/${panel.length}（${(dropRatio * 100).toFixed(1)}%），` +
        `超过 maxLoss=${(maxLoss * 100).toFixed(1)}%。请检查数据源或显式放宽 maxLoss。`,
    );
  }

  const forward = complete.map((row) => row.forwardReturn);
  const fwdMean = forward.reduce((a, b) => a + b, 0) / forward.length;
  const fwdStd = Math.sqrt(forward.reduce((s, v) => s + (v - fwdMean) ** 2, 0) / forward.length);

  // 每日截面分组（qlib calc_ic 口径）：仅当面板每行都有 date 时启用
  const hasDates = complete.every((row) => typeof row.date === 'string' && row.date.length > 0);
  // 单遍构建 Map<date, rows[]>：避免 dates.map(d => panel.filter(...)) 的 O(D×N) 重复扫描
  const byDate = new Map<string, FactorPanelRow[]>();
  if (hasDates) {
    for (const row of complete) {
      const list = byDate.get(row.date as string);
      if (list) list.push(row);
      else byDate.set(row.date as string, [row]);
    }
  }
  const dates = hasDates ? Array.from(byDate.keys()) : null;

  const candidates: FactorCandidate[] = names.map((name) => {
    if (dates) {
      // 每日截面 Spearman IC 序列：该日组内样本的因子值 vs 未来收益的秩相关。
      // complete 已保证所有 name 均有限，无需再兜底
      const icSeries = dates
        .map((d) => {
          const dayRows = byDate.get(d) as FactorPanelRow[];
          if (dayRows.length < 2) return null;
          return spearmanRankIC(
            dayRows.map((row) => row.factors[name]),
            dayRows.map((row) => row.forwardReturn),
          );
        })
        .filter((v): v is number => v !== null);
      return { name, icSeries };
    }
    // 向后兼容：全样本单 IC
    return {
      name,
      icSeries: [
        spearmanRankIC(
          complete.map((row) => row.factors[name]),
          forward,
        ),
      ],
    };
  });
  const selected = selectOptimalFactors(candidates, opts);
  const weightMap: Record<string, number> = {};
  selected.forEach((s) => (weightMap[s.name] = s.weight));

  // 逐行预测：每个因子先跨面板行（截面）标准化，再按权重合成组合 z。
  // 注意：此前把「同一行内不同因子的值」做 z 标准化——不同量纲/含义的因子互相比
  // 在统计上无意义，会使 directionalAccuracy / RMSE 完全失真。
  // complete 已过滤掉任一因子缺失的行，这里可直接取值
  const zByRowByFactor: Record<string, number[]> = {};
  for (const name of names) {
    zByRowByFactor[name] = crossSectionalZScore(complete.map((row) => row.factors[name]));
  }
  let correct = 0;
  const sqErr: number[] = [];
  for (let r = 0; r < complete.length; r++) {
    const zByFactor: Record<string, number> = {};
    for (const name of names) zByFactor[name] = zByRowByFactor[name][r];
    const cz = compositeZ(zByFactor, weightMap);
    const predicted = cz * (fwdStd || 1);
    if (Math.sign(predicted) === Math.sign(complete[r].forwardReturn) && predicted !== 0) correct++;
    sqErr.push((predicted - complete[r].forwardReturn) ** 2);
  }

  return {
    perFactor: candidates.map((c) => {
      const sel = selected.find((s) => s.name === c.name);
      // ICIR（qlib 口径）= mean(IC)/std(IC)，仅多截面 IC 序列（长度 ≥ 2）时可得
      const icir = c.icSeries.length >= 2 ? informationRatio(c.icSeries) : undefined;
      return {
        name: c.name,
        ic: sel?.ic ?? 0,
        ir: sel?.ir ?? 0,
        ...(icir !== undefined ? { icir } : {}),
        selected: !!sel,
        weight: sel?.weight ?? 0,
      };
    }),
    directionalAccuracy: complete.length > 0 ? correct / complete.length : 0,
    rmse: sqErr.length > 0 ? Math.sqrt(sqErr.reduce((a, b) => a + b, 0) / sqErr.length) : 0,
    n: panel.length,
    dropped,
    used: complete.length,
  };
}

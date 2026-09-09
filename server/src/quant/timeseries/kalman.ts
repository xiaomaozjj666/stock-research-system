/**
 * Kalman 滤波：信号提取与时变对冲比率。
 * ============================================================================
 * 提供两个专用模型（而不是通用状态空间抽象——项目里只有这两类需求，
 * 专用实现比通用框架更容易读、也更容易验证）：
 *
 * 一、局部水平模型（随机游走 + 观测噪声）——价格/价差的平滑与趋势提取
 *    状态：level_t = level_{t-1} + w，w ~ N(0, Q)
 *    观测：y_t = level_t + v，v ~ N(0, R)
 *    信号噪声比 q = Q/R 是唯一超参数：q 大滤波贴近原始序列，q 小输出平滑。
 *    常用 q ∈ [0.01, 1]（q=1 近似把逐日变化全部当信号）。
 *
 * 二、时变对冲比率（配对交易的动态 β）——协整关系的在线估计
 *    状态：[α_t, β_t]' 均为随机游走；观测：y_t = α_t + β_t·x_t + v
 *    对冲比率会漂移是常态（结构性断点），静态 OLS 的 β 是全样本平均，
 *    Kalman 给出逐日路径与期末值，并能暴露 β 的漂移速度。
 *    超参数 qRatio = Q(β)/R 控制对 β 漂移的灵敏程度。
 *
 * 全部纯函数、确定性、无第三方依赖。
 */

/** 单状态（标量）Kalman 一步预测 + 更新 */
function scalarFilter(
  y: number[],
  qOverR: number,
  initialLevel: number,
): { level: number[]; variance: number[]; oneStepErrors: number[] } {
  const n = y.length;
  const level = new Array<number>(n);
  const variance = new Array<number>(n);
  const oneStepErrors = new Array<number>(n);
  // 初始：P0 = R/qRatio 视作「不确定性远大于观测噪声」的朴素起点；
  // 等价实现：P0 取大数，前几期自动收敛。R 不可识别（q 是比值），归一化 R=1。
  let a = initialLevel;
  let p = 1e4;
  const R = 1;
  const Q = qOverR * R;
  for (let t = 0; t < n; t++) {
    // 预测
    const aPred = a;
    const pPred = p + Q;
    // 更新
    const innovation = y[t] - aPred;
    const kg = pPred / (pPred + R);
    a = aPred + kg * innovation;
    p = (1 - kg) * pPred;
    level[t] = a;
    variance[t] = p;
    oneStepErrors[t] = innovation;
  }
  return { level, variance, oneStepErrors };
}

export interface LocalLevelResult {
  /** 滤波后的水平序列 */
  level: number[];
  /** 滤波方差序列 */
  variance: number[];
  /** 一步预测误差（新息）序列 */
  oneStepErrors: number[];
  /** 新息标准差（相对原始序列标准差的比例，诊断滤波贴合度） */
  innovationStdRatio: number;
  qRatio: number;
}

/**
 * 局部水平模型滤波。
 * @param series 观测序列（价格/价差）
 * @param opts.qRatio 信号噪声比 Q/R（默认 0.1；越大越贴合原始序列）
 */
export function localLevelFilter(
  series: number[],
  opts: { qRatio?: number } = {},
): LocalLevelResult {
  const qRatio = opts.qRatio ?? 0.1;
  if (series.length < 10) {
    throw new Error(`局部水平滤波需要至少 10 个观测，当前 ${series.length}`);
  }
  const m = series.reduce((a, b) => a + b, 0) / series.length;
  const { level, variance, oneStepErrors } = scalarFilter(series, qRatio, m);
  const sdObs = Math.sqrt(
    series.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(series.length - 1, 1),
  );
  const mErr = oneStepErrors.reduce((a, b) => a + b, 0) / oneStepErrors.length;
  const sdErr = Math.sqrt(
    oneStepErrors.reduce((a, b) => a + (b - mErr) * (b - mErr), 0) /
      Math.max(oneStepErrors.length - 1, 1),
  );
  return {
    level,
    variance,
    oneStepErrors,
    innovationStdRatio: sdObs > 0 ? sdErr / sdObs : NaN,
    qRatio,
  };
}

export interface TimeVaryingBetaResult {
  /** 时变截距 α_t 序列 */
  intercept: number[];
  /** 时变对冲比率 β_t 序列 */
  hedgeRatio: number[];
  /** 期末 β（与静态 OLS 的差距反映近期漂移） */
  finalHedgeRatio: number;
  /** 静态 OLS β（全样本平均口径，对照用） */
  staticHedgeRatio: number;
  /** β 的近期漂移速度：β_T − β_{T−20}（20 日变动） */
  recentDrift: number;
  /** 一步预测误差（新息）序列 */
  oneStepErrors: number[];
  /** 滤波 RMSE（y 的量纲），与静态 OLS RMSE 对照 */
  filterRmse: number;
  staticRmse: number;
  qRatio: number;
}

/**
 * 时变对冲比率：y_t = α_t + β_t·x_t + v，状态 [α, β] 随机游走。
 *
 * 用 2×2 Kalman（手写矩阵运算，维度固定无需通用线性代数）。
 * @param y 因变量价格序列
 * @param x 自变量价格序列（与 y 等长、按日期对齐）
 * @param opts.qRatio 状态噪声/观测噪声（默认 1e-4：β 缓慢漂移；调大更灵敏）
 */
export function timeVaryingBeta(
  y: number[],
  x: number[],
  opts: { qRatio?: number } = {},
): TimeVaryingBetaResult {
  if (y.length !== x.length) {
    throw new Error(`y 与 x 长度不一致：${y.length} vs ${x.length}`);
  }
  if (y.length < 30) {
    throw new Error(`时变对冲比率需要至少 30 个对齐观测，当前 ${y.length}`);
  }
  const qRatio = opts.qRatio ?? 1e-4;

  // 静态 OLS 起点与对照
  let sxy = 0;
  let sxx = 0;
  const n = y.length;
  const my = y.reduce((a, b) => a + b, 0) / n;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  for (let t = 0; t < n; t++) {
    sxy += (y[t] - my) * (x[t] - mx);
    sxx += (x[t] - mx) * (x[t] - mx);
  }
  const beta0 = sxx > 0 ? sxy / sxx : 1;
  const alpha0 = my - beta0 * mx;

  const R = 1; // 观测噪声归一化
  const q = qRatio * R;

  // 状态 [α, β]，协方差 P 2×2
  let a = [alpha0, beta0];
  const P: number[][] = [
    [1e4, 0],
    [0, 1e4],
  ];
  const intercept = new Array<number>(n);
  const hedgeRatio = new Array<number>(n);
  const oneStepErrors = new Array<number>(n);
  let ssrFilter = 0;

  for (let t = 0; t < n; t++) {
    // 预测（F = I）
    // 更新：观测矩阵 H = [1, x_t]
    const h1 = 1;
    const h2 = x[t];
    const yPred = a[0] * h1 + a[1] * h2;
    const innovation = y[t] - yPred;
    // S = H P H' + R
    const sPH1 = P[0][0] * h1 + P[0][1] * h2;
    const sPH2 = P[1][0] * h1 + P[1][1] * h2;
    const S = h1 * sPH1 + h2 * sPH2 + R;
    // K = P H' / S
    const k1 = sPH1 / S;
    const k2 = sPH2 / S;
    a = [a[0] + k1 * innovation, a[1] + k2 * innovation];
    // P = (I − K H) P：先用旧 P 整体算出 K·H·P，再统一赋值（就地更新会串行污染）
    const kHP: number[][] = [
      [0, 0],
      [0, 0],
    ];
    for (let r = 0; r < 2; r++) {
      const kr = r === 0 ? k1 : k2;
      for (let c = 0; c < 2; c++) {
        kHP[r][c] = kr * (P[0][c] * h1 + P[1][c] * h2);
      }
    }
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        P[r][c] = P[r][c] - kHP[r][c];
      }
    }
    // 状态噪声（随机游走）以绝对增量加在对角
    P[0][0] += q;
    P[1][1] += q;

    intercept[t] = a[0];
    hedgeRatio[t] = a[1];
    oneStepErrors[t] = innovation;
    ssrFilter += innovation * innovation;
  }

  let ssrStatic = 0;
  for (let t = 0; t < n; t++) {
    const e = y[t] - (alpha0 + beta0 * x[t]);
    ssrStatic += e * e;
  }

  const tail = Math.min(20, n - 1);
  const recentDrift = hedgeRatio[n - 1] - hedgeRatio[n - 1 - tail];

  return {
    intercept,
    hedgeRatio,
    finalHedgeRatio: hedgeRatio[n - 1],
    staticHedgeRatio: beta0,
    recentDrift,
    oneStepErrors,
    filterRmse: Math.sqrt(ssrFilter / n),
    staticRmse: Math.sqrt(ssrStatic / n),
    qRatio,
  };
}

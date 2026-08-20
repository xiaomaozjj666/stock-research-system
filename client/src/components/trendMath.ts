/**
 * 走势图纯计算工具（无 DOM / 无 ECharts 依赖，便于单元测试）
 * ----------------------------------------------------------------------------
 * 所有函数均为纯函数：相同输入必得相同输出，不修改入参。
 */

export type Period = 'day' | 'week' | 'month';

/** 简单移动平均。返回与输入等长数组，前 n-1 个位置为 null（样本不足）。 */
export function computeMA(series: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= n) sum -= series[i - n];
    out.push(i >= n - 1 ? Math.round((sum / n) * 1000) / 1000 : null);
  }
  return out;
}

/**
 * 指数移动平均（EMA）。首值用前 n 个样本的 SMA 初始化（行业通行做法），
 * 之后按标准递推：EMA_t = α·x_t + (1-α)·EMA_{t-1}，α = 2/(n+1)。
 */
export function computeEMA(series: number[], n: number): number[] {
  if (series.length === 0) return [];
  const alpha = 2 / (n + 1);
  const out: number[] = [];
  let prev = series[0];
  for (let i = 0; i < series.length; i++) {
    prev = i === 0 ? series[0] : alpha * series[i] + (1 - alpha) * prev;
    out.push(Math.round(prev * 1000) / 1000);
  }
  // 用前 n 个样本均值修正首值，避免初始段偏差过大
  if (series.length >= n) {
    let seed = 0;
    for (let i = 0; i < n; i++) seed += series[i];
    out[n - 1] = Math.round((seed / n) * 1000) / 1000;
    for (let i = n; i < series.length; i++) {
      out[i] = Math.round((alpha * series[i] + (1 - alpha) * out[i - 1]) * 1000) / 1000;
    }
  }
  return out;
}

export interface MacdPoint {
  dif: number; // 快慢线差（EMA12 - EMA26）
  dea: number; // DIF 的 9 日 EMA（信号线）
  macd: number; // 2 × (DIF - DEA)（柱状）
}

/** MACD（12/26/9），与同花顺/东方财富口径一致。 */
export function computeMACD(closes: number[]): MacdPoint[] {
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  const dif = closes.map((_, i) => Math.round((ema12[i] - ema26[i]) * 1000) / 1000);
  // DEA = DIF 的 9 日 EMA
  const deaRaw = computeEMA(dif, 9);
  return dif.map((d, i) => {
    const dea = deaRaw[i];
    const macd = Math.round((2 * (d - dea)) * 1000) / 1000;
    return { dif: d, dea, macd };
  });
}

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isSimulated?: boolean;
}

/**
 * 把日K聚合为周K / 月K（东方财富"周线/月线"口径）：
 * - 周K：按自然周分组（周一~周日），取周一首日开盘、周日末日收盘、区间高低、量求和。
 * - 月K：按 YYYY-MM 分组，同理。
 * 日K 原样返回（仅类型归一）。
 */
export function aggregateCandles(daily: Candle[], period: Period): Candle[] {
  if (period === 'day' || daily.length === 0) return daily;

  const buckets = new Map<string, Candle[]>();
  for (const c of daily) {
    const d = new Date(c.date + 'T00:00:00');
    let key: string;
    if (period === 'month') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    } else {
      // ISO 周：用周四所在的周作为该周标识，保证跨年/跨月稳定
      const day = d.getDay(); // 0=周日
      const diffToThu = 4 - (day === 0 ? 7 : day);
      const thu = new Date(d);
      thu.setDate(d.getDate() + diffToThu);
      const y = thu.getFullYear();
      const startOfYear = new Date(y, 0, 1);
      const week = Math.ceil(
        ((thu.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7,
      );
      key = `${y}-W${String(week).padStart(2, '0')}`;
    }
    const arr = buckets.get(key);
    if (arr) arr.push(c);
    else buckets.set(key, [c]);
  }

  const out: Candle[] = [];
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    const open = arr[0].open;
    const close = arr[arr.length - 1].close;
    const high = Math.max(...arr.map((x) => x.high));
    const low = Math.min(...arr.map((x) => x.low));
    const volume = arr.reduce((s, x) => s + x.volume, 0);
    // 聚合后的周期为模拟数据，当且仅当其下所有交易日均为模拟
    const isSimulated = arr.every((x) => x.isSimulated);
    out.push({ date: arr[0].date, open, high, low, close, volume, isSimulated });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

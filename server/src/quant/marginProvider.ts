/**
 * 融资融券数据源（东方财富 datacenter）——日度两融序列 + 两融截面因子。
 *
 * 背景（2026-09-12）：两融余额是 A 股特有的杠杆资金情绪指标，此前系统只有
 * 量价/基本面/事件三类因子，缺「资金面」。东财 datacenter 报表
 * RPTA_WEB_RZRQ_GGMX 提供逐股日度序列（融资余额/净买入/占比），免费、
 * 免鉴权、与 eventProvider 同源同模式。
 *
 * **字段口径已用真实 API 响应验证（2026-09-12 ground truth，600036 招商银行）**：
 *   - 请求：reportName=RPTA_WEB_RZRQ_GGMX，filter=(scode="600036")，
 *     sortColumns=DATE&sortTypes=-1（该报表的时间列是 DATE，不是 DIM_DATE——
 *     用 DIM_DATE 排序会报 9501「列不存在」，已实测）；
 *   - DATE=交易日（"YYYY-MM-DD HH:mm:ss" 格式）；SCODE=6 位代码；MARKET=所属市场；
 *   - RZYE=融资余额（元，9815585112 ≈ 98.16 亿）；
 *   - RZJME=融资净买入（元，当日 融资买入−融资偿还）；
 *   - RZYEZB=融资余额占总市值比（%，与 RZYE/SZ×100 交叉印证：9815585112 /
 *     853006852139 = 1.1506% ≈ RZYEZB=1.15070413）；
 *   - SZ=总市值（元）；RZRQYE=融资融券余额（元）。
 *   - 序列长度：该报表全历史约 4000+ 行（2014 年至今），pageSize=500 取最近
 *     约 2 年，对 20 日变化率与评估窗口足够。
 *
 * **PIT（point-in-time）纪律——T+1 披露延迟**：交易所两融数据是 T 日交易、
 * T+1 日盘前披露。因此交易日 t 的因子值只能使用**日期严格小于 t** 的两融行
 * （即 t−1 及更早），绝不允许使用 date == t 的行——那在 t 日收盘决策时点还
 * 不存在。这是本模块与量价因子最大的口径差异，marginFactorValues 内强制执行。
 *
 * 缓存：与事件同模式（历史追加不重写），TTL 默认 24h
 * （QUANT_MARGIN_CACHE_TTL_HOURS，显式 0 = 关闭）。
 */
import { fetchReportRows } from './eventProvider.js';
import { withQuantCache } from './quantCache.js';

/** 单股单日两融行（单位统一为元/百分比，日期为 YYYY-MM-DD） */
export interface MarginRow {
  date: string;
  /** 融资余额（元） */
  balance: number;
  /** 融资余额占总市值比（%，东财原值口径） */
  balancePct: number | null;
  /** 融资净买入（元，可负） */
  netBuy: number | null;
}

/** 两融截面因子名 */
export type MarginFactorName = 'mg_balance_chg20' | 'mg_balance_pct';

export const MARGIN_FACTOR_NAMES: MarginFactorName[] = ['mg_balance_chg20', 'mg_balance_pct'];

function marginCacheTtlMs(): number {
  const raw = process.env.QUANT_MARGIN_CACHE_TTL_HOURS;
  if (raw !== undefined && raw.trim() !== '') {
    const hours = Number(raw);
    if (Number.isFinite(hours)) return hours > 0 ? hours * 60 * 60 * 1000 : 0;
  }
  return 24 * 60 * 60 * 1000;
}

/** 东财日期可能是 "YYYY-MM-DD HH:mm:ss"，归一为前 10 位 */
function normDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}

/** 按候选字段取数值（数字或可解析字符串），全缺返回 null */
function numOf(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * 拉取单股两融日度序列（最近约 2 年，降序返回 → 本函数内转升序）。
 * 返回 [] 表示「查询成功且无数据」（如未开通两融标的）；抛错由调用方降级。
 */
export async function fetchMarginSeries(code: string, signal?: AbortSignal): Promise<MarginRow[]> {
  return withQuantCache(`margin_series_${code}`, marginCacheTtlMs(), async () => {
    const rows = await fetchReportRows(
      'RPTA_WEB_RZRQ_GGMX',
      `(scode="${code}")`,
      'DATE',
      '-1',
      signal,
    );
    // 同日可能出现多行（理论上不会，防御性去重：保留首行）；转升序
    const byDate = new Map<string, MarginRow>();
    for (const row of rows) {
      const date = normDate(row.DATE);
      const balance = numOf(row, ['RZYE']);
      if (!date || balance === null || balance <= 0) continue;
      if (byDate.has(date)) continue;
      byDate.set(date, {
        date,
        balance,
        balancePct: numOf(row, ['RZYEZB']),
        netBuy: numOf(row, ['RZJME']),
      });
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  });
}

/** 二分查找：dates 中最后一个严格小于 d 的下标；无则 -1（升序数组） */
function lastStrictlyBefore(dates: string[], d: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < d) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 两融因子逐日取值（PIT：t 日只用 date < t 的行）。
 *
 *   - mg_balance_pct：融资余额占总市值比（%），杠杆拥挤度水平因子；
 *   - mg_balance_chg20：融资余额 20 日变化率（小数），杠杆资金动量因子——
 *     以两融行自身的 20 行前为基期（两融行逐交易日一条，20 行 ≈ 20 个交易日）。
 *
 * 行不足 21 条或基期值非法时该日该因子为 null（如实跳过，不强行出值）。
 */
export function marginFactorValues(
  rows: MarginRow[],
  barDates: string[],
): Record<MarginFactorName, (number | null)[]> {
  const dates = rows.map((r) => r.date); // 约定升序（fetchMarginSeries 已排序）
  const pct: (number | null)[] = [];
  const chg20: (number | null)[] = [];
  for (const d of barDates) {
    const idx = lastStrictlyBefore(dates, d);
    if (idx < 0) {
      pct.push(null);
      chg20.push(null);
      continue;
    }
    const row = rows[idx];
    pct.push(row.balancePct !== null && Number.isFinite(row.balancePct) ? row.balancePct : null);
    if (idx >= 20) {
      const base = rows[idx - 20].balance;
      chg20.push(base > 0 ? row.balance / base - 1 : null);
    } else {
      chg20.push(null);
    }
  }
  return { mg_balance_chg20: chg20, mg_balance_pct: pct };
}

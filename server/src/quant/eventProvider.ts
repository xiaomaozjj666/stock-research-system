import logger from '../utils/logger.js';
import { withQuantCache } from './quantCache.js';

/**
 * 公司事件数据源（东方财富 datacenter）——分红送配 / 股票回购 / 限售解禁。
 *
 * 背景（2026-09-05）：事件因子此前只有业绩超预期（PEAD，由季度财报派生，
 * 不需要独立数据源）。分红/回购/解禁不在财报字段里，本模块接入东财三个
 * 免鉴权 datacenter 报表（与既有 push2his 同源体系、无新依赖）：
 *
 *   - 分红送配：reportName=RPT_SHAREBONUS_DET（预案公告日/除权除息日/每10股股利/股息率）
 *   - 股票回购：reportName=RPT_REPURCHASE_PLAN（最新公告日/占总股本比例上限/金额上限/进度）
 *   - 限售解禁：reportName=RPT_LIFT_STAGE（解禁日/解禁数量/解禁市值/FREE_RATIO 占解禁前流通市值比例）
 *
 * 字段口径经 akshare 源码交叉核对；为抵抗字段改名与口径漂移，解析一律走
 * 候选字段列表 + 严格 null（缺数据如实缺，绝不洗成 0）。
 *
 * 缓存：事件为低频追加数据（历史不重写），按 code 缓存全量事件列表，
 * TTL 默认 24h（QUANT_EVENT_CACHE_TTL_HOURS，显式 0 = 关闭）。
 * key 不含日期区间——避免重蹈 K 线滚动窗口缓存每日全失效的覆辙。
 */

const DATA_CENTER_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const PAGE_SIZE = 500; // 单票事件远不足 500 行；超出部分忽略（如实记录在代码口径）

/** 事件缓存 TTL（毫秒）。env 显式 0/负值 = 关闭缓存（与 fundamentalCache 同语义）。 */
function eventCacheTtlMs(): number {
  const raw = process.env.QUANT_EVENT_CACHE_TTL_HOURS;
  if (raw !== undefined && raw.trim() !== '') {
    const hours = Number(raw);
    if (Number.isFinite(hours)) return hours > 0 ? hours * 60 * 60 * 1000 : 0;
  }
  return 24 * 60 * 60 * 1000;
}

/** 东财 datacenter 日期可能是 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm:ss"，归一为前 10 位 */
function normDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}

/** 按候选字段列表取数值（数字或可解析字符串），全缺返回 null */
function numOf(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** 按候选字段列表取字符串（去除首尾空白，空串视为缺失） */
function strOf(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * 拉取一份 datacenter 报表（单票过滤）。
 * 返回 [] 表示「查询成功且无数据」；抛错表示网络/结构异常（由调用方降级）。
 */
async function fetchReportRows(
  reportName: string,
  filter: string,
  sortColumns: string,
  sortTypes: string,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    reportName,
    columns: 'ALL',
    filter,
    sortColumns,
    sortTypes,
    pageSize: String(PAGE_SIZE),
    pageNumber: '1',
    source: 'WEB',
    client: 'WEB',
  });
  const url = `${DATA_CENTER_URL}?${params.toString()}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = (await response.json()) as {
    success?: boolean;
    message?: string;
    result?: { data?: unknown } | null;
  };
  const rows = json?.result?.data;
  if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  // 东财对「无数据」可能返回 success=true + result=null
  if (json?.success === true) return [];
  throw new Error(`东财 ${reportName} 返回结构异常：${json?.message ?? 'unknown'}`);
}

/** 对同一 (公告日) 的重复行去重，保留数值最大的一条（预案 → 实施的多次披露取最完整口径） */
function dedupeByDateKeepMax<T>(
  rows: T[],
  dateOf: (r: T) => string | null,
  valueOf: (r: T) => number | null,
): T[] {
  const best = new Map<string, { row: T; value: number }>();
  for (const r of rows) {
    const d = dateOf(r);
    if (!d) continue;
    const v = valueOf(r);
    const prev = best.get(d);
    if (!prev || (v !== null && v > prev.value)) best.set(d, { row: r, value: v ?? 0 });
  }
  return [...best.values()].map((e) => e.row);
}

// ---------------------------------------------------------------------------
// 分红送配
// ---------------------------------------------------------------------------

export interface DividendEventRow {
  /** 预案公告日（缺失时回落最新公告日） */
  announceDate: string | null;
  /** 除权除息日 */
  exDate: string | null;
  /** 每 10 股现金股利（税前，元） */
  per10Cash: number | null;
  /** 股息率（%，东财详情口径；常见缺失） */
  dividendYieldPct: number | null;
}

export async function fetchDividendEvents(code: string): Promise<DividendEventRow[]> {
  return withQuantCache(`event_div_${code}`, eventCacheTtlMs(), async () => {
    const rows = await fetchReportRows(
      'RPT_SHAREBONUS_DET',
      `(SECURITY_CODE="${code}")`,
      'PLAN_NOTICE_DATE',
      '-1',
    );
    const parsed = rows.map((row) => ({
      announceDate: normDate(row.PLAN_NOTICE_DATE) ?? normDate(row.NOTICE_DATE),
      exDate: normDate(row.EX_DIVIDEND_DATE),
      per10Cash: numOf(row, ['PRETAX_BONUS_RMB', 'BONUS_IT_RATIO', 'CASH_BONUS_RATIO']),
      dividendYieldPct: numOf(row, ['DIVIDENT_RATIO', 'DIVIDEND_RATIO', 'DIVIDEND_YIELD']),
    }));
    // 排除「不分配不转增」类空方案：无股利、无股息率的事件没有信号
    const withSignal = parsed.filter(
      (r) =>
        (r.per10Cash !== null && r.per10Cash > 0) ||
        (r.dividendYieldPct !== null && r.dividendYieldPct > 0),
    );
    return dedupeByDateKeepMax(
      withSignal,
      (r) => r.announceDate,
      (r) => r.dividendYieldPct ?? r.per10Cash,
    );
  });
}

// ---------------------------------------------------------------------------
// 股票回购
// ---------------------------------------------------------------------------

export interface BuybackEventRow {
  /** 最新公告日 */
  announceDate: string | null;
  /** 回购起始时间 */
  startDate: string | null;
  /** 占公告前一日总股本比例上限（%） */
  ratioHighPct: number | null;
  /** 计划回购金额上限（元） */
  amountHighYuan: number | null;
  /** 实施进度（含「停止实施」的方案不作为事件） */
  progress: string | null;
}

export async function fetchBuybackEvents(code: string): Promise<BuybackEventRow[]> {
  return withQuantCache(`event_buyback_${code}`, eventCacheTtlMs(), async () => {
    const rows = await fetchReportRows(
      'RPT_REPURCHASE_PLAN',
      `(SECURITY_CODE="${code}")`,
      'UPDATE_DATE',
      '-1',
    );
    const parsed = rows.map((row) => ({
      announceDate:
        normDate(row.UPDATE_DATE) ?? normDate(row.NOTICE_DATE) ?? normDate(row.PLAN_NOTICE_DATE),
      startDate: normDate(row.START_DATE),
      ratioHighPct: numOf(row, ['RATIO_HIGH', 'TOTAL_SHARE_RATIO', 'REPURCHASE_RATIO_HIGH']),
      amountHighYuan: numOf(row, ['REPURCHASE_AMOUNT_HIGH', 'AMOUNT_HIGH']),
      progress: strOf(row, ['PROGRESS', 'PROGRESS_TYPE', 'REPURCHASE_PROGRESS']),
    }));
    const valid = parsed.filter(
      (r) => r.announceDate !== null && r.progress !== null && !r.progress.includes('停止'),
    );
    return dedupeByDateKeepMax(
      valid,
      (r) => r.announceDate,
      (r) => r.ratioHighPct ?? r.amountHighYuan,
    );
  });
}

// ---------------------------------------------------------------------------
// 限售解禁
// ---------------------------------------------------------------------------

export interface UnlockEventRow {
  /** 解禁日 */
  freeDate: string | null;
  /** 占解禁前流通市值比例（%）。东财 FREE_RATIO 为 0-1 小数（样本含恰好 1.0 的全流通
   * 解禁），此处统一 ×100 转为百分比；>1.5 视为已是百分比，按原值保留 */
  ratioOfFloatPct: number | null;
  /** 解禁数量（股） */
  shares: number | null;
  /** 解禁市值（元） */
  marketCapYuan: number | null;
}

export async function fetchUnlockEvents(code: string): Promise<UnlockEventRow[]> {
  return withQuantCache(`event_unlock_${code}`, eventCacheTtlMs(), async () => {
    const rows = await fetchReportRows(
      'RPT_LIFT_STAGE',
      `(SECURITY_CODE="${code}")`,
      'FREE_DATE',
      '1',
    );
    const parsed = rows.map((row) => {
      const rawRatio = numOf(row, ['FREE_RATIO']);
      const ratioOfFloatPct =
        rawRatio === null
          ? null
          : Math.round((rawRatio <= 1.5 ? rawRatio * 100 : rawRatio) * 10000) / 10000;
      return {
        freeDate: normDate(row.FREE_DATE),
        ratioOfFloatPct,
        shares: numOf(row, ['CURRENT_FREE_SHARES', 'ABLE_FREE_SHARES']),
        marketCapYuan: numOf(row, ['LIFT_MARKET_CAP']),
      };
    });
    return parsed.filter(
      (r) => r.freeDate !== null && r.ratioOfFloatPct !== null && r.ratioOfFloatPct > 0,
    );
  });
}

// ---------------------------------------------------------------------------
// 单票三事件捆绑
// ---------------------------------------------------------------------------

export interface StockEventBundle {
  dividend: DividendEventRow[];
  buyback: BuybackEventRow[];
  unlock: UnlockEventRow[];
}

/**
 * 拉取单只股票的全部三类事件。任一类失败只降级该类为 []（不拖垮其余两类、
 * 不抛错）——事件族样本是否足够由截面评估如实披露，缺一类只是少一个因子。
 */
export async function fetchStockEvents(code: string): Promise<StockEventBundle> {
  const [dividend, buyback, unlock] = await Promise.all([
    fetchDividendEvents(code).catch((err) => {
      logger.warn('分红事件拉取失败，该股降级为无分红事件', { code, err });
      return [] as DividendEventRow[];
    }),
    fetchBuybackEvents(code).catch((err) => {
      logger.warn('回购事件拉取失败，该股降级为无回购事件', { code, err });
      return [] as BuybackEventRow[];
    }),
    fetchUnlockEvents(code).catch((err) => {
      logger.warn('解禁事件拉取失败，该股降级为无解禁事件', { code, err });
      return [] as UnlockEventRow[];
    }),
  ]);
  return { dividend, buyback, unlock };
}

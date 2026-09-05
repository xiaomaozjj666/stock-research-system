import logger from '../utils/logger.js';
import { withQuantCache } from './quantCache.js';

/**
 * 公司事件数据源（东方财富 datacenter）——分红送配 / 股票回购 / 限售解禁。
 *
 * 背景（2026-09-05）：事件因子此前只有业绩超预期（PEAD，由季度财报派生，
 * 不需要独立数据源）。分红/回购/解禁不在财报字段里，本模块接入东财三个
 * 免鉴权 datacenter 报表（与既有 push2his 同源体系、无新依赖）。
 *
 * **字段口径已用真实 API 响应逐一验证（2026-09-06 ground truth）**：
 *   - 分红送配：RPT_SHAREBONUS_DET，filter=(SECURITY_CODE="600519")。
 *     PRETAX_BONUS_RMB=每10股股利（元）；**DIVIDENT_RATIO=股息率，0-1 小数**
 *     （600519 十派280.2423 元 → 0.0231=2.31%；601088 十派9.8 → 0.0206=2.06%，
 *     两个真实样本交叉印证），此处统一 ×100 转百分比。
 *   - 股票回购：**RPTA_WEB_GETHGLIST_NEW**（此前猜的 RPT_REPURCHASE_PLAN
 *     报表不存在——东财返回 code 9501「报表配置不存在」），
 *     filter=(DIM_SCODE="600519")（该报表代码列是 DIM_SCODE，用 SECURITY_CODE
 *     过滤会报「列不存在」）。DIM_DATE=方案公告日（REMARK 与之互证）；
 *     REPURAMOUNTLIMIT/REPURAMOUNTLOWER=计划金额上下限（元）；
 *     AGSZBHXS=公告前一日流通A股市值（元，与 DIM_TRADEDATE=公告前一交易日 配对；
 *     实测三未信安 AGSZBHXS=11.97亿 vs ZSZ 总市值=53.70亿）——回购作用于
 *     自由流通盘，作分母在经济上更贴切；
 *     ZJSZBL=计划数量中值占总股本比例（%，按数量规划的方案才有，按金额的为 null）；
 *     REPURPROGRESS=进度码（004 实施中 / 006 完成实施 / 007 停止实施——
 *     007 的真实样本 REPURAMOUNT 全为 null，即公告后从未实施）。
 *     **不按进度过滤**：方案公告本身就是事件，事后停止不改变公告日的新闻效应。
 *   - 无数据的标准响应：success=false + code 9201 + message「返回数据为空」
 *     （如 600519 无解禁记录）→ 合法空结果，不抛错。
 *   - 限售解禁：RPT_LIFT_STAGE，filter=(SECURITY_CODE="688489")。
 *     FREE_DATE=解禁日；**FREE_RATIO=占解禁前流通市值比例，0-1 小数**
 *     （三未信安全流通解禁恰为 1.0），×100 转百分比；
 *     CURRENT_FREE_SHARES 单位为**万股**、LIFT_MARKET_CAP 单位为**万元**。
 *
 * 缓存：事件为低频追加数据（历史不重写），按 code 缓存全量事件列表，
 * TTL 默认 24h（QUANT_EVENT_CACHE_TTL_HOURS，显式 0 = 关闭）。
 * key 不含日期区间——避免重蹈 K 线滚动窗口缓存每日全失效的覆辙。
 */

const DATA_CENTER_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const PAGE_SIZE = 500; // 单票事件远不足 500 行；超出部分忽略（如实记录在代码口径）

/** 比例字段统一换算：0-1 小数 → 百分比（保留 4 位小数，即 0.01% 精度） */
function fractionToPct(raw: number): number {
  return Math.round(raw * 100 * 10000) / 10000;
}

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
    code?: number;
    result?: { data?: unknown } | null;
  };
  const rows = json?.result?.data;
  if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  // 东财对「无数据」的标准响应（实测：600519 无解禁记录）：success=false + code 9201
  // + message「返回数据为空」——这是合法空结果，不是异常（当作异常会把大量无解禁/
  // 无回购的股票刷成误导性 warn）
  if (json?.success === true) return [];
  if (
    json?.code === 9201 ||
    (typeof json?.message === 'string' && json.message.includes('返回数据为空'))
  ) {
    return [];
  }
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
    const parsed = rows.map((row) => {
      const rawYield = numOf(row, ['DIVIDENT_RATIO']); // 已验证：0-1 小数（非百分比）
      return {
        announceDate: normDate(row.PLAN_NOTICE_DATE) ?? normDate(row.NOTICE_DATE),
        exDate: normDate(row.EX_DIVIDEND_DATE),
        per10Cash: numOf(row, ['PRETAX_BONUS_RMB']),
        dividendYieldPct: rawYield === null ? null : fractionToPct(rawYield),
      };
    });
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
  /** 方案公告日（DIM_DATE=首次公告，即新闻时刻；缺失回落最新公告日 NOTICEDATE） */
  announceDate: string | null;
  /** 回购起始时间（REPURSTARTDATE） */
  startDate: string | null;
  /** 计划回购金额上限（元，REPURAMOUNTLIMIT） */
  planAmountHighYuan: number | null;
  /**
   * 公告前一日流通A股市值（元，AGSZBHXS；缺失回落最新总市值 ZSZ）。
   * 实测口径为**流通市值**而非总市值（三未信安 2023-12：AGSZBHXS=11.97亿 vs
   * ZSZ=53.70亿）——回购作用于自由流通盘，作分母在经济上更贴切。
   */
  preAnnounceCapYuan: number | null;
  /** 计划回购数量中值占总股本比例（%，ZJSZBL；按金额规划的方案常为 null） */
  planRatioMidPct: number | null;
  /**
   * 实施进度码（东财原始码：004=实施中、006=完成实施、007=停止实施等）。
   * **不按进度过滤**：方案公告本身就是事件，事后停止不改变公告日的新闻效应。
   */
  progress: string | null;
}

export async function fetchBuybackEvents(code: string): Promise<BuybackEventRow[]> {
  return withQuantCache(`event_buyback_${code}`, eventCacheTtlMs(), async () => {
    const rows = await fetchReportRows(
      'RPTA_WEB_GETHGLIST_NEW',
      `(DIM_SCODE="${code}")`,
      'UPD,DIM_DATE,DIM_SCODE',
      '-1,-1,-1',
    );
    const parsed = rows.map((row) => ({
      announceDate: normDate(row.DIM_DATE) ?? normDate(row.NOTICEDATE) ?? normDate(row.UPDATEDATE),
      startDate: normDate(row.REPURSTARTDATE),
      planAmountHighYuan: numOf(row, ['REPURAMOUNTLIMIT', 'REPURAMOUNTLOWER']),
      preAnnounceCapYuan: numOf(row, ['AGSZBHXS', 'ZSZ']),
      planRatioMidPct: numOf(row, ['ZJSZBL']),
      progress: strOf(row, ['REPURPROGRESS']),
    }));
    return dedupeByDateKeepMax(
      parsed.filter((r) => r.announceDate !== null),
      (r) => r.announceDate,
      (r) => r.planAmountHighYuan ?? r.planRatioMidPct,
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
  /** 解禁数量（万股，CURRENT_FREE_SHARES 东财原始单位） */
  sharesWan: number | null;
  /** 解禁市值（万元，LIFT_MARKET_CAP 东财原始单位） */
  marketCapWan: number | null;
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
        sharesWan: numOf(row, ['CURRENT_FREE_SHARES', 'ABLE_FREE_SHARES']),
        marketCapWan: numOf(row, ['LIFT_MARKET_CAP']),
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

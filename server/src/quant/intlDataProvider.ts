/**
 * 港美股财务估值数据源
 *
 * 设计目标：
 * - 补齐 dataProvider.ts（仅支持 A 股财务估值）的港美股缺口
 * - 不硬依赖 AKShare npm 包，直接用 Node.js 内置 fetch 调用东方财富数据中心 RPT 网关
 *   （免费、无 token；即 AKShare stock_hk_financial_abstract_em / stock_us_... 底层调用的同一组 HTTP 端点）
 * - 所有网络请求带 10s 超时；失败降级为 fundamentals=null + degraded=true，绝不抛异常
 *
 * 数据源（替代原 http://push2.eastmoney.com——本环境 Node fetch 对该域名的 HTTP 明文请求必 TLS 失败）：
 * - 港股：RPT_HKF10_FN_MAININDICATOR（主要财务指标，按报告期倒序取最新一期，一次取齐
 *         PE/PB/市值/营收/净利/资产负债/名称） + RPT_HKF10_INFO_SECURITYINFO（证券资料，名称兜底）
 * - 美股：RPT_USF10_INFO_ORGPROFILE（公司概况，先用 SECURITY_CODE 查 SECUCODE，如 TSLA → TSLA.O）
 *         + RPT_USF10_FN_GMAININDICATOR（主要财务指标，补营收/净利/名称）。
 *         数据中心 RPT 网关未提供美股 PE/PB/市值/资产负债等估值快照，故美股该部分字段归零，
 *         调用方需知悉（港股字段完整）。
 *
 * 字段量纲（与 A 股 dataFetcher.ts 保持一致）：
 * - 市值/营收/净利/资产字段以"元"（本币）计，需 /1e8 转亿元
 * - PE/PB 等比率字段为无量纲数值，直接四舍五入
 */

import logger from '../utils/logger.js';

/** 港美股市场标识 */
export type IntlMarket = 'HK' | 'US';

/** 港美股基础财务估值快照 */
export interface IntlStockFundamentals {
  /** 证券代码（港股 5 位数字 / 美股字母） */
  code: string;
  /** 市场标识 */
  market: IntlMarket;
  /** 证券名称 */
  name: string;
  /** 市盈率 TTM */
  pe: number;
  /** 市净率 */
  pb: number;
  /** 总市值（亿元，按本币计） */
  marketCap: number;
  /** 营业收入（亿元） */
  revenue: number;
  /** 净利润（亿元） */
  netIncome: number;
  /** 总资产（亿元） */
  totalAssets: number;
  /** 总负债（亿元） */
  totalLiabilities: number;
  /** 计价货币：HK = HKD，US = USD */
  currency: string;
  /** 数据源标识 */
  dataSource: string;
}

/** 港美股财务估值获取结果（含降级标记） */
export interface IntlFundamentalsResult {
  /** 财务估值快照；失败时为 null */
  fundamentals: IntlStockFundamentals | null;
  /** 是否处于降级状态（API 失败或解析失败） */
  degraded: boolean;
  /** 数据源描述（成功=eastmoney-datacenter，降级=none） */
  source: string;
  /** 抓取时间 ISO 字符串 */
  fetchedAt: string;
}

/** 单次网络请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 10_000;

/** 东方财富数据中心 RPT 网关（免费、无 token） */
const EM_DATACENTER_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';

/** RPT 报表名 */
const HK_MAIN_INDICATOR = 'RPT_HKF10_FN_MAININDICATOR';
const HK_SECURITY_INFO = 'RPT_HKF10_INFO_SECURITYINFO';
const US_ORG_PROFILE = 'RPT_USF10_INFO_ORGPROFILE';
const US_MAIN_INDICATOR = 'RPT_USF10_FN_GMAININDICATOR';

/** 港股默认计价货币 */
const HK_CURRENCY = 'HKD';
/** 美股默认计价货币 */
const US_CURRENCY = 'USD';

/** 数据源标识 */
const DATA_SOURCE = 'eastmoney-datacenter';

/** 单批次最大并发数，避免触发对端限流 */
const BATCH_CONCURRENCY = 5;

/**
 * 根据证券代码格式判断市场。
 * - 5 位纯数字 → HK
 * - 字母（1-6 位，大小写不敏感）→ US
 * - 6 位纯数字 → A 股（不属于港美股，但仍返回该值便于调用方分流）
 * - 其它未知格式 → 回退到 A 股
 */
export function detectMarket(code: string): 'HK' | 'US' | 'A' {
  const c = code.trim();
  if (/^\d{5}$/.test(c)) return 'HK';
  if (/^[A-Za-z]{1,6}$/.test(c)) return 'US';
  return 'A';
}

/**
 * 把港美股代码格式化为东方财富 secid。
 * - HK: 5 位数字 → 116.{code}
 * - US: 字母 → 107.{CODE}（强制大写，与 dataProvider.resolveSecid 一致）
 * 注：RPT 网关改用 SECUCODE（如 00700.HK / TSLA.O）寻址，本函数保留供调用方做代码规范化。
 */
export function formatIntlCode(code: string, market: IntlMarket): string {
  const c = code.trim();
  if (market === 'HK') return `116.${c}`;
  return `107.${c.toUpperCase()}`;
}

/** 安全转数字；缺失 / "-" / NaN 归零（与 dataFetcher.toNum 同语义） */
function toNum(v: unknown): number {
  if (v === null || v === undefined || v === '-') return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/** 元 → 亿元（保留 2 位小数；与 dataFetcher.yuanToYi 同语义） */
function yuanToYi(v: unknown): number {
  const n = toNum(v);
  if (n === 0) return 0;
  return Math.round((n / 1e8) * 100) / 100;
}

/** 保留 2 位小数（比率类字段） */
function round2(v: unknown): number {
  return Math.round(toNum(v) * 100) / 100;
}

/** 字符串安全取值并 trim */
function str(v: unknown): string {
  return String(v ?? '').trim();
}

/** 带超时的 fetch JSON；HTTP 非 2xx 抛错 */
async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  return resp.json();
}

/**
 * 构造东方财富数据中心 RPT 网关请求 URL。
 * - filter 形如 (SECUCODE="00700.HK")，整体 URL 编码
 * - sortByDate 按 STD_REPORT_DATE 倒序，用于取最新一期财务指标
 */
function buildDatacenterUrl(
  reportName: string,
  filter: string,
  opts: { sortByDate?: boolean } = {},
): string {
  const sort = opts.sortByDate ? '&sortColumns=STD_REPORT_DATE&sortTypes=-1' : '';
  return `${EM_DATACENTER_URL}?reportName=${reportName}&columns=ALL&filter=${encodeURIComponent(filter)}&pageNumber=1&pageSize=1${sort}&source=F10&client=PC`;
}

/** 从 RPT 网关响应中提取第一条记录；空 / 失败返回 null */
function firstRow(raw: unknown): Record<string, unknown> | null {
  const result = (raw as { result?: { data?: Array<Record<string, unknown>> | null } } | null)
    ?.result;
  const data = result?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

/** 抓取 RPT 报表最新一期记录（按报告期倒序） */
async function fetchLatestIndicator(
  reportName: string,
  filter: string,
): Promise<Record<string, unknown> | null> {
  const url = buildDatacenterUrl(reportName, filter, { sortByDate: true });
  return firstRow(await fetchJsonWithTimeout(url));
}

/** 抓取 RPT 报表第一条记录（通常为唯一一条） */
async function fetchFirstRow(
  reportName: string,
  filter: string,
): Promise<Record<string, unknown> | null> {
  const url = buildDatacenterUrl(reportName, filter);
  return firstRow(await fetchJsonWithTimeout(url));
}

/** 构造降级结果（统一日志 + 返回结构） */
function degradedResult(
  code: string,
  market: IntlMarket,
  fetchedAt: string,
  reason: string,
): IntlFundamentalsResult {
  // 降级仅打 warn，不抛异常；调用方按 degraded 字段分流
  logger.warn('[intlDataProvider] 数据降级', { market, code, reason });
  return {
    fundamentals: null,
    degraded: true,
    source: 'none',
    fetchedAt,
  };
}

/** 成功结果（统一结构） */
function okResult(
  fundamentals: IntlStockFundamentals,
  fetchedAt: string,
): IntlFundamentalsResult {
  return {
    fundamentals,
    degraded: false,
    source: DATA_SOURCE,
    fetchedAt,
  };
}

/** 港股 RPT 主要指标行 → 财务估值快照（字段全部由数据中心提供） */
function hkFundamentals(
  row: Record<string, unknown>,
  name: string,
  code: string,
): IntlStockFundamentals {
  return {
    code: str(row.SECURITY_CODE) || code,
    market: 'HK',
    name,
    pe: round2(row.PE_TTM),
    pb: round2(row.PB_TTM),
    marketCap: yuanToYi(row.TOTAL_MARKET_CAP),
    revenue: yuanToYi(row.OPERATE_INCOME),
    netIncome: yuanToYi(row.HOLDER_PROFIT),
    totalAssets: yuanToYi(row.TOTAL_ASSETS),
    totalLiabilities: yuanToYi(row.TOTAL_LIABILITIES),
    currency: str(row.CURRENCY) || HK_CURRENCY,
    dataSource: DATA_SOURCE,
  };
}

/** 美股 RPT 主要指标行 → 财务估值快照（数据中心未提供 PE/PB/市值/资产负债，归零） */
function usFundamentals(
  row: Record<string, unknown>,
  name: string,
  code: string,
): IntlStockFundamentals {
  return {
    code: str(row.SECURITY_CODE) || code,
    market: 'US',
    name,
    pe: 0,
    pb: 0,
    marketCap: 0,
    revenue: yuanToYi(row.OPERATE_INCOME),
    netIncome: yuanToYi(row.PARENT_HOLDER_NETPROFIT),
    totalAssets: 0,
    totalLiabilities: 0,
    currency: str(row.CURRENCY_ABBR) || US_CURRENCY,
    dataSource: DATA_SOURCE,
  };
}

/** 港股抓取路径：RPT_HKF10_FN_MAININDICATOR 为主，名称兜底走 RPT_HKF10_INFO_SECURITYINFO */
async function fetchHkFundamentals(
  code: string,
  fetchedAt: string,
): Promise<IntlFundamentalsResult> {
  const secuCode = `${code}.HK`;

  // 主要财务指标：按报告期倒序取最新一期，一次取齐估值与三大报表金额
  const row = await fetchLatestIndicator(HK_MAIN_INDICATOR, `(SECUCODE="${secuCode}")`);
  if (!row) {
    return degradedResult(code, 'HK', fetchedAt, 'eastmoney 返回空 RPT 数据');
  }

  // 名称兜底：主要指标缺名称时回查证券资料
  let name = str(row.SECURITY_NAME_ABBR);
  if (!name) {
    const info = await fetchFirstRow(HK_SECURITY_INFO, `(SECUCODE="${secuCode}")`);
    name = str(info?.SECURITY_NAME_ABBR);
  }
  if (!name) {
    return degradedResult(code, 'HK', fetchedAt, 'eastmoney 返回空名称');
  }

  return okResult(hkFundamentals(row, name, code), fetchedAt);
}

/** 美股抓取路径：ORGPROFILE 查 SECUCODE + 名称，GMAININDICATOR 补营收/净利 */
async function fetchUsFundamentals(
  code: string,
  fetchedAt: string,
): Promise<IntlFundamentalsResult> {
  // 1. 先用 SECURITY_CODE 查 SECUCODE + 名称（TSLA → TSLA.O）
  const profile = await fetchFirstRow(US_ORG_PROFILE, `(SECURITY_CODE="${code}")`);
  if (!profile) {
    return degradedResult(code, 'US', fetchedAt, 'eastmoney 返回空 RPT 数据');
  }

  const name = str(profile.SECURITY_NAME_ABBR);
  if (!name) {
    return degradedResult(code, 'US', fetchedAt, 'eastmoney 返回空名称');
  }

  // 2. 主要财务指标：补营收/净利。名称已由 ORGPROFILE 拿到，指标失败不整体降级，仅相关字段归零
  let row: Record<string, unknown> | null = null;
  try {
    row = await fetchLatestIndicator(
      US_MAIN_INDICATOR,
      `(SECUCODE="${str(profile.SECUCODE)}")`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('[intlDataProvider] 美股主要指标失败，仅填充名称', { code, reason });
  }

  const merged: Record<string, unknown> = row
    ? { ...row, SECURITY_NAME_ABBR: name }
    : {
        SECURITY_CODE: str(profile.SECURITY_CODE) || code,
        SECURITY_NAME_ABBR: name,
        OPERATE_INCOME: 0,
        PARENT_HOLDER_NETPROFIT: 0,
        CURRENCY_ABBR: US_CURRENCY,
      };

  return okResult(usFundamentals(merged, name, code), fetchedAt);
}

/**
 * 抓取单只港美股财务估值。
 * - 港股走 MAININDICATOR + SECURITYINFO，美股走 ORGPROFILE + GMAININDICATOR（东财数据中心 RPT 网关）
 * - 任何异常（网络/超时/解析/空数据）均降级为 fundamentals=null + degraded=true
 */
export async function fetchIntlFundamentals(
  code: string,
  market: IntlMarket,
): Promise<IntlFundamentalsResult> {
  const fetchedAt = new Date().toISOString();
  const trimmedCode = code.trim();

  try {
    return market === 'HK'
      ? await fetchHkFundamentals(trimmedCode, fetchedAt)
      : await fetchUsFundamentals(trimmedCode, fetchedAt);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return degradedResult(trimmedCode, market, fetchedAt, reason);
  }
}

/**
 * 批量获取港美股财务估值。
 * - 自动按 detectMarket 分流；A 股代码不发起网络请求，直接返回降级结果
 * - 控制并发为 BATCH_CONCURRENCY，避免触发对端限流
 * - 单只失败不影响其余，逐项返回降级结果
 */
export async function fetchBatchFundamentals(
  codes: string[],
): Promise<IntlFundamentalsResult[]> {
  const results: IntlFundamentalsResult[] = [];

  for (let i = 0; i < codes.length; i += BATCH_CONCURRENCY) {
    const slice = codes.slice(i, i + BATCH_CONCURRENCY);
    const batch = await Promise.all(
      slice.map((code) => {
        const market = detectMarket(code);
        if (market === 'A') {
          // 非港美股代码：直接降级，不发起网络请求
          return Promise.resolve<IntlFundamentalsResult>({
            fundamentals: null,
            degraded: true,
            source: 'none',
            fetchedAt: new Date().toISOString(),
          });
        }
        return fetchIntlFundamentals(code, market);
      }),
    );
    results.push(...batch);
  }

  return results;
}

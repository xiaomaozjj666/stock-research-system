/**
 * 港美股财务估值数据源
 *
 * 设计目标：
 * - 补齐 dataProvider.ts（仅支持 A 股财务估值）的港美股缺口
 * - 不硬依赖 AKShare npm 包，直接用 Node.js 内置 fetch 调用东方财富 push2 行情接口
 *   （即 AKShare stock_hk_spot_em / stock_us_spot_em 底层调用的同一组 HTTP 端点）
 * - 所有网络请求带 10s 超时；失败降级为 fundamentals=null + degraded=true，绝不抛异常
 *
 * 字段量纲（与 A 股 dataFetcher.ts 保持一致）：
 * - 价格字段（f43/f60）以"分"计，需 /100
 * - 市值/营收/净利/资产字段（f116/f173/f187/f193/f184）以"元"计，需 /1e8 转亿元
 * - PE/PB 等比率字段为无量纲数值，直接四舍五入
 */

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
  /** 数据源描述（成功=eastmoney-push2，降级=none） */
  source: string;
  /** 抓取时间 ISO 字符串 */
  fetchedAt: string;
}

/** 单次网络请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 10_000;

/** 东方财富 push2 单只股票详情接口（与 A 股 dataFetcher 同源） */
const EM_PUSH2_STOCK_URL = 'http://push2.eastmoney.com/api/qt/stock/get';

/** 东方财富固定 ut token（与 A 股 dataFetcher 一致） */
const EM_UT = 'fa5fd1943c7b386f172d6893dbbd1';

/** 港股默认计价货币 */
const HK_CURRENCY = 'HKD';
/** 美股默认计价货币 */
const US_CURRENCY = 'USD';

/** 数据源标识 */
const DATA_SOURCE = 'eastmoney-push2';

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

/** 带超时的 fetch JSON；HTTP 非 2xx 抛错 */
async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  return resp.json();
}

/** 构造东方财富单只港美股详情请求 URL */
function buildPush2Url(secid: string): string {
  // 字段说明（与 A 股 push2 接口字段同语义）：
  // f57=代码  f58=名称
  // f116=总市值(元)  f117=流通市值(元)
  // f162=PE(动)  f163=PE(TTM)  f164=PB(MRQ)
  // f173=营业收入(元)  f184=总负债(元)  f187=净利润(元)  f193=总资产(元)
  const fields = 'f57,f58,f116,f117,f162,f163,f164,f173,f184,f187,f193';
  return `${EM_PUSH2_STOCK_URL}?secid=${secid}&fields=${fields}&ut=${EM_UT}`;
}

/** 构造降级结果（统一日志 + 返回结构） */
function degradedResult(
  code: string,
  market: IntlMarket,
  fetchedAt: string,
  reason: string,
): IntlFundamentalsResult {
  // 降级仅打 warn，不抛异常；调用方按 degraded 字段分流
  console.warn(`[intlDataProvider] ${market}.${code} 降级：${reason}`);
  return {
    fundamentals: null,
    degraded: true,
    source: 'none',
    fetchedAt,
  };
}

/**
 * 抓取单只港美股财务估值。
 * - 优先调用东方财富 push2 行情接口（AKShare stock_hk_spot_em / stock_us_spot_em 的 HTTP 等价物）
 * - 任何异常（网络/超时/解析/空数据）均降级为 fundamentals=null + degraded=true
 */
export async function fetchIntlFundamentals(
  code: string,
  market: IntlMarket,
): Promise<IntlFundamentalsResult> {
  const fetchedAt = new Date().toISOString();
  const trimmedCode = code.trim();

  try {
    const secid = formatIntlCode(trimmedCode, market);
    const url = buildPush2Url(secid);
    const raw = (await fetchJsonWithTimeout(url)) as {
      data?: Record<string, unknown>;
    } | null;

    const d = raw?.data;
    if (!d) {
      return degradedResult(trimmedCode, market, fetchedAt, 'eastmoney 返回空 data');
    }

    const name = String(d.f58 ?? '').trim();
    if (!name) {
      return degradedResult(trimmedCode, market, fetchedAt, 'eastmoney 返回空名称');
    }

    // PE 优先取 TTM(f163)，缺失则回退到动态 PE(f162)
    const peRaw = toNum(d.f163) || toNum(d.f162);

    const fundamentals: IntlStockFundamentals = {
      code: String(d.f57 ?? trimmedCode),
      market,
      name,
      pe: Math.round(peRaw * 100) / 100,
      pb: Math.round(toNum(d.f164) * 100) / 100,
      marketCap: yuanToYi(d.f116),
      revenue: yuanToYi(d.f173),
      netIncome: yuanToYi(d.f187),
      totalAssets: yuanToYi(d.f193),
      totalLiabilities: yuanToYi(d.f184),
      currency: market === 'HK' ? HK_CURRENCY : US_CURRENCY,
      dataSource: DATA_SOURCE,
    };

    return {
      fundamentals,
      degraded: false,
      source: DATA_SOURCE,
      fetchedAt,
    };
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

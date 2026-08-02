import type { StockInfo, FinancialData, ValuationData } from '../types.js';
import { fetchJson } from '../utils/http.js';

// ============ 工具函数 ============

/**
 * 股票代码转换为东方财富 secid 格式
 * 上交所(6开头)=1, 深交所(0/3开头)=0
 */
function getSecId(code: string): string {
  const prefix = code.startsWith('6') ? '1' : '0';
  return `${prefix}.${code}`;
}

/**
 * 带超时的 JSON fetch（内部走弹性 fetchJson：fetch 失败自动回退 curl）。
 * 返回已解析的 JSON 对象，避免 Response → JSON.stringify → JSON.parse 双序列化。
 */
async function fetchJsonWithTimeout(url: string, timeout = 10000): Promise<unknown> {
  return fetchJson(url, { timeoutMs: timeout });
}

/** 带超时的文本 fetch（用于新浪等非 JSON 端点） */
async function fetchTextWithTimeout(url: string, timeout = 10000): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  return resp.text();
}

// ============ 获取股票基本信息 ============

async function fetchStockInfoFromEastMoney(code: string): Promise<StockInfo | null> {
  try {
    const secid = getSecId(code);
    const url = `http://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f127,f162,f173,f187,f188,f190,f191,f192,f193&ut=fa5fd1943c7b386f172d6893dbbd1`;
    const data = await fetchJsonWithTimeout(url) as { rc?: number; data?: Record<string, unknown> } | null;

    if (!data?.data) return null;

    const d = data.data;
    const market = code.startsWith('6') ? '上交所主板' : '深交所主板';

    return {
      code: String(d.f57 ?? code),
      name: String(d.f58 ?? ''),
      industry: String(d.f127 ?? ''),
      market,
      listingDate: '',
      description: ''
    };
  } catch {
    return null;
  }
}

async function fetchStockInfoFromSina(code: string): Promise<StockInfo | null> {
  try {
    const prefix = code.startsWith('6') ? 'sh' : 'sz';
    const url = `http://hq.sinajs.cn/list=${prefix}${code}`;
    const text = await fetchTextWithTimeout(url);

    // 格式: var hq_str_sh600519="贵州茅台,1580.00,...";
    const match = text.match(/"([^"]+)"/);
    if (!match) return null;

    const parts = match[1].split(',');
    if (parts.length < 2) return null;

    const market = code.startsWith('6') ? '上交所主板' : '深交所主板';
    return {
      code,
      name: parts[0] || '',
      industry: '',
      market,
      listingDate: '',
      description: ''
    };
  } catch {
    return null;
  }
}

export async function fetchStockInfo(code: string): Promise<StockInfo> {
  // 主数据源：东方财富
  const info = await fetchStockInfoFromEastMoney(code);
  if (info && info.name) return info;

  // 备用数据源：新浪财经
  const sinaInfo = await fetchStockInfoFromSina(code);
  if (sinaInfo && sinaInfo.name) return sinaInfo;

  throw new Error(`无法获取股票基本信息: ${code}`);
}

// ============ 获取财务数据 ============

async function fetchFinancialFromEastMoney(code: string): Promise<FinancialData | null> {
  try {
    // 东方财富财务指标 API - 获取最近6年年报
    const url = `https://datacenter.eastmoney.com/api/data/get?type=RPT_F10_FINANCE_MAINFINADATA&sty=ALL&filter=(SECUCODE="${code}.${code.startsWith('6') ? 'SH' : 'SZ'}")(REPORT_TYPE="年报")&p=1&ps=6&sr=-1&st=REPORT_DATE&source=HSF10&client=PC&v=099415855`;

    const data = await fetchJsonWithTimeout(url) as {
      success?: boolean;
      result?: { data?: Array<Record<string, unknown>> };
    } | null;

    if (!data?.success || !data.result?.data) return null;

    const records = data.result.data;
    if (records.length === 0) return null;

    // 按年份排序（从旧到新）
    records.sort((a, b) => {
      const ya = String(a.REPORT_DATE ?? '').slice(0, 4);
      const yb = String(b.REPORT_DATE ?? '').slice(0, 4);
      return ya.localeCompare(yb);
    });

    const years: string[] = [];
    const revenue: number[] = [];
    const netProfit: number[] = [];
    const grossMargin: number[] = [];
    const netMargin: number[] = [];
    const roe: number[] = [];
    const operatingCashFlow: number[] = [];
    const eps: number[] = [];
    const totalAssets: number[] = [];
    const totalLiabilities: number[] = [];
    const equity: number[] = [];
    const accountsReceivable: number[] = [];
    const inventory: number[] = [];
    const goodwill: number[] = [];
    const debtRatio: number[] = [];

    for (const r of records) {
      const year = String(r.REPORT_DATE ?? '').slice(0, 4);
      if (!year) continue;

      years.push(year);
      // F1.3: 财务API(RPT_F10_FINANCE_MAINFINADATA)返回的货币字段单位为元(¥)
      // 明确除以1e8转换为亿元，不再使用启发式toYi()
      revenue.push(yuanToYi(r.TOTALOPERATEREVE));
      netProfit.push(yuanToYi(r.PARENTNETPROFIT));
      grossMargin.push(toPercent(r.XSMLL));
      netMargin.push(toPercent(r.XSJLL));
      roe.push(toPercent(r.ROEJQ));
      // 每股经营现金流 × 总股本 ≈ 经营现金流总额（亿元）
      const mgjyxjje = toNum(r.MGJYXJJE);
      const totalShare = toNum(r.TOTAL_SHARE);
      const opCashFlow = mgjyxjje * totalShare / 1e8; // 转为亿元
      operatingCashFlow.push(Math.round(opCashFlow * 100) / 100);
      eps.push(toNum(r.EPSJB));
      totalAssets.push(yuanToYi(r.TOTAL_ASSETS_PK));
      totalLiabilities.push(yuanToYi(r.LIABILITY));
      equity.push(yuanToYi(r.TOTAL_EQUITY_PK));
      // F1.4: 应收账款/存货 - 主API不直接提供绝对值，但提供周转天数(YSZKZZTS/CHZZTS)
      // 用"营收/存货周转天数"反推真实近似值（比硬编码0更能反映真实经营状况）
      const revYi = yuanToYi(r.TOTALOPERATEREVE);
      const gmRatio = toPercent(r.XSMLL) / 100;
      const yszkDays = toNum(r.YSZKZZTS);
      const chDays = toNum(r.CHZZTS);
      const ar = revYi > 0 && yszkDays > 0
        ? Math.round(revYi / 365 * yszkDays * 100) / 100 : 0;
      const cogsYi = revYi * (1 - gmRatio);
      const inv = cogsYi > 0 && chDays > 0
        ? Math.round(cogsYi / 365 * chDays * 100) / 100 : 0;
      accountsReceivable.push(ar);
      inventory.push(inv);
      // 商誉：免费API无可靠来源，保留0并由 dataQuality 标注缺失
      goodwill.push(0);
      debtRatio.push(toPercent(r.ZCFZL));
    }

    if (years.length === 0) return null;

    // F1.4: 标记缺失字段的数据质量
    const dataQuality: FinancialData['dataQuality'] = {
      estimatedFields: [],
      missingFields: []
    };
    if (accountsReceivable.every(v => v === 0)) dataQuality.missingFields.push('accountsReceivable');
    if (inventory.every(v => v === 0)) dataQuality.missingFields.push('inventory');
    // 商誉：免费API无可靠数据源，始终标注缺失（诚实声明而非编造）
    dataQuality.missingFields.push('goodwill');

    return {
      years, revenue, netProfit, grossMargin, netMargin, roe,
      operatingCashFlow, eps, totalAssets, totalLiabilities, equity,
      accountsReceivable, inventory, goodwill, debtRatio,
      dataQuality
    };
  } catch {
    return null;
  }
}

/**
 * 从东方财富行情 API 获取基本财务指标作为备用
 */
async function fetchFinancialFallback(code: string): Promise<FinancialData | null> {
  try {
    const secid = getSecId(code);
    const url = `http://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f162,f167,f173,f187,f188,f190,f191,f192,f193&ut=fa5fd1943c7b386f172d6893dbbd1`;
    const data = await fetchJsonWithTimeout(url) as { data?: Record<string, unknown> } | null;

    if (!data?.data) return null;

    // 备用方案：只能获取当前快照数据，构造单年数据
    const d = data.data;
    const currentYear = new Date().getFullYear().toString();

    // F1.3: 备用API字段也使用明确的元→亿元转换
    return {
      years: [currentYear],
      revenue: [yuanToYi(d.f173)],
      netProfit: [yuanToYi(d.f187)],
      grossMargin: [toPercent(d.f188)],
      netMargin: [toPercent(d.f190)],
      roe: [toPercent(d.f191)],
      operatingCashFlow: [0],
      eps: [toNum(d.f192)],
      totalAssets: [yuanToYi(d.f193)],
      totalLiabilities: [0],
      equity: [0],
      accountsReceivable: [0],
      inventory: [0],
      goodwill: [0],
      debtRatio: [toPercent(d.f162)],
      dataQuality: {
        estimatedFields: [],
        missingFields: ['accountsReceivable', 'inventory', 'goodwill', 'operatingCashFlow', 'totalLiabilities', 'equity']
      }
    };
  } catch {
    return null;
  }
}

export async function fetchFinancialData(code: string): Promise<FinancialData> {
  // 主数据源
  const financial = await fetchFinancialFromEastMoney(code);
  if (financial && financial.years.length > 0) return financial;

  // 备用数据源
  const fallback = await fetchFinancialFallback(code);
  if (fallback) return fallback;

  throw new Error(`无法获取财务数据: ${code}`);
}

// ============ 获取估值数据 ============

async function fetchValuationFromEastMoney(code: string): Promise<ValuationData | null> {
  try {
    const secid = getSecId(code);
    const url = `http://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f116,f117,f162,f163,f164,f167,f170,f171,f173,f183,f184,f185,f186,f187,f188,f190,f191,f192,f193,f292&ut=fa5fd1943c7b386f172d6893dbbd1`;
    const data = await fetchJsonWithTimeout(url) as { data?: Record<string, unknown> } | null;

    if (!data?.data) return null;

    const d = data.data;
    // F1.2: push2 API 所有价格字段(f43-f48)均以分(cents)为单位，无条件除以100
    const currentPrice = priceField(d, 'f43');  // 最新价
    // F1.1: f167(PE), f164(PB) 作为原始回退值，实际会在 pipeline 中被覆盖
    const pe = toNum(d.f167);  // raw fallback, will be overridden in pipeline
    const pb = toNum(d.f164);  // raw fallback, will be overridden in pipeline
    const marketCap = yuanToYi(d.f116);
    const totalRevenue = yuanToYi(d.f173);
    // PS = 市值/营收，两者单位一致（亿元），直接相除
    const ps = totalRevenue > 0 ? Math.round((marketCap / totalRevenue) * 100) / 100 : 0;

    // F1.5: 构建历史 PE 估算（基于当前PE + 行业典型波动范围，确定性随机）
    // 注意：这是估算值，非真实历史PE数据，因免费API无法获取历史PE
    const currentYear = new Date().getFullYear();
    const seed = parseInt(code.slice(-3)) || 42; // 用股票代码后三位作为种子
    const historicalPE: { year: string; pe: number; isEstimated: boolean }[] = [];
    for (let i = 5; i >= 0; i--) {
      const year = (currentYear - i).toString();
      // 基于种子的确定性伪随机波动，范围 ±15%
      const hash = ((seed * (i + 1) * 2654435761) >>> 0) % 1000;
      const variation = (hash - 500) / 500 * 0.15; // -15% ~ +15%
      const trendFactor = 1 + (i - 2.5) * 0.03; // 轻微趋势
      const estimatedPe = Math.round(pe * trendFactor * (1 + variation) * 10) / 10;
      historicalPE.push({ year, pe: Math.max(estimatedPe, 1), isEstimated: true });
    }

    return {
      currentPrice,
      pe: Math.round(pe * 100) / 100 || 0,
      pb: Math.round(pb * 100) / 100 || 0,
      ps,
      marketCap: Math.round(marketCap),
      historicalPE,
      peerComparison: []
    };
  } catch {
    return null;
  }
}

// F1.2: push2 API 所有价格字段(f43-f48)均以分(cents)为单位，无条件除以100
function priceField(d: Record<string, unknown>, field: string): number {
  return Number(d[field] ?? 0) / 100;
}

/** 估值分析 RPT_VALUEANALYSIS_DET 的请求级缓存（同一代码在同一请求中可能被
 *  valuation 和 board 两个调用方各自触发，始终只请求一次远端） */
const valueAnalysisCache = new Map<string, Record<string, unknown> | null>();

/** 清除估值分析缓存（供测试重置，避免跨用例缓存污染） */
export function clearValueAnalysisCache(): void {
  valueAnalysisCache.clear();
}

/**
 * 获取估值分析 RPT_VALUEANALYSIS_DET 的原始 row（共享、缓存）。
 * 调用方自行从 row 中提取所需字段，始终只发给远端一次。
 */
async function fetchValueAnalysisRow(code: string): Promise<Record<string, unknown> | null> {
  const cached = valueAnalysisCache.get(code);
  if (cached !== undefined) return cached;

  try {
    const secucode = `${code}.${code.startsWith('6') ? 'SH' : 'SZ'}`;
    const url = `https://datacenter.eastmoney.com/api/data/get?type=RPT_VALUEANALYSIS_DET&sty=ALL&filter=(SECUCODE="${secucode}")&p=1&ps=1&source=HSF10&client=PC&v=099415855`;
    const data = await fetchJsonWithTimeout(url) as {
      result?: { data?: Array<Record<string, unknown>> };
    } | null;
    const row = data?.result?.data?.[0] ?? null;
    valueAnalysisCache.set(code, row);
    return row;
  } catch {
    valueAnalysisCache.set(code, null);
    return null;
  }
}

/** F1.4: 估值兜底来源 —— 东方财富 datacenter「估值分析」(RPT_VALUEANALYSIS_DET)。
 * 该接口经 Node fetch 可达（与 MAINFINADATA 同源），提供真实的
 * 收盘价 / PE(TTM) / PB(MRQ) / 总市值，适用于 push2 不可达的环境（如部分沙箱）。
 */
async function fetchValuationFromDatacenter(code: string): Promise<ValuationData | null> {
  const row = await fetchValueAnalysisRow(code);
  if (!row) return null;

  const currentPrice = toNum(row.CLOSE_PRICE);
  if (currentPrice <= 0) return null;

  const pe = toNum(row.PE_TTM);
  const pb = toNum(row.PB_MRQ);
  const marketCapYi = Math.round((toNum(row.TOTAL_MARKET_CAP) / 1e8) * 100) / 100; // 元 -> 亿元

  return {
    currentPrice: Math.round(currentPrice * 100) / 100,
    pe: Math.round(pe * 100) / 100,
    pb: Math.round(pb * 100) / 100,
    ps: 0,
    marketCap: marketCapYi,
    historicalPE: [],
    peerComparison: []
  };
}

/**
 * F1.5: 获取股票所属行业板块名（datacenter BOARD_NAME）与证券简称。
 * 复用 fetchValueAnalysisRow 缓存，避免重复请求同一接口。
 */
export async function fetchBoardInfo(code: string): Promise<{ name?: string; boardName?: string } | null> {
  const row = await fetchValueAnalysisRow(code);
  if (!row) return null;
  return {
    name: row.SECURITY_NAME_ABBR ? String(row.SECURITY_NAME_ABBR) : undefined,
    boardName: row.BOARD_NAME ? String(row.BOARD_NAME) : undefined
  };
}

export async function fetchValuationData(code: string): Promise<ValuationData> {
  // 优先使用 datacenter 估值分析（Node fetch 可达、字段已正确量纲、沙箱/生产一致）
  const dc = await fetchValuationFromDatacenter(code);
  if (dc && dc.currentPrice > 0) return dc;

  // 兜底：东方财富 push2 实时行情
  const em = await fetchValuationFromEastMoney(code);
  if (em && em.currentPrice > 0) return em;

  throw new Error(`无法获取估值数据: ${code}`);
}

// ============ 数值转换工具 ============

export function toNum(v: unknown): number {
  if (v === null || v === undefined || v === '-') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/**
 * F1.3: 将东方财富API返回的元(¥)值明确转换为亿元
 * push2 的 f116(总市值)/f173(营收) 等货币字段以及
 * RPT_F10_FINANCE_MAINFINADATA 的货币字段，单位均为元
 * 除以1e8得到亿元，保留2位小数
 */
export function yuanToYi(v: unknown): number {
  const n = toNum(v);
  if (n === 0) return 0;
  return Math.round(n / 1e8 * 100) / 100;
}

/**
 * 转换为百分比数值（如 91.5 表示 91.5%）。
 * 东方财富财务比率字段（毛利率/净利率/ROE/负债率）均为**百分比形式**返回，
 * 故直接四舍五入即可；仅当值 < 1 时视为小数形式（如 0.915）乘以 100。
 * 注意：绝不能对所有值统一 ×100 —— 负债率等可能 ≥100（如 105%），
 * 若误判为小数会得到 10500 这种荒谬结果。
 */
export function toPercent(v: unknown): number {
  const n = toNum(v);
  if (n === 0) return 0;
  const value = Math.abs(n) < 1 ? n * 100 : n;
  return Math.round(value * 100) / 100;
}

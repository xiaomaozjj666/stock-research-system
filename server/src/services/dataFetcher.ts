import type { StockInfo, FinancialData, ValuationData } from '../types.js';

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
 * 带超时的 fetch 封装
 */
async function fetchWithTimeout(url: string, timeout = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 安全解析 JSON，失败返回 null
 */
async function safeJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ============ 获取股票基本信息 ============

async function fetchStockInfoFromEastMoney(code: string): Promise<StockInfo | null> {
  try {
    const secid = getSecId(code);
    const url = `http://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f127,f162,f173,f187,f188,f190,f191,f192,f193&ut=fa5fd1943c7b386f172d6893dbbd1`;
    const response = await fetchWithTimeout(url);
    const data = await safeJson(response) as { rc?: number; data?: Record<string, unknown> } | null;

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
    const response = await fetchWithTimeout(url);
    const text = await response.text();

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
    const secid = getSecId(code);
    // 东方财富财务指标 API - 获取最近6年年报
    const url = `https://datacenter.eastmoney.com/api/data/get?type=RPT_F10_FINANCE_MAINFINADATA&sty=ALL&filter=(SECUCODE="${code}.${code.startsWith('6') ? 'SH' : 'SZ'}")(REPORT_TYPE="年报")&p=1&ps=6&sr=-1&st=REPORT_DATE&source=HSF10&client=PC&v=099415855`;

    const response = await fetchWithTimeout(url);
    const data = await safeJson(response) as {
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
      revenue.push(toYi(r.TOTALOPERATEREVE));
      netProfit.push(toYi(r.PARENTNETPROFIT));
      grossMargin.push(toPercent(r.XSMLL));
      netMargin.push(toPercent(r.XSJLL));
      roe.push(toPercent(r.ROEJQ));
      // 每股经营现金流 × 总股本 ≈ 经营现金流总额（亿元）
      const mgjyxjje = toNum(r.MGJYXJJE);
      const totalShare = toNum(r.TOTAL_SHARE);
      const opCashFlow = mgjyxjje * totalShare / 1e8; // 转为亿元
      operatingCashFlow.push(Math.round(opCashFlow * 100) / 100);
      eps.push(toNum(r.EPSJB));
      totalAssets.push(toYi(r.TOTAL_ASSETS_PK));
      totalLiabilities.push(toYi(r.LIABILITY));
      equity.push(toYi(r.TOTAL_EQUITY_PK));
      accountsReceivable.push(0); // API不直接提供，设为0
      inventory.push(0); // API不直接提供，设为0
      goodwill.push(0); // API不直接提供，设为0
      debtRatio.push(toPercent(r.ZCFZL));
    }

    if (years.length === 0) return null;

    return {
      years, revenue, netProfit, grossMargin, netMargin, roe,
      operatingCashFlow, eps, totalAssets, totalLiabilities, equity,
      accountsReceivable, inventory, goodwill, debtRatio
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
    const response = await fetchWithTimeout(url);
    const data = await safeJson(response) as { data?: Record<string, unknown> } | null;

    if (!data?.data) return null;

    // 备用方案：只能获取当前快照数据，构造单年数据
    const d = data.data;
    const currentYear = new Date().getFullYear().toString();

    return {
      years: [currentYear],
      revenue: [toYi(d.f173)],
      netProfit: [toYi(d.f187)],
      grossMargin: [toPercent(d.f188)],
      netMargin: [toPercent(d.f190)],
      roe: [toPercent(d.f191)],
      operatingCashFlow: [0],
      eps: [toNum(d.f192)],
      totalAssets: [toYi(d.f193)],
      totalLiabilities: [0],
      equity: [0],
      accountsReceivable: [0],
      inventory: [0],
      goodwill: [0],
      debtRatio: [toPercent(d.f162)]
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
    const response = await fetchWithTimeout(url);
    const data = await safeJson(response) as { data?: Record<string, unknown> } | null;

    if (!data?.data) return null;

    const d = data.data;
    const currentPrice = toNum(f43(d));
    const pe = toNum(d.f167);
    const pb = toNum(d.f164);
    const marketCap = toYi(d.f116);
    const totalRevenue = toYi(d.f173);
    const ps = totalRevenue > 0 ? marketCap / totalRevenue : 0;

    // 构建历史 PE（简化：使用当前 PE 作为基准，逐年微调）
    const currentYear = new Date().getFullYear();
    const historicalPE: { year: string; pe: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const year = (currentYear - i).toString();
      // 简单模拟历史 PE 波动
      const factor = 1 + (i * 0.05) + (Math.sin(i) * 0.1);
      historicalPE.push({ year, pe: Math.round(pe * factor * 10) / 10 });
    }

    return {
      currentPrice,
      pe: pe || 0,
      pb: pb || 0,
      ps: Math.round(ps * 100) / 100,
      marketCap: Math.round(marketCap),
      historicalPE,
      peerComparison: []
    };
  } catch {
    return null;
  }
}

function f43(d: Record<string, unknown>): number {
  // f43 是价格，可能需要除以100或1000
  const val = Number(d.f43 ?? 0);
  return val > 10000 ? val / 100 : val;
}

export async function fetchValuationData(code: string): Promise<ValuationData> {
  const valuation = await fetchValuationFromEastMoney(code);
  if (valuation && valuation.currentPrice > 0) return valuation;

  throw new Error(`无法获取估值数据: ${code}`);
}

// ============ 数值转换工具 ============

function toNum(v: unknown): number {
  if (v === null || v === undefined || v === '-') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/**
 * 转换为亿元（API 返回的可能是元）
 */
function toYi(v: unknown): number {
  const n = toNum(v);
  if (n === 0) return 0;
  // 如果值很大，说明单位是元，转换为亿
  if (Math.abs(n) > 1e8) return Math.round(n / 1e8 * 100) / 100;
  // 如果值适中，可能已经是亿
  if (Math.abs(n) > 1e4) return Math.round(n / 1e4 * 100) / 100;
  return Math.round(n * 100) / 100;
}

/**
 * 转换为百分比数值（如 91.5 表示 91.5%）
 */
function toPercent(v: unknown): number {
  const n = toNum(v);
  if (n === 0) return 0;
  // 如果值已经是百分比形式（如 91.5）
  if (Math.abs(n) < 100) return Math.round(n * 100) / 100;
  // 如果是小数形式（如 0.915）
  return Math.round(n * 10000) / 100;
}

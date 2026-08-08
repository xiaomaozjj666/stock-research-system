import type { StockInfo, FinancialData, ValuationData } from '../types.js';
import { fetchStockInfo, fetchFinancialData, fetchValuationData } from './dataFetcher.js';
import { buildPeerComparison, resolveStockIndustry } from './peerService.js';
import { loadStockMaster, fuzzyMatch } from './stockMaster.js';
import { MOUTAI_INFO, MOUTAI_FINANCIAL, MOUTAI_VALUATION } from '../data/sampleData.js';
import logger from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

export interface StockDataSet {
  info: StockInfo;
  financial: FinancialData;
  valuation: ValuationData;
}

const CACHE_DIR = path.join(import.meta.dirname, '..', 'data', 'cache');

// 确保缓存目录存在（同步，模块加载时执行一次）
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS) || 24;
const CACHE_TTL = CACHE_TTL_HOURS * 60 * 60 * 1000;

// 内存 LRU 缓存：避免热股票反复触发文件 I/O + JSON 解析。
// 容量上限后淘汰最久未用；与文件缓存共用同一 TTL（CACHE_TTL）。
interface MemCacheEntry { data: StockDataSet; timestamp: number; }
const memCache = new Map<string, MemCacheEntry>();
const MEM_CACHE_MAX = Number(process.env.MEM_CACHE_MAX) || 500;

function memCacheGet(code: string): StockDataSet | null {
  const entry = memCache.get(code);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    memCache.delete(code);
    return null;
  }
  // LRU：命中后移到末尾（最近使用）
  memCache.delete(code);
  memCache.set(code, entry);
  return entry.data;
}

function memCacheSet(code: string, data: StockDataSet): void {
  memCache.set(code, { data, timestamp: Date.now() });
  // 容量超限：淘汰最久未用（Map 头部为最旧）
  while (memCache.size > MEM_CACHE_MAX) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey === undefined) break;
    memCache.delete(oldestKey);
  }
}

// 品牌名/常用名 → 上市简称 的别名映射。东方财富搜索 API 只认上市主体简称，
// 用户输入品牌名（如「长鑫存储」）时需改写为上市主体名（「长鑫科技」）才能命中。
export const SEARCH_ALIASES: Record<string, string> = {
  '长鑫存储': '长鑫科技',
  '长鑫': '长鑫科技',
};

// 上市窗口期临时前缀（C=上市后次日起 5 个交易日内，N=上市首日）仅表示
// 涨跌幅限制机制，并非证券简称的一部分，展示时应去除。个别股票窗口名被
// 交易所截断（如「C长鑫」实为「长鑫科技」），按代码显式补全。
const DISPLAY_NAME_OVERRIDE: Record<string, string> = {
  '688825': '长鑫科技',
};

export function cleanDisplayName(name: string, code?: string): string {
  if (code && DISPLAY_NAME_OVERRIDE[code]) return DISPLAY_NAME_OVERRIDE[code];
  return name.replace(/^[CN](?=[一-龥])/, '');
}

export async function getData(stockCode: string): Promise<StockDataSet> {
  // 0. 内存 LRU 缓存（最热路径，避免文件 I/O）
  const memHit = memCacheGet(stockCode);
  if (memHit) return memHit;

  // 1. 检查文件缓存（异步文件 I/O）
  const cacheFile = path.join(CACHE_DIR, `${stockCode}.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      const cachedContent = await fs.promises.readFile(cacheFile, 'utf-8');
      const cached = JSON.parse(cachedContent);
      const cacheAge = Date.now() - cached.timestamp;
      if (cacheAge < CACHE_TTL) {
        const data = cached.data as StockDataSet;
        memCacheSet(stockCode, data); // 预热到内存 LRU
        return data;
      }
    }
  } catch {
    // 缓存损坏或读取失败，忽略
  }

  // 2. 尝试从 API 获取数据
  try {
    const [info, financial, valuation] = await Promise.all([
      fetchStockInfo(stockCode),
      fetchFinancialData(stockCode),
      fetchValuationData(stockCode)
    ]);
    // 去除上市窗口期临时前缀（C/N），展示规范简称
    info.name = cleanDisplayName(info.name, info.code);
    // 填充同业对比（行业参考表 + 实时估值，供估值/行业/资金专家使用）
    try {
      // 反查并补全行业（主数据不可达时由 datacenter BOARD_NAME 兜底）
      const industry = await resolveStockIndustry(info.code, info.industry);
      if (industry) info.industry = industry;
      logger.info('[peer] 填充行业信息', { industry: info.industry, stockCode: info.code });
      const peers = await buildPeerComparison(info.code, info.industry);
      valuation.peerComparison = peers.map((p) => ({
        name: p.name,
        code: p.code,
        pe: p.pe,
        pb: p.pb,
        roe: p.roe,
        marketCap: p.marketCap,
      }));
      logger.info('[peer] 同业对比填充完成', {
        count: valuation.peerComparison.length,
        peers: valuation.peerComparison.map((p) => p.code + p.name),
      });
    } catch (e) {
      logger.info('[peer] buildPeerComparison error', { err: e as Error });
    }

    const dataSet: StockDataSet = { info, financial, valuation };

    // 写入缓存（内存 LRU + 异步文件）
    memCacheSet(stockCode, dataSet);
    try {
      await fs.promises.writeFile(
        cacheFile,
        JSON.stringify({ data: dataSet, timestamp: Date.now() }, null, 2),
        'utf-8'
      );
    } catch (writeErr) {
      logger.warn('缓存写入失败', { stockCode, err: writeErr as Error });
    }
    return dataSet;
  } catch (error) {
    // 3. 降级到 sampleData（仅茅台）
    if (stockCode === '600519') {
      logger.warn('API 获取失败，使用内置样本数据', { stockCode, err: error as Error });
      return {
        info: MOUTAI_INFO,
        financial: MOUTAI_FINANCIAL,
        valuation: MOUTAI_VALUATION
      };
    }
    throw new Error(`无法获取股票数据: ${stockCode}，${(error as Error).message}`);
  }
}

export async function getSupportedStocks(): Promise<{ code: string; name: string; industry: string }[]> {
  const stocks: { code: string; name: string; industry: string }[] = [];

  // 从缓存目录读取已查询过的股票（异步）
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const files = (await fs.promises.readdir(CACHE_DIR)).filter(f => f.endsWith('.json'));
      const entries = await Promise.all(
        files.map(async (file) => {
          try {
            const content = await fs.promises.readFile(path.join(CACHE_DIR, file), 'utf-8');
            const cached = JSON.parse(content);
            const info = (cached.data as StockDataSet).info;
            return { code: info.code, name: info.name, industry: info.industry };
          } catch {
            return null;
          }
        })
      );
      for (const e of entries) {
        if (e) stocks.push(e);
      }
    }
  } catch {
    // 目录读取失败，忽略
  }

  // 确保茅台始终在列表中
  if (!stocks.find(s => s.code === '600519')) {
    stocks.unshift({ code: '600519', name: '贵州茅台', industry: '白酒' });
  }

  return stocks;
}

export async function searchStocks(keyword: string): Promise<{ code: string; name: string }[]> {
  const kw = keyword.trim();
  const query = SEARCH_ALIASES[kw] ?? kw; // 品牌名别名改写
  const searchToken = process.env.EASTMONEY_SEARCH_TOKEN || 'D43BF722C8E33BDC906FB84D85E326E8';
  // 1. 东方财富 suggest（擅长代码/拼音/上市简称）
  try {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(query)}&type=14&token=${searchToken}&count=10`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await response.json() as {
      QuotationCodeTable?: { Data?: Array<{ MktNum: string; Code: string; Name: string }> };
    };

    if (data.QuotationCodeTable?.Data) {
      const results = data.QuotationCodeTable.Data
        .filter(item => item.MktNum === '0' || item.MktNum === '1')
        .map(item => ({ code: item.Code, name: cleanDisplayName(item.Name, item.Code) }));
      if (results.length > 0) return results;
    }
  } catch {
    /* 上游失败，走兜底 */
  }

  // 2. 兜底：本地证券全表模糊匹配（支持工商全称/子串/部分重叠）
  try {
    const master = await loadStockMaster();
    const fuzzy = fuzzyMatch(query, master);
    if (fuzzy.length > 0) return fuzzy.map(e => ({ code: e.code, name: cleanDisplayName(e.name, e.code) }));
  } catch {
    /* 兜底失败，返回空 */
  }

  return [];
}

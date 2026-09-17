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

// 缓存目录可被 DATA_CACHE_DIR 重定向（测试据此隔离到临时目录，避免污染真实缓存）
const DEFAULT_CACHE_DIR = path.join(import.meta.dirname, '..', 'data', 'cache');

/**
 * 股票数据缓存目录（DATA_CACHE_DIR 可重定向；惰性解析以便测试/运维在运行期切换，
 * 与 quant/quantCache.getQuantCacheDir 同一口径——/api/health 也复用本函数）。
 */
export function getDataCacheDir(): string {
  const env = process.env.DATA_CACHE_DIR;
  return env && env.length > 0 ? env : DEFAULT_CACHE_DIR;
}

/** 本类条目的归属标记：与 quant/quantCache 共享目录时用于互相区分、互不误删 */
const STOCK_KIND = 'stocks';

/**
 * 异类条目判定（本模块视角）：
 * - 带 kind 且不是 'stocks' → 对侧（量化缓存）或未来新增类型；
 * - 旧格式无 kind：量化缓存条目一定带 ttlMs（quantCache.writeCacheEntry），据此识别。
 */
function isForeignCacheEntry(parsed: { kind?: unknown; ttlMs?: unknown } | null): boolean {
  if (parsed?.kind === STOCK_KIND) return false;
  if (parsed?.kind !== undefined) return true;
  return typeof parsed?.ttlMs === 'number';
}

const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS) || 24;
const CACHE_TTL = CACHE_TTL_HOURS * 60 * 60 * 1000;

// 内存 LRU 缓存：避免热股票反复触发文件 I/O + JSON 解析。
// 容量上限后淘汰最久未用；与文件缓存共用同一 TTL（CACHE_TTL）。
//
// ⚠️ 不变量（H-06 缓存污染修复）：缓存里存放的对象**只增不改**，任何对外返回都必须
// 经过 cloneStockDataSet()。原因：调用方（services/analysisPipeline.ts）会就地改写
// 返回值——修正 PE/PB、写入估算的 historicalPE。修复前 getData 直接返回缓存对象引用，
// 于是那份「从未由 API 提供过」的修正结果被写回内存 LRU 甚至落盘 JSON，
// 之后 /api/quant/valuation/model 等拿到的 PE 取决于「谁先跑过」，同一份数据在不同
// 请求间口径不一致。
interface MemCacheEntry {
  data: StockDataSet;
  timestamp: number;
}
const memCache = new Map<string, MemCacheEntry>();
const MEM_CACHE_MAX = Number(process.env.MEM_CACHE_MAX) || 500;

/**
 * 返回缓存对象的独立副本（结构化深拷贝）。
 *
 * 为什么用「读时深拷贝」而不是「Object.freeze + 写前深拷贝」：
 *   - freeze 只拦得住**严格模式**下的属性赋值，改不到嵌套对象（data.financial.years[0]）
 *     仍会污染；要彻底拦住得递归冻结整棵对象树，成本与深拷贝相当，却把「调用方就地
 *     改写」从静默污染变成运行时抛错——analysisPipeline 的既有写法（直接改 valuation.pe）
 *     会当场 500，等于用线上可用性换一个能在测试里表达的不变量；
 *   - 深拷贝把语义收敛在一处（唯一出口），调用方读写自由，且缓存里的对象永远干净；
 *   - 取舍：只在**返回边界**做一次结构化拷贝，数据规模是单只股票的行情 + 财务
 *     （十几个定长数组，KB 级），相对随之而来的磁盘 I/O / JSON 解析可忽略；
 *     拷贝本身不进任何循环或热点路径（每只股票每次取数一次）。
 */
function cloneStockDataSet(data: StockDataSet): StockDataSet {
  // structuredClone 为 Node 17+ 内置的结构化克隆：比 JSON round-trip 快，
  // 且不丢 undefined/NaN。本模块的数据全部是纯 JSON 值，两者语义等价。
  return structuredClone(data);
}

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
  // 存副本：即便调用方拿到了本函数的入参对象，也改不到缓存里的那一份
  memCache.set(code, { data: cloneStockDataSet(data), timestamp: Date.now() });
  // 容量超限：淘汰最久未用（Map 头部为最旧）
  while (memCache.size > MEM_CACHE_MAX) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey === undefined) break;
    memCache.delete(oldestKey);
  }
}

// === 磁盘缓存清理（H-05）：TTL 过期删除 + 数量上限淘汰，防止缓存文件无限累积撑爆磁盘 ===
const FILE_CACHE_MAX = Number(process.env.FILE_CACHE_MAX) || 2000;
/** 定期清理间隔：1 小时（过期项在读取时也会跳过，这里是兜底物理删除） */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 清理磁盘缓存：
 * 1. 删除已过 TTL 的**本类**缓存文件与损坏文件；
 * 2. **异类条目（quant/quantCache 的量化缓存）一律跳过**：量化 K 线的 TTL 以「天」计
 *    （如 30 天），远长于股票缓存的 24h，若按本规则判定会整批误删，导致缓存静默失效、
 *    反复全量重拉上游；容量上限也只统计本类，避免两类互相挤占；
 * 3. best-effort：任何 IO 失败都静默降级，不影响主流程。
 */
export async function pruneFileCache(): Promise<{ removed: number }> {
  let removed = 0;
  try {
    const dir = getDataCacheDir();
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json'));
    const alive: { file: string; timestamp: number }[] = [];
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const parsed = JSON.parse(await fs.promises.readFile(full, 'utf-8')) as {
          timestamp?: number;
          kind?: unknown;
          ttlMs?: unknown;
        };
        if (isForeignCacheEntry(parsed)) continue; // 异类：交给对侧 pruner
        if (typeof parsed.timestamp !== 'number' || Date.now() - parsed.timestamp > CACHE_TTL) {
          await fs.promises.unlink(full);
          removed += 1;
        } else {
          alive.push({ file: full, timestamp: parsed.timestamp });
        }
      } catch {
        // 损坏/不可读的缓存文件：直接删除
        await fs.promises.unlink(full).catch(() => {});
        removed += 1;
      }
    }
    if (alive.length > FILE_CACHE_MAX) {
      alive.sort((a, b) => a.timestamp - b.timestamp);
      for (const entry of alive.slice(0, alive.length - FILE_CACHE_MAX)) {
        await fs.promises.unlink(entry.file).catch(() => {});
        removed += 1;
      }
    }
  } catch {
    // 目录不存在或 IO 失败：静默降级
  }
  return { removed };
}

// 启动清理一次 + 每小时定期清理（测试环境不自动跑，避免测试改动真实缓存目录）
if (process.env.NODE_ENV !== 'test') {
  void pruneFileCache();
  const pruneTimer = setInterval(() => void pruneFileCache(), PRUNE_INTERVAL_MS);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
}

// 品牌名/常用名 → 上市简称 的别名映射。东方财富搜索 API 只认上市主体简称，
// 用户输入品牌名（如「长鑫存储」）时需改写为上市主体名（「长鑫科技」）才能命中。
export const SEARCH_ALIASES: Record<string, string> = {
  长鑫存储: '长鑫科技',
  长鑫: '长鑫科技',
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

// === single-flight：同一股票的并发未命中只发起一次外部抓取 ===
// /api/compare 天然 2-3 只并发、SSE+POST 双端可能同时请求同一代码，
// 无 single-flight 时每个请求各自打 3 个外部接口并对上游造成放大压力。
const inFlight = new Map<string, Promise<StockDataSet>>();

export function getData(stockCode: string): Promise<StockDataSet> {
  // 0. 内存 LRU 缓存（最热路径，避免文件 I/O）
  //    命中必须返回副本：缓存里的那一份是「唯一真相」，任何调用方都无权改写
  //    （见本文件顶部 memCache 的缓存污染不变量说明）
  const memHit = memCacheGet(stockCode);
  if (memHit) return Promise.resolve(cloneStockDataSet(memHit));

  // 并发去重：同代码已有在途抓取时复用同一个 Promise
  const pending = inFlight.get(stockCode);
  if (pending) return pending.then((data) => cloneStockDataSet(data));

  const promise = fetchDataAndCache(stockCode).finally(() => {
    inFlight.delete(stockCode);
  });
  inFlight.set(stockCode, promise);
  return promise.then((data) => cloneStockDataSet(data));
}

async function fetchDataAndCache(stockCode: string): Promise<StockDataSet> {
  // 1. 检查文件缓存（异步文件 I/O）
  const cacheFile = path.join(getDataCacheDir(), `${stockCode}.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      const cachedContent = await fs.promises.readFile(cacheFile, 'utf-8');
      const cached = JSON.parse(cachedContent);
      const cacheAge = Date.now() - cached.timestamp;
      // 异类条目（量化缓存）不得当作股票数据用：共享 DATA_CACHE_DIR 时二者同目录
      if (!isForeignCacheEntry(cached) && cacheAge < CACHE_TTL) {
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
      fetchValuationData(stockCode),
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
      logger.warn('[peer] buildPeerComparison error', { err: e as Error });
    }

    const dataSet: StockDataSet = { info, financial, valuation };

    // 写入缓存（内存 LRU + 异步文件）。memCacheSet 内部另存副本，
    // 因此这里 return 出去的对象被调用方就地改写也不会污染缓存与磁盘内容。
    memCacheSet(stockCode, dataSet);
    try {
      // 目录按需创建（原先在模块加载时同步创建一次；改为惰性解析后，创建挪到真正的写入方，
      // 健康检查等只读路径不再写盘）
      await fs.promises.mkdir(getDataCacheDir(), { recursive: true });
      await fs.promises.writeFile(
        cacheFile,
        JSON.stringify({ kind: STOCK_KIND, data: dataSet, timestamp: Date.now() }, null, 2),
        'utf-8',
      );
    } catch (writeErr) {
      logger.warn('缓存写入失败', { stockCode, err: writeErr as Error });
    }
    return dataSet;
  } catch (error) {
    // 3. 降级到 sampleData（仅茅台）
    if (stockCode === '600519') {
      logger.warn('API 获取失败，使用内置样本数据', { stockCode, err: error as Error });
      // 同样返回副本：sampleData 是模块级常量，被就地改写会污染所有后续降级请求
      return cloneStockDataSet({
        info: MOUTAI_INFO,
        financial: MOUTAI_FINANCIAL,
        valuation: MOUTAI_VALUATION,
      });
    }
    throw new Error(`无法获取股票数据: ${stockCode}，${(error as Error).message}`);
  }
}

// /api/stocks 列表的内存缓存：列表内容只在新增缓存文件时变化，
// 无需每次请求都全量 readdir + 读文件 + JSON.parse（最多 2000 个）。
let stocksListCache: {
  data: { code: string; name: string; industry: string }[];
  at: number;
} | null = null;
const STOCKS_LIST_TTL_MS = 60 * 1000;

export async function getSupportedStocks(): Promise<
  { code: string; name: string; industry: string }[]
> {
  if (stocksListCache && Date.now() - stocksListCache.at < STOCKS_LIST_TTL_MS) {
    return stocksListCache.data;
  }

  const stocks: { code: string; name: string; industry: string }[] = [];

  // 从缓存目录读取已查询过的股票（异步）
  try {
    const dir = getDataCacheDir();
    if (fs.existsSync(dir)) {
      const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json'));
      const entries = await Promise.all(
        files.map(async (file) => {
          try {
            const content = await fs.promises.readFile(path.join(dir, file), 'utf-8');
            const cached = JSON.parse(content);
            // 共享目录下的量化缓存条目没有 info：跳过，避免列表里出现 code/name 皆为空的条目
            if (isForeignCacheEntry(cached)) return null;
            const info = (cached.data as StockDataSet)?.info;
            if (!info?.code) return null;
            return { code: info.code, name: info.name, industry: info.industry };
          } catch {
            return null;
          }
        }),
      );
      for (const e of entries) {
        if (e) stocks.push(e);
      }
    }
  } catch {
    // 目录读取失败，忽略
  }

  // 确保茅台始终在列表中
  if (!stocks.find((s) => s.code === '600519')) {
    stocks.unshift({ code: '600519', name: '贵州茅台', industry: '白酒' });
  }

  stocksListCache = { data: stocks, at: Date.now() };
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
    const data = (await response.json()) as {
      QuotationCodeTable?: { Data?: Array<{ MktNum: string; Code: string; Name: string }> };
    };

    if (data.QuotationCodeTable?.Data) {
      const results = data.QuotationCodeTable.Data.filter(
        (item) => item.MktNum === '0' || item.MktNum === '1',
      ).map((item) => ({ code: item.Code, name: cleanDisplayName(item.Name, item.Code) }));
      if (results.length > 0) return results;
    }
  } catch {
    /* 上游失败，走兜底 */
  }

  // 2. 兜底：本地证券全表模糊匹配（支持工商全称/子串/部分重叠）
  try {
    const master = await loadStockMaster();
    const fuzzy = fuzzyMatch(query, master);
    if (fuzzy.length > 0)
      return fuzzy.map((e) => ({ code: e.code, name: cleanDisplayName(e.name, e.code) }));
  } catch {
    /* 兜底失败，返回空 */
  }

  return [];
}

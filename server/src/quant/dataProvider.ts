import type { OHLCVData } from './types.js';
import logger from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_CACHE_DIR = path.join(import.meta.dirname, 'cache');

/**
 * 运行时解析缓存目录：支持 DATA_CACHE_DIR env 重定向（与 services/dataService 同模式）。
 * 惰性解析而非模块级常量，测试可在 beforeEach 中设置 env 后生效。
 */
function getCacheDir(): string {
  return process.env.DATA_CACHE_DIR && process.env.DATA_CACHE_DIR.length > 0
    ? process.env.DATA_CACHE_DIR
    : DEFAULT_CACHE_DIR;
}

function getSecId(code: string): string {
  return code.startsWith('6') ? `1.${code}` : `0.${code}`;
}

export type Market = 'A' | 'HK' | 'US';

/** 识别市场：A 股 6 位纯数字；港股 5 位纯数字；美股字母代码 */
export function marketOf(code: string): Market {
  const c = code.trim();
  if (/^\d{6}$/.test(c)) return 'A';
  if (/^\d{5}$/.test(c)) return 'HK';
  if (/^[A-Za-z]{1,6}$/.test(c)) return 'US';
  return 'A';
}

/**
 * 把代码解析为东方财富 secid（含港股/美股）。
 * A 股：6 开头→1.（上交所），其余→0.（深交所）——与历史 getSecId 完全一致。
 * 港股：5 位→116.（港股通/港股市场）。
 * 美股：字母→107.（美股市场，大写）。
 */
export function resolveSecid(code: string): string {
  const c = code.trim();
  const m = marketOf(c);
  if (m === 'HK') return `116.${c}`;
  if (m === 'US') return `107.${c.toUpperCase()}`;
  return getSecId(c);
}

/**
 * 获取股票日K线历史数据
 * 使用东方财富公开API
 */
/**
 * 按日期范围过滤 K 线（look-ahead 防御，借鉴 TradingAgents stockstats_utils）：
 * 剔除 endDate 之后（未来数据——回测混入未来行会让 Sharpe/回撤失真）
 * 与 startDate 之前（越界数据）的行；返回保留行数与剔除行数。
 */
export function filterOHLCVByRange(
  data: OHLCVData[],
  startDate: string,
  endDate: string,
): { data: OHLCVData[]; trimmed: number } {
  const start = startDate.replace(/-/g, '');
  const end = endDate.replace(/-/g, '');
  const kept: OHLCVData[] = [];
  let trimmed = 0;
  for (const d of data) {
    const ymd = d.date.replace(/-/g, '');
    if (ymd < start || ymd > end) {
      trimmed++;
    } else {
      kept.push(d);
    }
  }
  return { data: kept, trimmed };
}

/**
 * 按 secid 获取 K 线（fetchOHLCVData 与指数基准共用内核）。
 * 含缓存、look-ahead 防御与模拟数据降级；cacheToken 仅用于缓存文件名（已白名单清洗）。
 */
async function fetchKlineBySecid(
  secid: string,
  startDate: string,
  endDate: string,
  cacheToken: string,
  timeoutMs = 15000,
): Promise<OHLCVData[]> {
  // 1. 检查缓存（缓存文件名对 token 做白名单清洗：防路径穿越）
  const cacheKey = `${sanitizeCacheToken(cacheToken)}_${sanitizeCacheToken(startDate)}_${sanitizeCacheToken(endDate)}`;
  const cacheDir = getCacheDir();
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    const age = Date.now() - cached.timestamp;
    if (age < 12 * 60 * 60 * 1000) {
      // 12小时缓存；仍做范围过滤（防御历史脏缓存混入未来行）
      const { data, trimmed } = filterOHLCVByRange(cached.data, startDate, endDate);
      if (trimmed > 0) {
        logger.warn('缓存K线存在越界行，已剔除', { secid, startDate, endDate, trimmed });
      }
      return data;
    }
  }

  // 2. 从东方财富获取日K线
  const beg = startDate.replace(/-/g, '');
  const end = endDate.replace(/-/g, '');

  // lmt 按请求跨度估算：固定 1000 会在约 4 年以上的区间静默截断
  // （API 只返回前 1000 根且无告警，回测区间悄悄缩水）；日历天数 ≥ 交易日数，
  // 再加 10 天余量即可保证不截断，封顶防滥用
  const spanDays =
    Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1;
  const lmt = Math.min(Math.max(Number.isFinite(spanDays) ? spanDays + 10 : 1000, 1000), 100000);

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=${beg}&end=${end}&lmt=${lmt}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const json = await response.json();

    if (json?.data?.klines) {
      const data: OHLCVData[] = json.data.klines.map((line: string) => {
        const parts = line.split(',');
        return {
          date: parts[0],
          open: parseFloat(parts[1]),
          close: parseFloat(parts[2]),
          high: parseFloat(parts[3]),
          low: parseFloat(parts[4]),
          volume: parseFloat(parts[5]),
        };
      });

      // look-ahead 防御：剔除超出请求范围的行（API 边界行为不可控，本地二次校验兜底）
      const { data: filtered, trimmed } = filterOHLCVByRange(data, startDate, endDate);
      if (trimmed > 0) {
        logger.warn('K线返回越界行，已剔除（look-ahead 防御）', {
          secid,
          startDate,
          endDate,
          trimmed,
        });
      }

      // 写入缓存
      fs.writeFileSync(cacheFile, JSON.stringify({ data: filtered, timestamp: Date.now() }));
      return filtered;
    }
  } catch (error) {
    logger.warn('获取K线数据失败', { secid, startDate, endDate, err: error });
  }

  // 3. 降级：生成模拟数据（用于演示）
  // F1.6: 模拟数据标记 isSimulated=true，下游策略引擎应检查此标志
  const simulated = generateSimulatedData(cacheToken, startDate, endDate);
  return simulated.map((d) => ({ ...d, isSimulated: true }));
}

/**
 * 获取 K 线数据（含 look-ahead 防御：返回前按 [startDate, endDate] 二次过滤）。
 */
export async function fetchOHLCVData(
  stockCode: string,
  startDate: string,
  endDate: string,
): Promise<OHLCVData[]> {
  return fetchKlineBySecid(resolveSecid(stockCode), startDate, endDate, stockCode);
}

/**
 * A 股宽基基准（默认沪深300，东方财富 secid `1.000300`）。
 * 量价因子的 Beta / 特异波动率 / 残差动量需要「市场收益」才能计算；个股自身买入持有
 * 曲线（getBenchmarkCurve）不是市场代理（用它算 Beta 会恒为 1），必须拉真实宽基指数。
 */
export const A_SHARE_BENCHMARK_SECID = '1.000300';

/**
 * 各市场宽基基准（东方财富 secid），供量价因子作市场收益。
 * - A 股：沪深300（`1.000300`）
 * - 美股：标普500（`100.SPX`，东方财富全球指数前缀 `100.` + 代码 SPX）
 * - 港股：恒生指数（`100.HSI`）
 * Beta / 特异波动率 / 残差动量需要「市场收益」才能计算；个股自身买入持有曲线
 * （getBenchmarkCurve）不是市场代理（用它算 Beta 会恒为 1），必须拉真实宽基指数。
 */
export const BENCHMARK_SECID_BY_MARKET: Record<Market, string> = {
  A: A_SHARE_BENCHMARK_SECID,
  US: '100.SPX',
  HK: '100.HSI',
};

/** 按市场取宽基基准 secid（未知市场回退沪深300） */
export function benchmarkSecidForMarket(market: Market): string {
  return BENCHMARK_SECID_BY_MARKET[market] ?? A_SHARE_BENCHMARK_SECID;
}

/**
 * 拉取宽基指数日收益，按股票 bars 的日期对齐，供量价因子作市场基准。
 *
 * @param barDates 股票 K 线日期序列（升序），marketReturns 将与之等长对齐
 * @param startDate/endDate 与股票相同的区间（缓存/请求用）
 * @param indexSecid 指数 secid；默认 A 股沪深300。调用方通常用 `benchmarkSecidForMarket(marketOf(code))` 按市场选基准
 * @returns 与 barDates 等长的日收益数组（缺失处为 NaN）；对齐率 < 50% 或拉取失败返回 null（降级）
 */
export async function fetchBenchmarkReturns(
  barDates: string[],
  startDate: string,
  endDate: string,
  indexSecid: string = A_SHARE_BENCHMARK_SECID,
): Promise<number[] | null> {
  if (barDates.length < 2) return null;
  try {
    const idx = await fetchKlineBySecid(indexSecid, startDate, endDate, `idx_${indexSecid}`, 10000);
    if (!idx || idx.length < 2) return null;
    // 指数拉取失败会降级为模拟数据（F1.6）；模拟指数与真实股票收益无关，
    // 用于回归会污染 Beta，故视为「无市场收益」返回 null
    if (idx.some((b) => b.isSimulated)) return null;
    // 指数每日收益（realized on date i）：close[i]/close[i-1] − 1
    const idxRet = new Map<string, number>();
    for (let i = 1; i < idx.length; i++) {
      const base = idx[i - 1].close;
      const ahead = idx[i].close;
      idxRet.set(idx[i].date, base > 0 && ahead > 0 ? ahead / base - 1 : NaN);
    }
    // 按股票 bars 日期对齐（指数与 A 股同交易历；缺失处 NaN，不向前填充以免错位）
    const out = barDates.map((d) => idxRet.get(d) ?? NaN);
    const finite = out.filter((v) => Number.isFinite(v)).length;
    // 对齐率过低说明指数与股票交易历严重错配（如跨市场），放弃以免污染 Beta
    if (finite < Math.ceil(barDates.length * 0.5)) return null;
    return out;
  } catch {
    return null;
  }
}

/** 缓存文件名 token 清洗：只保留字母/数字/下划线/连字符，防 `../` 等路径穿越 */
function sanitizeCacheToken(token: string): string {
  return token.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * 生成模拟K线数据（当API不可用时降级使用）
 */
function generateSimulatedData(stockCode: string, startDate: string, endDate: string): OHLCVData[] {
  const data: OHLCVData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  // 基于股票代码生成确定性的"随机"价格：
  // 字母代码（如 AAPL）parseInt 得 NaN 会让整条模拟曲线全是 NaN，先做确定性哈希
  function codeSeed(s: string): number {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 3) return parseInt(digits.slice(-3), 10);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 1000;
  }
  let price = 50 + (codeSeed(stockCode) % 100);
  const seed = codeSeed(stockCode.slice(-3));

  const current = new Date(start);
  while (current <= end) {
    // 跳过周末：日期标签用 toISOString（UTC），星期判断也必须用 UTC 口径，
    // 否则 UTC 负偏移服务器上周末跳过与日期标签错位
    if (current.getUTCDay() !== 0 && current.getUTCDay() !== 6) {
      const daySeed = (seed * current.getDate() * (current.getMonth() + 1)) % 100;
      const change = (daySeed - 50) / 500; // ±10% 波动
      price = price * (1 + change);
      price = Math.max(price, 5);

      const open = price * (1 + ((daySeed % 5) - 2) / 200);
      const high = Math.max(open, price) * (1 + (daySeed % 3) / 100);
      const low = Math.min(open, price) * (1 - (daySeed % 3) / 100);
      const volume = 1000000 + daySeed * 50000;

      data.push({
        date: current.toISOString().split('T')[0],
        open: Math.round(open * 100) / 100,
        high: Math.round(high * 100) / 100,
        low: Math.round(low * 100) / 100,
        close: Math.round(price * 100) / 100,
        volume: Math.round(volume),
      });
    }
    current.setDate(current.getDate() + 1);
  }

  return data;
}

/**
 * 获取基准数据（买入持有）
 */
export function getBenchmarkCurve(data: OHLCVData[]): { date: string; value: number }[] {
  if (data.length === 0) return [];
  const basePrice = data[0].close;
  return data.map((d) => ({
    date: d.date,
    value: Math.round((d.close / basePrice) * 10000) / 100, // 归一化为百分比
  }));
}

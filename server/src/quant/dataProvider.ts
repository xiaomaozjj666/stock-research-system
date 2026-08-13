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
export async function fetchOHLCVData(
  stockCode: string,
  startDate: string,
  endDate: string,
): Promise<OHLCVData[]> {
  // 1. 检查缓存
  const cacheKey = `${stockCode}_${startDate}_${endDate}`;
  const cacheDir = getCacheDir();
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    const age = Date.now() - cached.timestamp;
    if (age < 12 * 60 * 60 * 1000) {
      // 12小时缓存
      return cached.data;
    }
  }

  // 2. 从东方财富获取日K线
  const secid = resolveSecid(stockCode);
  const beg = startDate.replace(/-/g, '');
  const end = endDate.replace(/-/g, '');

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=${beg}&end=${end}&lmt=1000`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
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

      // 写入缓存
      fs.writeFileSync(cacheFile, JSON.stringify({ data, timestamp: Date.now() }));
      return data;
    }
  } catch (error) {
    logger.warn('获取K线数据失败', { stockCode, startDate, endDate, err: error });
  }

  // 3. 降级：生成模拟数据（用于演示）
  // F1.6: 模拟数据标记 isSimulated=true，下游策略引擎应检查此标志
  const simulated = generateSimulatedData(stockCode, startDate, endDate);
  return simulated.map((d) => ({ ...d, isSimulated: true }));
}

/**
 * 生成模拟K线数据（当API不可用时降级使用）
 */
function generateSimulatedData(stockCode: string, startDate: string, endDate: string): OHLCVData[] {
  const data: OHLCVData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  // 基于股票代码生成确定性的"随机"价格
  let price = 50 + (parseInt(stockCode) % 100);
  const seed = parseInt(stockCode.slice(-3));

  const current = new Date(start);
  while (current <= end) {
    // 跳过周末
    if (current.getDay() !== 0 && current.getDay() !== 6) {
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

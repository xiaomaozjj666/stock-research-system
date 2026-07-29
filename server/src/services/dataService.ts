import type { StockInfo, FinancialData, ValuationData } from '../types.js';
import { fetchStockInfo, fetchFinancialData, fetchValuationData } from './dataFetcher.js';
import { MOUTAI_INFO, MOUTAI_FINANCIAL, MOUTAI_VALUATION } from '../data/sampleData.js';
import * as fs from 'fs';
import * as path from 'path';

export interface StockDataSet {
  info: StockInfo;
  financial: FinancialData;
  valuation: ValuationData;
}

const CACHE_DIR = path.join(import.meta.dirname, '..', 'data', 'cache');

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时

export async function getData(stockCode: string): Promise<StockDataSet> {
  // 1. 检查缓存
  const cacheFile = path.join(CACHE_DIR, `${stockCode}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      const cacheAge = Date.now() - cached.timestamp;
      if (cacheAge < CACHE_TTL) {
        return cached.data as StockDataSet;
      }
    } catch {
      // 缓存损坏，忽略
    }
  }

  // 2. 尝试从 API 获取数据
  try {
    const [info, financial, valuation] = await Promise.all([
      fetchStockInfo(stockCode),
      fetchFinancialData(stockCode),
      fetchValuationData(stockCode)
    ]);
    const dataSet: StockDataSet = { info, financial, valuation };

    // 写入缓存
    fs.writeFileSync(cacheFile, JSON.stringify({ data: dataSet, timestamp: Date.now() }, null, 2));
    return dataSet;
  } catch (error) {
    // 3. 降级到 sampleData（仅茅台）
    if (stockCode === '600519') {
      console.warn(`API 获取失败，使用内置样本数据: ${stockCode}`, (error as Error).message);
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

  // 从缓存目录读取已查询过的股票
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const cached = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
        const info = (cached.data as StockDataSet).info;
        stocks.push({ code: info.code, name: info.name, industry: info.industry });
      } catch {
        // 忽略损坏的缓存文件
      }
    }
  }

  // 确保茅台始终在列表中
  if (!stocks.find(s => s.code === '600519')) {
    stocks.unshift({ code: '600519', name: '贵州茅台', industry: '白酒' });
  }

  return stocks;
}

export async function searchStocks(keyword: string): Promise<{ code: string; name: string }[]> {
  try {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await response.json() as {
      QuotationCodeTable?: { Data?: Array<{ MktNum: string; Code: string; Name: string }> };
    };

    if (data.QuotationCodeTable?.Data) {
      return data.QuotationCodeTable.Data
        .filter(item => item.MktNum === '0' || item.MktNum === '1')
        .map(item => ({ code: item.Code, name: item.Name }));
    }
    return [];
  } catch {
    return [];
  }
}

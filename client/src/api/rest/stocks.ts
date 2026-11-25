/**
 * 股票列表与搜索（/api/stocks 系列）。
 */
import type {
  GETApiStocksResponse as StockListResponse,
  GETApiStocksSearchResponse as StockSearchResponse,
} from '../generated';
import { api, normalizeApiError } from './base';

/**
 * /api/stocks 单项。类型来自生成的 GETApiStocksResponse（契约 → generated.ts），
 * 服务端 getSupportedStocks() 返回 { code, name, industry }。
 */
export type StockListItem = StockListResponse[number];

export async function getStockList(): Promise<StockListItem[]> {
  try {
    // 上游失败时服务端回兜底数组而非报错，故返回类型就是数组本身，不需要再包一层
    const response = await api.get<StockListResponse>('/stocks', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取股票列表失败');
  }
}

/** /api/stocks/search 单项。类型来自生成的 GETApiStocksSearchResponse。 */
export type StockSearchHit = StockSearchResponse[number];

export async function searchStocks(
  keyword: string,
  signal?: AbortSignal,
): Promise<StockSearchHit[]> {
  try {
    // 搜索失败时服务端回空数组（200），故调用方的 Array.isArray 兜底是防御性的
    const response = await api.get<StockSearchResponse>('/stocks/search', {
      params: { keyword },
      timeout: 15000,
      signal,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '搜索失败');
  }
}

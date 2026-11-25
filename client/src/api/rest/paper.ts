import type { PaperOrder, PaperOrderInput, PaperPortfolio, PaperStats } from '../../types';
import type { POSTApiPaperSettleResponse as PaperSettleResponse } from '../generated';
import { api, normalizeApiError } from './base';

// === 模拟盘（paper trading）研究闭环 ===
export async function getPaperPortfolio(): Promise<PaperPortfolio> {
  try {
    const response = await api.get<PaperPortfolio>('/paper/portfolio', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '读取模拟盘账户失败');
  }
}

export async function placePaperOrder(body: PaperOrderInput): Promise<{ order: PaperOrder }> {
  try {
    const response = await api.post<{ order: PaperOrder }>('/paper/order', body, {
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '模拟下单失败');
  }
}

export async function settlePaperDay(body: {
  date: string;
  closePrices: Record<string, number>;
  prevClosePrices?: Record<string, number>;
}): Promise<PaperSettleResponse> {
  try {
    // 服务端 latestEquity 取 equity.at(-1)：当日无净值点时缺省，故契约里是可选
    const response = await api.post<PaperSettleResponse>('/paper/settle', body, {
      timeout: 30000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '日终结算失败');
  }
}

export async function getPaperStats(): Promise<PaperStats> {
  try {
    const response = await api.get<PaperStats>('/paper/stats', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '读取模拟盘统计失败');
  }
}

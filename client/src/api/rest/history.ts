import type { HistoryItem, HistorySummary } from '../../types';
import type {
  DELETEApiHistoryIdResponse as DeleteHistoryResponse,
  GETApiHistoryResponse as HistoryListResponse,
} from '../generated';
import { api, normalizeApiError } from './base';

// === 研究历史记录（分析结果自动入库，前端列表/回看/删除） ===
/** 评分/评级时间线单点（与服务端 historyService 的 HistoryTimelinePoint 对齐） */
export interface HistoryTimelinePoint {
  /** YYYY-MM-DD */
  date: string;
  score: number;
  rating: string;
}

/**
 * 历史列表项 = 摘要 + 精简时间线（由旧到新，含当前这条）。
 * 该字段按需返回，仅用于回答"观点怎么变的"；不带时间线时字段缺失（旧数据），
 * 因此是可选的，前端渲染前必须判空。
 */
export type HistoryListItem = HistorySummary & { timeline?: HistoryTimelinePoint[] };

export async function fetchHistoryList(limit = 50): Promise<HistoryListItem[]> {
  try {
    // 泛型是**信封**而不是数组本身：服务端 res.json({ items: [...] })，
    // 少写这一层泛型的话 response.data.items 就是 any，列表元素全无类型
    const response = await api.get<HistoryListResponse>('/history', {
      params: { limit },
      timeout: 15000,
    });
    return response.data.items;
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史记录读取失败');
  }
}

export async function fetchHistoryDetail(id: string): Promise<HistoryItem> {
  try {
    const response = await api.get<HistoryItem>(`/history/${id}`, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史记录读取失败');
  }
}

export async function deleteHistoryItem(id: string): Promise<void> {
  try {
    await api.delete<DeleteHistoryResponse>(`/history/${id}`, { timeout: 15000 });
  } catch (error: unknown) {
    throw normalizeApiError(error, '历史记录删除失败');
  }
}

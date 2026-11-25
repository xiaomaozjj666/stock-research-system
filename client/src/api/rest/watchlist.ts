import type { WatchlistMonitorResult } from '../../types';
import type { GETApiWatchlistResponse as WatchlistResponse } from '../generated';
import { isCancelled } from '../http';
import { api, AnalysisCancelledError, normalizeApiError } from './base';

// === 自选股 / 持仓监控 ===
// 三个端点的响应形状都是 `WatchlistCodes`（{ codes: string[] }）。改用契约生成的
// 类型而非内联字面量：内联字面量与契约没有任何强制关联，契约改了它不会报错
// ——这正是本项目此前反复漂移的那个形态。
export async function getWatchlist(): Promise<WatchlistResponse> {
  try {
    const response = await api.get<WatchlistResponse>('/watchlist', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取自选股失败');
  }
}

export async function addToWatchlist(code: string): Promise<WatchlistResponse> {
  try {
    const response = await api.post<WatchlistResponse>('/watchlist', { code }, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '添加自选股失败');
  }
}

export async function removeFromWatchlist(code: string): Promise<WatchlistResponse> {
  try {
    const response = await api.delete<WatchlistResponse>(`/watchlist/${code}`, {
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '移除自选股失败');
  }
}

/** 对自选股（或指定 codes）批量运行"含最新消息回测" */
export async function runWatchlistNewsBacktest(
  codes?: string[],
  signal?: AbortSignal,
): Promise<import('../../types').WatchlistNewsBacktestReport> {
  try {
    const response = await api.post<import('../../types').WatchlistNewsBacktestReport>(
      '/watchlist/news-backtest',
      { codes: codes ?? [] },
      { timeout: 180000, signal },
    );
    return response.data;
  } catch (error: unknown) {
    if (isCancelled(error)) throw new AnalysisCancelledError('批量回测已取消');
    throw normalizeApiError(error, '自选股批量回测失败');
  }
}

// === 自选股异动监控：重跑批量新闻回测并检出预警 ===
export async function monitorWatchlist(signal?: AbortSignal): Promise<WatchlistMonitorResult> {
  try {
    const response = await api.post<WatchlistMonitorResult>(
      '/watchlist/monitor',
      {},
      {
        timeout: 120000,
        signal,
      },
    );
    return response.data;
  } catch (error: unknown) {
    if (isCancelled(error)) throw new AnalysisCancelledError('监控已取消');
    throw normalizeApiError(error, '自选股监控失败');
  }
}

/**
 * 最近一次异动监控快照（服务端落盘，刷新/复访可回看）。
 *
 * 从未监控过时服务端返回稳定空结构（generatedAt=null、alerts=[]），不会是 404。
 * 此前这里有个 `Omit<..., 'generatedAt'> & { generatedAt: string | null }` 的
 * 放宽类型，是为绕开「WatchlistMonitorResult.generatedAt 被声明成必填 string」
 * 而存在的——而那个声明本身是错的（契约里一直是 nullable）。根因已修，
 * 故此处直接用 WatchlistMonitorResult，不再维护第二份形状。
 */
export type WatchlistAlertsSnapshot = WatchlistMonitorResult;

export async function fetchWatchlistAlerts(): Promise<WatchlistAlertsSnapshot> {
  try {
    const response = await api.get<WatchlistAlertsSnapshot>('/watchlist/alerts', {
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '最近监控记录读取失败');
  }
}

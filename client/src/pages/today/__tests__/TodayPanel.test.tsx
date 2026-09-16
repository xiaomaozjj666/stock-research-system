// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// 打桩 API 层：本页只做聚合展示，不应触发任何真实网络请求
const api = vi.hoisted(() => ({
  fetchWatchlistAlerts: vi.fn(),
  getResearchDigests: vi.fn(),
  getWatchlist: vi.fn(),
  fetchHistoryList: vi.fn(),
}));

vi.mock('../../../api/client', () => ({
  ...api,
  normalizeApiError: (_e: unknown, fallback = '请求失败') => new Error(fallback),
}));

const { default: TodayPanel } = await import('../TodayPanel');

/** 最小可用的历史条目（含时间线，用于算出观点变化） */
function historyItem(over: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    stockCode: '600519',
    stockName: '贵州茅台',
    rating: '优先跟踪',
    totalScore: 82,
    createdAt: '2026-09-16T02:00:00.000Z',
    timeline: [
      { date: '2026-09-10', score: 75, rating: '持续观察' },
      { date: '2026-09-16', score: 82, rating: '优先跟踪' },
    ],
    ...over,
  };
}

describe('TodayPanel 今日聚合', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWatchlist.mockResolvedValue({ codes: ['600519'] });
  });

  it('三块数据源均无内容时，分别给出"如何才会有内容"的指引而不是空白', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.fetchHistoryList.mockResolvedValue([]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/尚未监控过/)).toBeInTheDocument());
    expect(screen.getByText(/暂无明显观点变化/)).toBeInTheDocument();
    expect(screen.getByText(/还没有简报/)).toBeInTheDocument();
  });

  it('有监控快照与观点变化时渲染条目，并按 A 股约定用红色表示评分上升', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({
      generatedAt: '2026-09-16T02:30:00.000Z',
      monitored: 1,
      alerts: [{ code: '600519', name: '贵州茅台', level: 'strong-bull', detail: '放量涨停' }],
    });
    api.getResearchDigests.mockResolvedValue({
      items: [
        {
          id: 'd1',
          createdAt: '2026-09-16T01:00:00.000Z',
          screener: { hitCount: 2, topHits: [{ code: '000858', name: '五粮液' }] },
        },
      ],
    });
    api.fetchHistoryList.mockResolvedValue([historyItem()]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/放量涨停/)).toBeInTheDocument());
    expect(screen.getByText(/覆盖 1 只/)).toBeInTheDocument();

    const delta = screen.getByText('▲ +7');
    expect(delta.className).toContain('val-positive'); // 红涨
    expect(screen.getByText(/初筛命中 2 只/)).toBeInTheDocument();
  });

  it('单个数据源失败只影响自己那一块（不整页空白）', async () => {
    api.fetchWatchlistAlerts.mockRejectedValue(new Error('后端未启动'));
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.fetchHistoryList.mockResolvedValue([historyItem()]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/异动数据读取失败/)).toBeInTheDocument());
    // 其余两块仍正常渲染
    expect(screen.getByText(/暂无明显观点变化|▲ \+7/)).toBeInTheDocument();
    expect(screen.getByText(/还没有简报/)).toBeInTheDocument();
  });

  it('自选股之外的标的评分变化不进"今日"（只看关注股）', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.fetchHistoryList.mockResolvedValue([
      historyItem({ stockCode: '000001', stockName: '平安银行' }),
    ]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/暂无明显观点变化/)).toBeInTheDocument());
    expect(screen.queryByText(/平安银行/)).toBeNull();
  });
});

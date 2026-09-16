// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import WatchlistPage from '../WatchlistPage';
import { ToastProvider } from '../../../components/Toast';

/**
 * 「最近监控」常驻卡片：挂载即读服务端落盘快照。
 * 这条链路是预警能力的触达点——此前 alert 只存在内存里，用户离开页面/刷新就再也看不到。
 */
const api = vi.hoisted(() => ({
  getWatchlist: vi.fn(),
  fetchWatchlistAlerts: vi.fn(),
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
  runWatchlistNewsBacktest: vi.fn(),
  monitorWatchlist: vi.fn(),
  searchStocks: vi.fn(),
  normalizeApiError: vi.fn((_e: unknown, fallback: string) => new Error(fallback)),
}));

// 取消错误类在 mock 工厂内定义：vi.mock 会被提升到文件顶部，顶层 class 会落在 TDZ 里
vi.mock('../../../api/client', () => {
  class AnalysisCancelledError extends Error {}
  return { ...api, AnalysisCancelledError };
});

function renderPage() {
  return render(
    <ToastProvider>
      <WatchlistPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.normalizeApiError.mockImplementation((_e: unknown, fallback: string) => new Error(fallback));
  api.getWatchlist.mockResolvedValue({ codes: ['600519'] });
});

describe('WatchlistPage 最近监控卡片', () => {
  it('从未监控过：显示「尚未监控过」并保留「监控异动」按钮', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/尚未监控过/)).toBeInTheDocument());
    // 无快照时按钮仍在，是用户产生第一份快照的入口
    expect(screen.getByRole('button', { name: '监控异动' })).toBeInTheDocument();
  });

  it('有快照：常驻展示「最近监控：…｜N 条异动」并列出条目（复用既有预警渲染）', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({
      generatedAt: '2026-09-15T02:00:00.000Z',
      monitored: 2,
      alerts: [
        {
          code: '600519',
          name: '贵州茅台',
          level: 'strong-bull',
          polarity: 0.82,
          weightedImpact: 0.44,
          detail: '贵州茅台 新闻姿态强烈看多',
        },
      ],
    });
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText(/最近监控：.*｜1 条异动/)).toBeInTheDocument());
    expect(screen.getByText('贵州茅台 新闻姿态强烈看多')).toBeInTheDocument();
    expect(screen.getByText('强烈看多')).toBeInTheDocument();
    // 条目沿用既有类名与级别配色（未新造一套样式）
    expect(container.querySelector('.watchlist-alert.alert-bull')).not.toBeNull();
  });

  it('快照读失败：提示读取失败，而不是伪装成「从未监控过」', async () => {
    api.fetchWatchlistAlerts.mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() => expect(screen.getByText(/最近监控记录读取失败/)).toBeInTheDocument());
    expect(screen.queryByText(/尚未监控过/)).toBeNull();
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import PaperTradingPage from './PaperTradingPage';

/** 审计日志共 25 条，页大小 20 → 首屏 20 条 + 「加载更多」拿剩下 5 条 */
const h = vi.hoisted(() => {
  const entries = Array.from({ length: 25 }, (_, i) => ({
    id: `a${i}`,
    timestamp: Date.UTC(2026, 0, 1) + i * 60_000,
    sessionId: 's1',
    action: `action-${i}`,
    category: 'tool_call' as const,
    detail: `detail-${i}`,
    riskLevel: 'info' as const,
  }));
  return {
    entries,
    getAuditLog: vi.fn(async (q?: { limit?: number; offset?: number; riskLevel?: string }) => {
      const offset = q?.offset ?? 0;
      const limit = q?.limit ?? entries.length;
      return { count: entries.length, entries: entries.slice(offset, offset + limit) };
    }),
    getPaperPortfolio: vi.fn(async () => ({
      initialCapital: 100000,
      cash: 100000,
      currentDate: '2026-08-08',
      positions: [],
      orders: [],
      equity: [],
    })),
    getPaperStats: vi.fn(async () => ({
      initialCapital: 100000,
      finalEquity: 100000,
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      sharpeRatio: null,
      totalDays: 0,
      dailyReturns: [],
    })),
  };
});

vi.mock('../../api/client', () => ({
  getPaperPortfolio: h.getPaperPortfolio,
  getPaperStats: h.getPaperStats,
  getAuditLog: h.getAuditLog,
  getIntlFundamentals: vi.fn(),
  getIntlKlines: vi.fn(),
  placePaperOrder: vi.fn(),
  settlePaperDay: vi.fn(),
  normalizeApiError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

/** 当前渲染出来的审计行数（详情单元格文案形如 detail-N） */
function renderedRows(): number {
  return screen.queryAllByText(/^detail-/).length;
}

describe('PaperTradingPage 审计日志分页', () => {
  beforeEach(() => {
    h.getAuditLog.mockClear();
  });

  it('显示「共 N 条，当前显示前 M 条」，首屏只取一页', async () => {
    render(<PaperTradingPage />);
    await waitFor(() => expect(screen.getByText(/共 25 条，当前显示前 20 条/)).toBeInTheDocument());
    expect(renderedRows()).toBe(20);
    // 首屏按页取数，而不是静默截断
    expect(h.getAuditLog).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, offset: 0 }));
  });

  it('提供「加载更多」按钮并提示剩余条数', async () => {
    render(<PaperTradingPage />);
    expect(await screen.findByRole('button', { name: /加载更多（还剩 5 条）/ })).toBeEnabled();
  });

  it('点击「加载更多」后追加下一页（不替换已有条目），到末尾按钮消失', async () => {
    render(<PaperTradingPage />);
    const btn = await screen.findByRole('button', { name: /加载更多/ });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByText(/共 25 条，当前显示前 25 条/)).toBeInTheDocument());
    expect(renderedRows()).toBe(25);
    // 第一页条目仍在（追加而非替换）
    expect(screen.getByText('detail-0')).toBeInTheDocument();
    expect(screen.getByText('detail-24')).toBeInTheDocument();
    // 已到末尾：按钮消失
    expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull();
    // 第二次请求按 offset 取下一页
    expect(h.getAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, offset: 20 }),
    );
  });

  it('总数不超过一页时不显示「加载更多」', async () => {
    h.getAuditLog.mockImplementationOnce(async () => ({
      count: h.entries.slice(0, 8).length,
      entries: h.entries.slice(0, 8),
    }));
    render(<PaperTradingPage />);
    await waitFor(() => expect(screen.getByText(/共 8 条，当前显示前 8 条/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull();
  });

  it('无审计条目时保持空状态且不显示总数行外的按钮', async () => {
    h.getAuditLog.mockImplementationOnce(async () => ({ count: 0, entries: [] }));
    render(<PaperTradingPage />);
    await waitFor(() => expect(screen.getByText('暂无审计条目')).toBeInTheDocument());
    expect(screen.getByText(/共 0 条，当前显示前 0 条/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull();
  });

  it('同帧连点两次「加载更多」：只发一次请求，且 offset 不会重复取同一页', async () => {
    // 第一次「加载更多」挂在途：按钮的 disabled 要等 React 提交才生效，挡不住同帧第二次点击
    let resolveMore!: (v: unknown) => void;
    h.getAuditLog
      .mockImplementationOnce(async (q?: { limit?: number; offset?: number }) => ({
        count: h.entries.length,
        entries: h.entries.slice(q?.offset ?? 0, (q?.offset ?? 0) + (q?.limit ?? 20)),
      }))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveMore = resolve)));
    render(<PaperTradingPage />);
    const btn = await screen.findByRole('button', { name: /加载更多/ });

    fireEvent.click(btn);
    fireEvent.click(btn);
    // 第二次点击必须被入口守卫拦掉（否则 offset 会是上一次渲染的快照 20，取回同一页）
    expect(h.getAuditLog).toHaveBeenCalledTimes(2); // 首屏 + 唯一一次加载更多

    await act(async () => {
      resolveMore({ count: h.entries.length, entries: h.entries.slice(20) });
    });

    // 最后一页真的取到了：总数与条数都到位，按钮消失
    await waitFor(() => expect(screen.getByText(/共 25 条，当前显示前 25 条/)).toBeInTheDocument());
    expect(renderedRows()).toBe(25);
    expect(screen.getByText('detail-24')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull();
    expect(h.getAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, offset: 20 }),
    );
  });
});

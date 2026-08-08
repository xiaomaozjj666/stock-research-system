// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PaperTradingPage from './PaperTradingPage';
import { getPaperPortfolio } from '../../api/client';

vi.mock('../../api/client', () => ({
  getPaperPortfolio: vi.fn(async () => ({
    initialCapital: 100000,
    cash: 80000,
    currentDate: '2026-08-08',
    positions: [{ code: '600519', quantity: 100, avgCost: 1800, buyDate: '2026-08-07' }],
    orders: [],
    equity: [{ date: '2026-08-08', value: 98000 }],
  })),
  getPaperStats: vi.fn(async () => ({
    initialCapital: 100000,
    finalEquity: 98000,
    totalReturnPct: -2,
    maxDrawdownPct: 2,
    sharpeRatio: null,
    totalDays: 1,
    dailyReturns: [],
  })),
  getAuditLog: vi.fn(async () => ({ count: 0, entries: [] })),
  getIntlFundamentals: vi.fn(),
  placePaperOrder: vi.fn(),
  settlePaperDay: vi.fn(),
  normalizeApiError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

describe('PaperTradingPage', () => {
  it('渲染账户概览、统计卡与持仓', async () => {
    render(<PaperTradingPage />);
    expect(screen.getByText('模拟盘')).toBeInTheDocument();
    // 持仓代码同时出现在持仓表与结算表单中
    await waitFor(() => expect(screen.getAllByText('600519').length).toBeGreaterThan(0));
    expect(screen.getByText('持仓')).toBeInTheDocument();
    expect(screen.getByText('累计收益')).toBeInTheDocument();
    expect(screen.getAllByText('日终结算').length).toBeGreaterThan(0);
  });

  it('无持仓时显示空状态', async () => {
    vi.mocked(getPaperPortfolio).mockResolvedValueOnce({
      initialCapital: 100000,
      cash: 100000,
      currentDate: '2026-08-08',
      positions: [],
      orders: [],
      equity: [],
    });
    render(<PaperTradingPage />);
    await waitFor(() => expect(screen.getByText('暂无持仓')).toBeInTheDocument());
    expect(screen.getByText('当前无持仓，结算仅记录当日净值。')).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import HistoryPage from './HistoryPage';

vi.mock('../../api/client', () => ({
  fetchHistoryList: vi.fn(async () => [
    {
      id: 'h1',
      stockCode: '600519',
      stockName: '贵州茅台',
      createdAt: '2026-08-14T10:00:00Z',
      rating: '优先跟踪',
      totalScore: 92,
      industry: '白酒',
    },
    {
      id: 'h2',
      stockCode: '000001',
      stockName: '平安银行',
      createdAt: '2026-08-14T09:00:00Z',
      rating: '持续观察',
      totalScore: 60,
    },
  ]),
  fetchHistoryDetail: vi.fn(async (id: string) => ({
    id,
    stockCode: '600519',
    stockName: '贵州茅台',
    createdAt: '2026-08-14T10:00:00Z',
    rating: '优先跟踪',
    totalScore: 92,
    result: { stock_pool: [{ stock_code: '600519' }] },
  })),
  deleteHistoryItem: vi.fn(async () => {}),
}));

import { fetchHistoryList, fetchHistoryDetail, deleteHistoryItem } from '../../api/client';

describe('HistoryPage 研究历史', () => {
  beforeEach(() => {
    vi.mocked(fetchHistoryList).mockClear();
    vi.mocked(fetchHistoryDetail).mockClear();
    vi.mocked(deleteHistoryItem).mockClear();
  });

  it('渲染历史列表（股票/评级/评分/时间）', async () => {
    render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());
    expect(screen.getByText('600519')).toBeInTheDocument();
    expect(screen.getByText('优先跟踪')).toBeInTheDocument();
    expect(screen.getByText('平安银行')).toBeInTheDocument();
    expect(screen.getByText('评分 92')).toBeInTheDocument();
  });

  it('点击查看 → 拉取详情并回调完整结果', async () => {
    const onOpen = vi.fn();
    render(<HistoryPage onOpenHistory={onOpen} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: '查看' })[0]);

    await waitFor(() => {
      expect(fetchHistoryDetail).toHaveBeenCalledWith('h1');
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ stock_pool: [{ stock_code: '600519' }] }),
      );
    });
  });

  it('点击删除 → 调删除接口并从列表移除', async () => {
    render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);

    await waitFor(() => {
      expect(deleteHistoryItem).toHaveBeenCalledWith('h1');
      expect(screen.queryByText('贵州茅台')).not.toBeInTheDocument();
      expect(screen.getByText('平安银行')).toBeInTheDocument();
    });
  });
});

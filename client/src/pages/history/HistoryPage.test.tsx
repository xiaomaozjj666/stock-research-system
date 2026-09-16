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

  it('点击删除需二次确认（防误删），确认后调接口并从列表移除', async () => {
    render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    const delBtn = screen.getAllByRole('button', { name: '删除' })[0];
    // 第一次点击：进入确认态，不调用接口
    fireEvent.click(delBtn);
    expect(deleteHistoryItem).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认删除？' })).toBeInTheDocument();

    // 第二次点击：真正删除
    fireEvent.click(screen.getByRole('button', { name: '确认删除？' }));

    await waitFor(() => {
      expect(deleteHistoryItem).toHaveBeenCalledWith('h1');
      expect(screen.queryByText('贵州茅台')).not.toBeInTheDocument();
      expect(screen.getByText('平安银行')).toBeInTheDocument();
    });
  });
});

/**
 * 评分时间线：去重覆盖后仍能回答"观点怎么变的"。
 * 时间线是可选字段——旧数据没有它，渲染必须与"有时间线"一样正常（不报错、不出现空括号）。
 */
describe('HistoryPage 评分时间线', () => {
  function itemWith(timeline?: { date: string; score: number; rating: string }[]) {
    return [
      {
        id: 'h1',
        stockCode: '600519',
        stockName: '贵州茅台',
        createdAt: '2026-09-10T02:00:00Z',
        rating: '优先跟踪',
        totalScore: timeline && timeline.length > 0 ? timeline[timeline.length - 1].score : 87,
        ...(timeline ? { timeline } : {}),
      },
    ];
  }

  it('时间线上涨：显示 ▲ +N，用红（val-positive，A 股红涨语义）', async () => {
    vi.mocked(fetchHistoryList).mockResolvedValueOnce(
      itemWith([
        { date: '2026-08-01', score: 80, rating: '持续观察' },
        { date: '2026-09-10', score: 87, rating: '优先跟踪' },
      ]) as never,
    );
    const { container } = render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    const badge = container.querySelector('.val-positive');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe(' ▲ +7');
    expect(badge).toHaveAttribute('title', '较上次分析（2026-08-01）');
    expect(container.querySelector('.val-negative')).toBeNull();
  });

  it('时间线下跌：显示 ▼ -N，用绿（val-negative）', async () => {
    vi.mocked(fetchHistoryList).mockResolvedValueOnce(
      itemWith([
        { date: '2026-08-01', score: 80, rating: '持续观察' },
        { date: '2026-09-10', score: 62, rating: '谨慎观望' },
      ]) as never,
    );
    const { container } = render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    const badge = container.querySelector('.val-negative');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe(' ▼ -18');
  });

  it('无时间线（旧数据）：正常渲染评分，不出现变化量、也不出现空括号', async () => {
    const { container } = render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    expect(screen.getByText('评分 92')).toBeInTheDocument();
    expect(container.querySelector('.val-positive')).toBeNull();
    expect(container.querySelector('.val-negative')).toBeNull();
    expect(container.querySelector('.val-neutral')).toBeNull();
    expect(container.textContent).not.toContain('▲');
    expect(container.textContent).not.toContain('▼');
    expect(container.textContent).not.toContain('()');
  });

  it('时间线只有 1 个点（首次分析）：同样不渲染变化量', async () => {
    vi.mocked(fetchHistoryList).mockResolvedValueOnce(
      itemWith([{ date: '2026-09-10', score: 87, rating: '优先跟踪' }]) as never,
    );
    const { container } = render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    expect(screen.getByText('评分 87')).toBeInTheDocument();
    expect(container.querySelector('.val-positive')).toBeNull();
    expect(container.querySelector('.val-neutral')).toBeNull();
  });

  it('评分持平：显示「持平」而非 +0/-0', async () => {
    vi.mocked(fetchHistoryList).mockResolvedValueOnce(
      itemWith([
        { date: '2026-08-01', score: 87, rating: '优先跟踪' },
        { date: '2026-09-10', score: 87, rating: '优先跟踪' },
      ]) as never,
    );
    const { container } = render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    const badge = container.querySelector('.val-neutral');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe(' — 持平');
  });
});

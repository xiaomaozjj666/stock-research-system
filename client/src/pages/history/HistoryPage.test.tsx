// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
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

/** 永不 settle / 可手动 settle 的桩 */
function pending<T = unknown>(): Promise<T> {
  return new Promise<T>(() => {});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function detailFor(id: string) {
  return { id, stockCode: '600519', stockName: '贵州茅台', result: { stock_pool: [{ id }] } };
}

function openButtons(): HTMLElement[] {
  return screen.getAllByRole('button', { name: '查看' });
}

/** 取某只股票所在行的按钮（一次删除确认后按钮文案会变，不能再用全局 name 选择器取第二行） */
function rowButtons(stockName: string, buttonName: string): HTMLElement {
  const row = screen.getByText(stockName).closest('li') as HTMLElement;
  return within(row).getByRole('button', { name: buttonName });
}

/**
 * 「查看」的请求序号守卫。
 * 背景：先点 A（慢）再点 B，A 的响应后到会把 B 的报告顶掉——用户看到的是 A 的报告
 * 却以为是自己刚点的 B。
 */
describe('HistoryPage 查看的请求序号', () => {
  beforeEach(() => {
    vi.mocked(fetchHistoryList).mockClear();
    vi.mocked(fetchHistoryDetail).mockReset();
    vi.mocked(deleteHistoryItem).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('先慢后快：只采纳最后一次点击的结果，迟到的旧响应被丢弃', async () => {
    const slowA = deferred<never>();
    const slowB = deferred<never>();
    vi.mocked(fetchHistoryDetail)
      .mockReturnValueOnce(slowA.promise as never)
      .mockReturnValueOnce(slowB.promise as never);
    const onOpen = vi.fn();
    render(<HistoryPage onOpenHistory={onOpen} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    fireEvent.click(openButtons()[0]); // h1（慢）
    expect(fetchHistoryDetail).toHaveBeenCalledWith('h1');

    // h1 的按钮此刻已禁用；直接点另一行的「查看」发第二次请求，
    // 复现「用户等不及换了另一只」——A 仍在途、B 也发了出去
    onOpen.mockClear();
    fireEvent.click(openButtons()[0]); // 此时列表里唯一可点的「查看」是 h2
    expect(fetchHistoryDetail).toHaveBeenCalledWith('h2');

    // B 先返回 → 采纳
    await act(async () => {
      slowB.resolve(detailFor('h2') as never);
    });
    expect(onOpen).toHaveBeenLastCalledWith({ stock_pool: [{ id: 'h2' }] });

    // A 迟到 → 必须被序号守卫丢弃，不得覆盖 B 的报告
    await act(async () => {
      slowA.resolve(detailFor('h1') as never);
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalledWith({ stock_pool: [{ id: 'h1' }] });
  });

  it('拉取途中按钮显示「打开中…」并禁用，防止同一行被连点', async () => {
    vi.mocked(fetchHistoryDetail).mockReturnValue(pending() as never);
    render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    fireEvent.click(openButtons()[0]); // h1 的「查看」：在途，永不返回

    // 该行按钮就地变成「打开中…」并禁用，同一次请求不可能被连点第二次
    const opening = screen.getByRole('button', { name: '打开中…' });
    expect(opening).toBeDisabled();
    fireEvent.click(opening);
    expect(fetchHistoryDetail).toHaveBeenCalledTimes(1);
    // 另一行不受影响，仍可正常打开
    expect(screen.getAllByRole('button', { name: '查看' })).toHaveLength(1);
  });
});

/**
 * 资源与并发删除。
 * 背景：二次确认的 3 秒 setTimeout 卸载时未清理（切页后仍对已卸载组件 setState）；
 * 并发删除共用一个 deletingId，A 的 finally 会清掉 B 的「删除中…」。
 */
describe('HistoryPage 资源与并发删除', () => {
  beforeEach(() => {
    vi.mocked(fetchHistoryList).mockClear();
    vi.mocked(fetchHistoryDetail).mockClear();
    vi.mocked(deleteHistoryItem).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('二次确认的 3 秒定时器在卸载时被清掉：切页后不再对已卸载组件 setState', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount } = render(<HistoryPage onOpenHistory={() => {}} />);
      await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

      vi.useFakeTimers();
      fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
      expect(screen.getByRole('button', { name: '确认删除？' })).toBeInTheDocument();

      unmount();
      // 卸载后定时器仍会到点：未清理时这里会对已卸载组件 setState 并触发 React 警告
      act(() => {
        vi.advanceTimersByTime(5000);
      });

      const mentionsUnmounted = errSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && /unmounted|not wrapped in act/i.test(a)),
      );
      expect(mentionsUnmounted).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('并发删除两行：A 的收尾不会清掉 B 的「删除中…」', async () => {
    const a = deferred<never>();
    const b = deferred<never>();
    vi.mocked(deleteHistoryItem)
      .mockReturnValueOnce(a.promise as never)
      .mockReturnValueOnce(b.promise as never);
    render(<HistoryPage onOpenHistory={() => {}} />);
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());

    // h1：两次点击完成确认 → 真正删除（在途）
    fireEvent.click(rowButtons('贵州茅台', '删除'));
    fireEvent.click(rowButtons('贵州茅台', '确认删除？'));
    expect(vi.mocked(deleteHistoryItem)).toHaveBeenCalledTimes(1);

    // h2：同样进入确认并删除（在途）
    fireEvent.click(rowButtons('平安银行', '删除'));
    fireEvent.click(rowButtons('平安银行', '确认删除？'));
    expect(vi.mocked(deleteHistoryItem)).toHaveBeenCalledTimes(2);

    // h1 先返回 → 只剩 h2 处于删除中；共用一个 deletingId 时 h1 的 finally 会把 h2 也解禁
    await act(async () => {
      a.resolve(undefined as never);
    });
    expect(screen.queryByText('贵州茅台')).toBeNull();
    expect(screen.getByRole('button', { name: '删除中…' })).toBeDisabled();

    await act(async () => {
      b.resolve(undefined as never);
    });
    expect(screen.queryByRole('button', { name: '删除中…' })).toBeNull();
    expect(screen.getByText('暂无研究历史。')).toBeInTheDocument();
  });
});

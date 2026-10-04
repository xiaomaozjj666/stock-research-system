// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { useQuery } from '../useQuery';

/**
 * useQuery 的行为契约：三态可见、迟到响应不覆盖新数据、卸载后不再写状态。
 * 全部打在真实渲染出的文字/role 上，不做内部状态窥探。
 */

/** 把受控 promise 暴露给用例，用来制造"慢请求后到"的乱序场景 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Probe({
  fetcher,
  deps = [],
  onSettled,
}: {
  fetcher: (signal: AbortSignal) => Promise<string>;
  deps?: readonly unknown[];
  onSettled?: (error: unknown) => void;
}) {
  const { data, loading, error, reload } = useQuery(fetcher, deps, { onSettled });
  return (
    <div>
      <span role="status">{loading ? '加载中' : '空闲'}</span>
      <span data-testid="data">{data ?? '无数据'}</span>
      <span role="alert">{error ? `出错了：${(error as Error).message}` : '无错误'}</span>
      <button onClick={reload}>重跑</button>
    </div>
  );
}

describe('useQuery', () => {
  it('挂载即拉取：加载中 → 拿到数据 → 空闲', async () => {
    const fetcher = vi.fn(async () => '贵州茅台');
    render(<Probe fetcher={fetcher} />);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('加载中');

    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('贵州茅台'));
    expect(screen.getByRole('status')).toHaveTextContent('空闲');
  });

  it('失败：错误上屏且不吞掉原始信息', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('Network Error');
    });
    render(<Probe fetcher={fetcher} />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('出错了：Network Error'),
    );
    expect(screen.getByRole('status')).toHaveTextContent('空闲');
  });

  it('乱序保护：先发的慢请求后到，不得覆盖后发请求的结果', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const queue = [first.promise, second.promise];
    const fetcher = vi.fn(() => queue.shift()!);
    render(<Probe fetcher={fetcher} />);

    // 第二次请求：点「重跑」发起
    fireEvent.click(screen.getByRole('button', { name: '重跑' }));

    // 后发的请求先回
    await act(async () => {
      second.resolve('第二次的结果');
      await second.promise;
    });
    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('第二次的结果'));

    // 先发的慢请求此刻才回 —— 若无序号保护，它会把界面打回旧结果
    await act(async () => {
      first.resolve('第一次的过期结果');
      await first.promise;
    });
    expect(screen.getByTestId('data')).toHaveTextContent('第二次的结果');
  });

  it('卸载后中止在途请求，且不再写状态', async () => {
    const seen: AbortSignal[] = [];
    const pending = deferred<string>();
    const fetcher = vi.fn((signal: AbortSignal) => {
      seen.push(signal);
      return pending.promise;
    });
    const { unmount } = render(<Probe fetcher={fetcher} />);

    unmount();
    expect(seen[0].aborted).toBe(true);

    // 卸载后才 resolve：不应抛错（没有"对已卸载组件 setState"）
    await act(async () => {
      pending.resolve('迟到的数据');
      await pending.promise;
    });
    expect(screen.queryByTestId('data')).toBeNull();
  });

  it('onSettled：成功传 null、失败传原始错误', async () => {
    const onSettled = vi.fn();
    const ok = vi.fn(async () => 'ok');
    const { unmount } = render(<Probe fetcher={ok} onSettled={onSettled} />);
    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('ok'));
    expect(onSettled).toHaveBeenCalledWith(null);
    unmount();

    const onSettled2 = vi.fn();
    const bad = vi.fn(async () => {
      throw new Error('boom');
    });
    render(<Probe fetcher={bad} onSettled={onSettled2} />);
    await waitFor(() =>
      expect(onSettled2).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' })),
    );
  });

  it('deps 变化时自动重跑', async () => {
    const fetcher = vi.fn(async () => '结果');
    function WithDeps() {
      const [n, setN] = useState(0);
      useQuery(fetcher, [n]);
      return <button onClick={() => setN((v) => v + 1)}>改依赖</button>;
    }
    render(<WithDeps />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '改依赖' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider, useToast } from '../Toast';

function Trigger({
  onShow,
}: {
  onShow: (show: (msg: string, type?: 'success' | 'info' | 'error') => void) => void;
}) {
  const { showToast } = useToast();
  return <button onClick={() => onShow(showToast)}>触发</button>;
}

function setup() {
  let show: ((msg: string, type?: 'success' | 'info' | 'error') => void) | null = null;
  render(
    <ToastProvider>
      <Trigger
        onShow={(fn) => {
          show = fn;
        }}
      />
    </ToastProvider>,
  );
  // 触发一次点击：onShow 回调把 showToast 暴露出来
  fireEvent.click(screen.getByText('触发'));
  return { show: () => show! };
}

describe('Toast 轻提示', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('显示成功提示并自动消失（2.5s）', () => {
    const { show } = setup();
    act(() => show()('操作成功'));
    expect(screen.getByText(/操作成功/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2600));
    expect(screen.queryByText(/操作成功/)).not.toBeInTheDocument();
  });

  it('error 类型带警示图标前缀', () => {
    const { show } = setup();
    act(() => show()('出错了', 'error'));
    expect(screen.getByText(/⚠️/)).toBeInTheDocument();
    expect(screen.getByText(/出错了/)).toBeInTheDocument();
  });

  it('可手动关闭', () => {
    const { show } = setup();
    act(() => show()('可关闭的提示'));
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByText(/可关闭的提示/)).not.toBeInTheDocument();
  });

  it('最多同时保留 4 条（超出丢弃最旧的）', () => {
    const { show } = setup();
    for (let i = 1; i <= 5; i++) {
      act(() => show()(`提示 ${i}`));
    }
    expect(screen.queryByText(/提示 1/)).not.toBeInTheDocument(); // 最旧被挤掉
    for (let i = 2; i <= 5; i++) {
      expect(screen.getByText(new RegExp(`提示 ${i}`))).toBeInTheDocument();
    }
  });
});

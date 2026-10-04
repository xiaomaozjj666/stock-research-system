// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApiTokenBar } from '../ApiTokenBar';
import { getApiToken } from '../../api/auth';

/**
 * 解锁条的契约：
 *  1. visible=false 时**完全不渲染**——本系统默认不鉴权，绝大多数用户不该看到它；
 *  2. 提交后令牌落 localStorage；
 *  3. 输入框默认掩码，避免令牌在屏幕上/录屏里直接暴露。
 */

beforeEach(() => {
  localStorage.clear();
  // 提交会触发整页重载（window.location.reload），jsdom 未实现它会打噪声日志
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: vi.fn() },
  });
});

describe('ApiTokenBar', () => {
  it('visible=false 时不渲染任何东西', () => {
    const { container } = render(<ApiTokenBar visible={false} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('visible=true 时渲染输入框与解锁按钮', () => {
    render(<ApiTokenBar visible onDismiss={vi.fn()} />);
    expect(screen.getByLabelText('API 访问令牌')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解锁' })).toBeInTheDocument();
  });

  it('默认掩码显示令牌（避免 shoulder-surfing / 录屏泄露）', () => {
    render(<ApiTokenBar visible onDismiss={vi.fn()} />);
    expect(screen.getByLabelText('API 访问令牌')).toHaveAttribute('type', 'password');
  });

  it('点「显示」后切换为明文，再点恢复掩码', () => {
    render(<ApiTokenBar visible onDismiss={vi.fn()} />);
    const input = screen.getByLabelText('API 访问令牌');
    fireEvent.click(screen.getByRole('button', { name: '显示令牌' }));
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: '隐藏令牌' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('提交后令牌写入 localStorage（trim 过）', () => {
    render(<ApiTokenBar visible onDismiss={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('API 访问令牌'), { target: { value: '  tok-xyz  ' } });
    fireEvent.click(screen.getByRole('button', { name: '解锁' }));
    expect(getApiToken()).toBe('tok-xyz');
  });

  it('空令牌不写入（避免把空值当成已解锁）', () => {
    render(<ApiTokenBar visible onDismiss={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('API 访问令牌'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '解锁' }));
    expect(getApiToken()).toBeNull();
  });

  it('「清除」会抹掉已存令牌并通知上层收起', () => {
    localStorage.setItem('srs:api-token', 'old-token');
    const onDismiss = vi.fn();
    render(<ApiTokenBar visible onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(getApiToken()).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('回车提交（form onSubmit）也能写入令牌', () => {
    render(<ApiTokenBar visible onDismiss={vi.fn()} />);
    const input = screen.getByLabelText('API 访问令牌');
    fireEvent.change(input, { target: { value: 'tok-enter' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(getApiToken()).toBe('tok-enter');
  });
});

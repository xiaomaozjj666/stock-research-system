// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

/**
 * 出错组件：throw 与否由一个可变开关控制，
 * 「重试渲染」按钮必须重新挂载子组件而不是只翻状态位——否则这条用例不会变绿。
 */
let shouldThrow = true;
function Bomb({ message = '行情接口超时' }: { message?: string }) {
  if (shouldThrow) throw new Error(message);
  return <p>恢复后的正常内容</p>;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  shouldThrow = true;
  // React 18 自己也会把捕获到的错误打到 console.error，这里静音以便断言 ErrorBoundary 自己的那份日志
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ErrorBoundary 渲染兜底', () => {
  it('未出错时原样渲染子节点，不出现任何兜底 UI', () => {
    shouldThrow = false;
    render(
      <ErrorBoundary label="财务分析">
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByText('恢复后的正常内容')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试渲染' })).toBeNull();
  });

  it('子组件抛错：以 alert 展示「板块名 + 渲染异常」与真实错误消息', () => {
    render(
      <ErrorBoundary label="财务分析">
        <Bomb message="cashFlow 字段缺失" />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('财务分析渲染异常');
    expect(screen.getByRole('heading', { name: '财务分析渲染异常' })).toBeInTheDocument();
    // 错误消息本身要露出来，否则用户与排查者都只看到一句「渲染异常」
    expect(alert).toHaveTextContent('cashFlow 字段缺失');
    expect(screen.getByText('cashFlow 字段缺失')).toHaveClass('error-boundary-msg');
  });

  it('未传 label 时标题落到「组件渲染异常」，不出现 undefined', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: '组件渲染异常' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('undefined');
  });

  it('level=app：标题为「页面渲染异常」，并提供「刷新页面」整页恢复入口', () => {
    render(
      <ErrorBoundary level="app" label="应用">
        <Bomb message="初始化失败" />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: '页面渲染异常' })).toBeInTheDocument();
    // 整页级兜底才带 app 专属样式类
    expect(screen.getByRole('alert')).toHaveClass('error-boundary-app');

    // jsdom 的 window.location.reload 是 [LegacyUnforgeable] 的不可重定义 own 属性，
    // 无法用 vi.spyOn 观察；这里整块替换 globalThis.window（它是可配置的普通属性），
    // 以便断言「刷新页面」确实触发了一次整页刷新，而不是只画了个按钮。
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    fireEvent.click(screen.getByRole('button', { name: '刷新页面' }));
    vi.unstubAllGlobals();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('区块级（默认）不提供「刷新页面」，只提供「重试渲染」', () => {
    render(
      <ErrorBoundary label="风险清单">
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: '重试渲染' })).toBeInTheDocument();
    // 单个区块出错不该诱导用户整页刷新（会丢掉其它已渲染内容）
    expect(screen.queryByRole('button', { name: '刷新页面' })).toBeNull();
    expect(screen.getByRole('alert')).not.toHaveClass('error-boundary-app');
  });

  it('传入自定义 fallback 时优先渲染它，不再渲染默认兜底', () => {
    render(
      <ErrorBoundary label="核心摘要" fallback={<p>该模块暂不可用</p>}>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByText('该模块暂不可用')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试渲染' })).toBeNull();
  });

  it('点击「重试渲染」重新挂载子组件：条件恢复后内容回来，错误提示消失', () => {
    render(
      <ErrorBoundary label="财务分析">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: '重试渲染' }));

    expect(screen.getByText('恢复后的正常内容')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[ErrorBoundary:财务分析]',
      expect.any(Error),
      expect.any(Object),
    );
  });

  it('错误对象没有 message 时兜底显示「未知错误」而非空白', () => {
    render(
      <ErrorBoundary label="数据图表">
        <Bomb message="" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('未知错误')).toBeInTheDocument();
  });

  it('控制台日志带板块名前缀，便于按区块定位（无 label 时退化为 [ErrorBoundary]）', () => {
    const { unmount } = render(
      <ErrorBoundary label="专家观点">
        <Bomb message="观点数据结构异常" />
      </ErrorBoundary>,
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[ErrorBoundary:专家观点]',
      expect.objectContaining({ message: '观点数据结构异常' }),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );

    unmount();
    consoleErrorSpy.mockClear();
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[ErrorBoundary]',
      expect.any(Error),
      expect.any(Object),
    );
  });

  it('开发环境展示组件堆栈 details，供排查是哪个子组件炸的', () => {
    // import.meta.env.DEV 由 Vite 注入；此用例断言的是「DEV 下必须有堆栈入口」这一口径
    expect(import.meta.env.DEV).toBe(true);

    const { container } = render(
      <ErrorBoundary label="跟踪指标">
        <Bomb />
      </ErrorBoundary>,
    );

    const details = container.querySelector('details.error-boundary-stack');
    expect(details).not.toBeNull();
    expect(screen.getByText('查看组件堆栈（仅开发环境）')).toBeInTheDocument();
    // 堆栈内容来自 React 的 componentStack，必须真写进 <pre> 而不是空壳
    expect(details?.querySelector('pre')?.textContent).toContain('Bomb');
  });
});

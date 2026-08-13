import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** 出错区块名称，便于用户和日志定位 */
  label?: string;
  /** 整页级别的兜底：展示更完整的恢复入口 */
  level?: 'section' | 'app';
}
interface State {
  hasError: boolean;
  error?: Error;
  componentStack?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 保留完整堆栈，方便排查；生产环境可在此接入前端监控上报
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  private reset = () =>
    this.setState({ hasError: false, error: undefined, componentStack: undefined });

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const isApp = this.props.level === 'app';
    const message = this.state.error?.message || '未知错误';

    return (
      <div className={`error-boundary-fallback${isApp ? ' error-boundary-app' : ''}`} role="alert">
        <h3>{isApp ? '页面渲染异常' : `${this.props.label ?? '组件'}渲染异常`}</h3>
        <p className="error-boundary-msg">{message}</p>
        {import.meta.env.DEV && this.state.componentStack && (
          <details className="error-boundary-stack">
            <summary>查看组件堆栈（仅开发环境）</summary>
            <pre>{this.state.componentStack}</pre>
          </details>
        )}
        <div className="error-boundary-actions">
          <button onClick={this.reset}>重试渲染</button>
          {isApp && <button onClick={() => window.location.reload()}>刷新页面</button>}
        </div>
      </div>
    );
  }
}

// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import EChart from '../EChart';

// mock 按需 echarts：init 返回可控实例（真实 echarts 在 jsdom 下无法 init）
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../lib/echarts', () => ({
  default: { init: echartsMock.init },
}));

// jsdom 无 ResizeObserver，EChart 挂载时用到
class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe('EChart 轻量封装（替代 echarts-for-react）', () => {
  let chart: {
    setOption: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue(chart);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  it('挂载时 init 并应用 option（增量合并 + 指定组件 replaceMerge）', () => {
    render(<EChart option={{ a: 1 }} style={{ height: 280 }} />);
    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    // notMerge:false 让图表按组件增量更新而非整图重建；replaceMerge 兜住"系列数变少"的场景
    // （例如关掉 MACD 后旧系列必须被移除）
    expect(chart.setOption).toHaveBeenCalledWith(
      { a: 1 },
      { notMerge: false, replaceMerge: ['series', 'xAxis', 'yAxis', 'grid', 'dataZoom'] },
    );
  });

  it('option 内容不变时（新对象引用）不重复 setOption（滚动重渲染防抖）', () => {
    const { rerender } = render(<EChart option={{ a: 1 }} />);
    expect(chart.setOption).toHaveBeenCalledTimes(1);
    // 父组件重渲染会重建 option 对象，但 JSON 内容相同 → 跳过重绘
    rerender(<EChart option={{ a: 1 }} />);
    rerender(<EChart option={{ a: 1, b: undefined }} />); // 序列化后相同
    expect(chart.setOption).toHaveBeenCalledTimes(1);
  });

  it('option 内容变化时增量 setOption', () => {
    const { rerender } = render(<EChart option={{ a: 1 }} />);
    rerender(<EChart option={{ a: 2 }} />);
    expect(chart.setOption).toHaveBeenLastCalledWith(
      { a: 2 },
      { notMerge: false, replaceMerge: ['series', 'xAxis', 'yAxis', 'grid', 'dataZoom'] },
    );
  });

  it('传入 ariaLabel 时给出 role=img 的文本替代；不传则不生成空名元素', () => {
    const { container, rerender } = render(<EChart option={{}} ariaLabel="回测权益曲线" />);
    const labeled = container.querySelector('[role="img"]');
    expect(labeled?.getAttribute('aria-label')).toBe('回测权益曲线');

    // 不传时不应留下"有名无实"的 role=img（读屏会念"图像"却无内容）
    rerender(<EChart option={{}} />);
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it('卸载时 dispose 图表实例（防泄漏）', () => {
    const { unmount } = render(<EChart option={{}} />);
    unmount();
    expect(chart.dispose).toHaveBeenCalledTimes(1);
  });

  it('onChartReady 回调拿到初始化后的实例', () => {
    const ready = vi.fn();
    render(<EChart option={{}} onChartReady={ready} />);
    expect(ready).toHaveBeenCalledWith(chart);
  });

  it('StrictMode 双挂载下 option 仍被应用（回归：内容比较需在卸载时重置）', () => {
    // main.tsx 用 <React.StrictMode>：开发模式组件会 mount→unmount→remount。
    // 若 prevOptionKeyRef 在卸载时不重置，二次挂载的新实例会因"内容相同"跳过
    // setOption 而渲染空白图表（曾导致"可视化分析看不到图"）。
    render(
      <StrictMode>
        <EChart option={{ a: 1 }} />
      </StrictMode>,
    );
    expect(echartsMock.init).toHaveBeenCalledTimes(2); // 双挂载
    expect(chart.setOption).toHaveBeenCalledTimes(2); // 每次挂载都应用 option
  });
});

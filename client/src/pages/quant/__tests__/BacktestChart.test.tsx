// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import BacktestChart from '../BacktestChart';
import { CHART_COLOR } from '../../../lib/colors';
import type { BacktestResult } from '../types';

// mock 按需 echarts：init 返回可控实例（真实 echarts 在 jsdom 下无法 init）
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../../lib/echarts', () => ({
  default: { init: echartsMock.init },
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

function makeData(over: Partial<BacktestResult> = {}): BacktestResult {
  return {
    totalReturn: 12.34,
    annualizedReturn: 8.5,
    sharpeRatio: 1.42,
    maxDrawdown: -9.87,
    winRate: 55.5,
    tradeCount: 24,
    profitFactor: 1.8,
    equityCurve: [
      { date: '2024-01-02', value: 1 },
      { date: '2024-02-02', value: 1.12 },
    ],
    trades: [],
    benchmark: [
      { date: '2024-01-02', value: 1 },
      { date: '2024-02-02', value: 1.05 },
    ],
    ...over,
  };
}

/** 指标卡：label → 数值元素的 class */
function toneOf(label: string): string {
  const card = screen.getByText(label).parentElement as HTMLElement;
  return (card.querySelector('.quant-metric-value') as HTMLElement).className;
}

describe('BacktestChart —— 生命周期统一到 EChart', () => {
  let setOption: ReturnType<typeof vi.fn>;
  let chart: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    setOption = vi.fn();
    chart = {
      setOption,
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    };
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue(chart);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('由 EChart 初始化一次（不再自己 init），容器样式类名不变', () => {
    const { container } = render(<BacktestChart data={makeData()} />);
    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.quant-chart')).not.toBeNull();
    expect(setOption).toHaveBeenCalledTimes(1);
  });

  it('不再监听 window resize（resize 交给 EChart 的 ResizeObserver）', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    render(<BacktestChart data={makeData()} />);
    const resizeCalls = addSpy.mock.calls.filter((c) => c[0] === 'resize');
    expect(resizeCalls).toHaveLength(0);
    addSpy.mockRestore();
  });

  it('数据变化时复用同一实例增量 setOption（不再重建图表）', () => {
    const { rerender } = render(<BacktestChart data={makeData()} />);
    rerender(
      <BacktestChart
        data={makeData({
          totalReturn: 20,
          equityCurve: [
            { date: '2024-01-02', value: 1 },
            { date: '2024-02-02', value: 1.2 },
          ],
        })}
      />,
    );
    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    expect(setOption).toHaveBeenCalledTimes(2);
  });

  it('取色走设计令牌（不再硬编码 #4c8dff / #666 / #1e1e1e）', () => {
    render(<BacktestChart data={makeData()} />);
    const option = setOption.mock.calls[0][0] as {
      series: { name: string; lineStyle: { color: string } }[];
      yAxis: { splitLine: { lineStyle: { color: string } } };
    };
    expect(option.series[0].lineStyle.color).toBe(CHART_COLOR.accent);
    expect(option.series[1].lineStyle.color).toBe(CHART_COLOR.textMuted);
    expect(option.yAxis.splitLine.lineStyle.color).toBe(CHART_COLOR.border);
  });

  it('reduced-motion 时关闭 ECharts 入场动画', () => {
    stubMatchMedia(true);
    render(<BacktestChart data={makeData()} />);
    expect((setOption.mock.calls[0][0] as { animation?: boolean }).animation).toBe(false);
  });
});

describe('BacktestChart —— 指标卡着色口径（红涨绿跌，好坏不借涨跌色）', () => {
  beforeEach(() => {
    const c = {
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    };
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue(c);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('正收益 = 红（val-positive），负收益 = 绿（val-negative）', () => {
    render(<BacktestChart data={makeData()} />);
    expect(toneOf('总收益率')).toContain('val-positive');
    expect(toneOf('年化收益')).toContain('val-positive');
  });

  it('亏损时收益指标转绿（val-negative，不再永远红）', () => {
    render(<BacktestChart data={makeData({ totalReturn: -6.2, annualizedReturn: -4.1 })} />);
    expect(toneOf('总收益率')).toContain('val-negative');
    expect(toneOf('年化收益')).toContain('val-negative');
  });

  it('最大回撤用风险琥珀色（此前硬编码 positive:false → 永远显示绿色）', () => {
    render(<BacktestChart data={makeData()} />);
    expect(toneOf('最大回撤')).toContain('val-warn');
  });

  it('交易次数 / 夏普 / 胜率用中性色（无方向或阈值判定，不借涨跌色）', () => {
    render(<BacktestChart data={makeData()} />);
    expect(toneOf('交易次数')).toContain('val-neutral');
    expect(toneOf('夏普比率')).toContain('val-neutral');
    expect(toneOf('胜率')).toContain('val-neutral');
  });

  it('不再使用旧的 .positive/.negative 类（避免与 val-* 两套口径并存）', () => {
    const { container } = render(<BacktestChart data={makeData()} />);
    const classes = (container.querySelector('.quant-metric-value') as HTMLElement).className.split(
      /\s+/,
    );
    expect(classes).not.toContain('positive');
    expect(classes).not.toContain('negative');
  });
});

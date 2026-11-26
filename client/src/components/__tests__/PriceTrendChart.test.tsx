// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import PriceTrendChart from '../PriceTrendChart';
import type { PricePoint } from '../../types';

// mock 按需 echarts：init 返回可控实例（真实 echarts 在 jsdom 下无法 init）
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../lib/echarts', () => ({
  default: { init: echartsMock.init },
}));

/** 捕获图表注册的回调，用于模拟真实鼠标事件 */
let axisHandler: ((p: unknown) => void) | undefined;
let mouseoutHandler: (() => void) | undefined;

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function makeData(count = 40): PricePoint[] {
  const out: PricePoint[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i;
    out.push({
      date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: base,
      high: base + 2,
      low: base - 2,
      close: base + 1,
      volume: 1000 + i * 10,
    });
  }
  return out;
}

describe('PriceTrendChart', () => {
  beforeEach(() => {
    axisHandler = undefined;
    mouseoutHandler = undefined;
    const zr = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'mouseout') mouseoutHandler = cb;
      }),
    };
    const chart = {
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn((event: string, cb: (p: unknown) => void) => {
        if (event === 'updateAxisPointer') axisHandler = cb;
      }),
      getZr: vi.fn(() => zr),
    };
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue(chart);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  it('无数据时返回 null（不渲染）', () => {
    const { container } = render(<PriceTrendChart data={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('有数据时渲染标题与周期切换', () => {
    const { getByText } = render(<PriceTrendChart data={makeData()} stockName="测试股" />);
    expect(getByText(/行情走势/)).toBeInTheDocument();
    expect(getByText('日K')).toBeInTheDocument();
    expect(getByText('周K')).toBeInTheDocument();
    expect(getByText('月K')).toBeInTheDocument();
  });

  it('点击周期 / 指标按钮不抛错', () => {
    const { getByText } = render(<PriceTrendChart data={makeData()} />);
    expect(() => {
      fireEvent.click(getByText('周K'));
      fireEvent.click(getByText('BOLL'));
      fireEvent.click(getByText('MACD'));
      fireEvent.click(getByText('MA5'));
    }).not.toThrow();
  });

  it('周期 / 均线工具条带 no-print：纸面上点不动的控件不该出现', () => {
    const { container, getByText } = render(<PriceTrendChart data={makeData()} />);

    const controls = container.querySelector('.trend-controls') as HTMLElement;
    expect(controls).not.toBeNull();
    expect(controls.className.split(/\s+/)).toContain('no-print');
    // 图表本体（标题 + 画布）仍要印出来
    expect(container.querySelector('.trend-chart-head h4')?.className.split(/\s+/)).not.toContain(
      'no-print',
    );
    expect(getByText(/行情走势/)).toBeInTheDocument();
  });

  it('周期 / 指标按钮带 aria-pressed，随状态翻转（读屏才知道是否已启用）', () => {
    const { getByText } = render(<PriceTrendChart data={makeData()} />);

    // 默认日K + 均线开 + MA5 选中 + BOLL/MACD 关
    expect(getByText('日K')).toHaveAttribute('aria-pressed', 'true');
    expect(getByText('周K')).toHaveAttribute('aria-pressed', 'false');
    expect(getByText('均线')).toHaveAttribute('aria-pressed', 'true');
    expect(getByText('MA5')).toHaveAttribute('aria-pressed', 'true');
    expect(getByText('BOLL')).toHaveAttribute('aria-pressed', 'false');
    expect(getByText('MACD')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(getByText('周K'));
    fireEvent.click(getByText('BOLL'));
    fireEvent.click(getByText('MA5'));

    expect(getByText('周K')).toHaveAttribute('aria-pressed', 'true');
    expect(getByText('日K')).toHaveAttribute('aria-pressed', 'false');
    expect(getByText('BOLL')).toHaveAttribute('aria-pressed', 'true');
    expect(getByText('MA5')).toHaveAttribute('aria-pressed', 'false');
  });

  it('图表初始化且注册了光标/鼠标事件监听', () => {
    render(<PriceTrendChart data={makeData()} />);
    expect(echartsMock.init).toHaveBeenCalled();
    const chart = echartsMock.init.mock.results[0].value;
    expect(chart.on).toHaveBeenCalledWith('updateAxisPointer', expect.any(Function));
    expect(chart.getZr).toHaveBeenCalled();
  });

  it('悬停十字光标：数字索引/日期字符串/越界值分别处理，mouseout 复位', () => {
    const { container } = render(<PriceTrendChart data={makeData()} />);
    const date = () => container.querySelector('.tl-date')?.textContent;
    expect(date()).toBe('2024-01-12'); // 默认停在最后一根（i=39）

    act(() => axisHandler?.({ axesInfo: [{ value: 5 }] }));
    expect(date()).toBe('2024-01-06');
    act(() => axisHandler?.({ axesInfo: [{ value: '2024-01-28' }] }));
    expect(date()).toBe('2024-01-28');

    // 越界数字 / 缺值 / 缺 axesInfo：保持上一次命中且不崩溃
    act(() => axisHandler?.({ axesInfo: [{ value: 999 }] }));
    expect(date()).toBe('2024-01-28');
    act(() => axisHandler?.({ axesInfo: [{}] }));
    expect(date()).toBe('2024-01-28');
    act(() => axisHandler?.({}));
    expect(date()).toBe('2024-01-28');

    act(() => mouseoutHandler?.());
    expect(date()).toBe('2024-01-12');
  });

  it('首根 K 线：无前收 → +0.00，早周期均线无值不渲染标签', () => {
    const { container } = render(<PriceTrendChart data={makeData()} />);
    act(() => axisHandler?.({ axesInfo: [{ value: 0 }] }));

    expect(container.querySelector('.tl-chg')?.textContent).toBe('+0.00 (+0.00%)');
    // MA5/10/20/60 在 i=0 都还没有值（null），不能渲染成 "MA5 0.00"
    expect(container.querySelectorAll('.tl-ma')).toHaveLength(0);
  });

  it('悬浮提示框：空参数/越界返回空串，正常参数含 OHLC 与均线', () => {
    render(<PriceTrendChart data={makeData(80)} />);
    const chart = echartsMock.init.mock.results.at(-1)!.value as {
      setOption: ReturnType<typeof vi.fn>;
    };
    const option = chart.setOption.mock.calls.at(-1)![0] as {
      tooltip: { formatter: (p: unknown) => string };
    };
    const tip = option.tooltip.formatter;

    expect(tip([])).toBe('');
    expect(tip([{ dataIndex: 999 }])).toBe('');
    const first = tip([{ dataIndex: 0 }]);
    expect(first).toContain('开 100.00');
    expect(first).toContain('涨跌');
    expect(first).not.toContain('MA5'); // 首根均线无值
    const later = tip([{ dataIndex: 79 }]);
    expect(later).toContain('MA5');
    expect(later).toContain('MA60');
  });

  it('BOLL 数据不足（<20 根）不渲染空标签，足够时才显示', () => {
    const short = render(<PriceTrendChart data={makeData(3)} />);
    fireEvent.click(short.getByText('BOLL'));
    act(() => axisHandler?.({ axesInfo: [{ value: 0 }] }));
    expect(short.container.querySelector('.tl-boll')).toBeNull();
    short.unmount();
    axisHandler = undefined;

    const long = render(<PriceTrendChart data={makeData()} />);
    fireEvent.click(long.getByText('BOLL'));
    act(() => axisHandler?.({ axesInfo: [{ value: 39 }] }));
    expect(long.container.querySelector('.tl-boll')?.textContent).toContain('BOLL');
  });
});

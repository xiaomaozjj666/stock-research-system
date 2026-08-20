// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import PriceTrendChart from '../PriceTrendChart';
import type { PricePoint } from '../../types';

// mock 按需 echarts：init 返回可控实例（真实 echarts 在 jsdom 下无法 init）
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../lib/echarts', () => ({
  default: { init: echartsMock.init },
}));

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
    const chart = {
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
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

  it('图表初始化且注册了光标/鼠标事件监听', () => {
    render(<PriceTrendChart data={makeData()} />);
    expect(echartsMock.init).toHaveBeenCalled();
    const chart = echartsMock.init.mock.results[0].value;
    expect(chart.on).toHaveBeenCalledWith('updateAxisPointer', expect.any(Function));
    expect(chart.getZr).toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import ChartsSection from '../ChartsSection';

// mock 按需 echarts：init 返回可控实例（真实 echarts 在 jsdom 下无法 init）
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../lib/echarts', () => ({
  default: { init: echartsMock.init },
}));

// jsdom 无 ResizeObserver
class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function makeData() {
  return {
    stock_name: '贵州茅台',
    finance_metrics: {
      years: ['2023', '2024', '2025'],
      revenue: [1, 2, 3],
      netProfit: [1, 2, 3],
      grossMargin: [10, 20, 30],
      netMargin: [5, 6, 7],
      roe: [8, 9, 10],
    },
    valuation: {
      pe: 30,
      historicalPE: [{ year: '2024', pe: 25 }],
      peerComparison: [{ name: '五粮液', code: '000858', pe: 20, pb: 5, roe: 15, marketCap: 5000 }],
    },
    score_detail: {
      profit_quality: 80,
      growth: 70,
      valuation: 60,
      industry_boom: 90,
      risk_deduction: 50,
    },
  };
}

describe('ChartsSection', () => {
  beforeEach(() => {
    const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue(chart);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  it('渲染图表区标题「可视化分析」', () => {
    const { getByText } = render(<ChartsSection data={makeData() as never} />);
    expect(getByText('可视化分析')).toBeInTheDocument();
  });

  it('有财务数据时至少初始化 2 个图表（营收/盈利）', () => {
    render(<ChartsSection data={makeData() as never} />);
    expect(echartsMock.init).toHaveBeenCalled();
    expect(echartsMock.init.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('渲染图表卡片标题（营收与利润趋势 / 历史 PE 走势）', () => {
    const { getByText } = render(<ChartsSection data={makeData() as never} />);
    expect(getByText('营收与利润趋势')).toBeInTheDocument();
    expect(getByText('历史 PE 走势')).toBeInTheDocument();
  });

  it('空数据（无财务/估值）时按设计返回 null', () => {
    const { container } = render(<ChartsSection data={{ stock_name: 'X' } as never} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import ChartsSection from '../ChartsSection';
import PriceTrendChart from '../PriceTrendChart';
import type { PricePoint } from '../../types';

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

/** jsdom 没有 matchMedia：按需伪造系统「减少动态效果」偏好 */
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

function makeChartData() {
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
      peerComparison: [{ name: '五粮液', code: '000858', pe: 20 }],
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

function makePriceData(count = 40): PricePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 100 + i,
    high: 102 + i,
    low: 98 + i,
    close: 101 + i,
    volume: 1000 + i * 10,
  }));
}

describe('prefers-reduced-motion → ECharts 入场动画（CSS 媒体查询覆盖不到 canvas）', () => {
  let setOption: ReturnType<typeof vi.fn>;

  /** 取出本次渲染里所有 setOption 的 option（每张图一次） */
  function options(): { animation?: boolean; animationDuration?: number }[] {
    return setOption.mock.calls.map((c) => c[0] as { animation?: boolean });
  }

  beforeEach(() => {
    setOption = vi.fn();
    const chart = {
      setOption,
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    };
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue(chart);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ChartsSection：默认（未开启 reduced）保留 1500ms 入场动画', () => {
    stubMatchMedia(false);
    render(<ChartsSection data={makeChartData() as never} />);
    const all = options();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const o of all) expect(o.animation).toBe(true);
    expect(all[0].animationDuration).toBe(1500);
  });

  it('ChartsSection：系统开启 reduced 时 5 张图全部 animation:false', () => {
    stubMatchMedia(true);
    render(<ChartsSection data={makeChartData() as never} />);
    const all = options();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const o of all) {
      expect(o.animation).toBe(false);
      expect(o.animationDuration).toBe(0);
    }
  });

  it('PriceTrendChart：默认开启动画，reduced 时 animation:false', () => {
    stubMatchMedia(false);
    const normal = render(<PriceTrendChart data={makePriceData()} />);
    expect((options()[0] as { animation?: boolean }).animation).toBe(true);
    expect(options()[0]).toMatchObject({ animationDuration: 400, animationDurationUpdate: 300 });
    normal.unmount();

    setOption.mockClear();
    stubMatchMedia(true);
    render(<PriceTrendChart data={makePriceData()} />);
    expect((options()[0] as { animation?: boolean }).animation).toBe(false);
  });

  it('reduced 只关动画，不动系列数据（图形内容不变）', () => {
    stubMatchMedia(true);
    render(<PriceTrendChart data={makePriceData()} />);
    const opt = options()[0] as { series?: unknown[] };
    expect(Array.isArray(opt.series)).toBe(true);
    expect((opt.series ?? []).length).toBeGreaterThan(0);
  });
});

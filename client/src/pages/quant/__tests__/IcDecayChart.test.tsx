// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import IcDecayChart from '../IcDecayChart';
import { IC_DECAY_HORIZONS } from '../types';
import type {
  FactorPredictability,
  FactorPredictabilityHorizon,
  PriceVolumeFactorName,
} from '../types';

/**
 * IC 衰减曲线行为测试
 * ----------------------------------------------------------------------------
 * 该组件用原生 <svg> 手绘（不经过 components/EChart.tsx），所以下面是按
 * echarts 的写法保留的隔离桩：init 永远不会被调用，写成可返回实例的形式是为了
 * 将来若改用 EChart 时测试不必重写。所有断言都打在用户能看到的内容上：
 * 中文文案、读屏用的 role/aria-label、图例文字，以及折线的几何位置与着色类名。
 */
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock('../../../lib/echarts', () => ({
  default: { init: echartsMock.init },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
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

/** 与源码一致的绘图常量：用来把「画在哪里」变成可断言的数字 */
const PAD_L = 34;
const PAD_R = 12;
const PAD_T = 12;
const H = 190;
const PAD_B = 24;
const W = 560;

function xAt(i: number): number {
  return PAD_L + ((W - PAD_L - PAD_R) * i) / (IC_DECAY_HORIZONS.length - 1);
}

function yAxis(v: number, yMax: number): number {
  return PAD_T + (H - PAD_T - PAD_B) * (1 - (v + yMax) / (2 * yMax));
}

function makeHorizon(over: Partial<FactorPredictabilityHorizon> = {}): FactorPredictabilityHorizon {
  return {
    ic: 0.2,
    effectiveIc: 0.2,
    tStat: 2.5,
    pValue: 0.01,
    significant: true,
    n: 100,
    ...over,
  };
}

function makeFactor(
  name: PriceVolumeFactorName,
  horizons: Record<number, FactorPredictabilityHorizon | null>,
): FactorPredictability {
  return { name, direction: 1, category: 'volatility', horizons, hasSignal: true };
}

/** 把 5 个网格点的 effectiveIc 摊成 horizons（null = 该档缺失） */
function gridFactor(
  name: PriceVolumeFactorName,
  values: (number | null)[],
  over: Partial<FactorPredictabilityHorizon> = {},
): FactorPredictability {
  const horizons: Record<number, FactorPredictabilityHorizon | null> = {};
  IC_DECAY_HORIZONS.forEach((h, i) => {
    const v = values[i];
    horizons[h] = v === null || v === undefined ? null : makeHorizon({ effectiveIc: v, ...over });
  });
  return makeFactor(name, horizons);
}

/** 只有前两档有数据的因子：非显著，用来造成「可选样本不足」 */
function sparseFactor(name: PriceVolumeFactorName): FactorPredictability {
  return makeFactor(name, {
    1: makeHorizon({ effectiveIc: 0.05, significant: false }),
    5: null,
    10: null,
    21: null,
    63: null,
  });
}

function pointsOf(el: Element): number[][] {
  return (el.getAttribute('points') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((pair) => pair.split(',').map(Number));
}

function chipTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.ic-decay-chip')).map((c) => c.textContent ?? '');
}

describe('IcDecayChart —— 空态与曲线筛选', () => {
  beforeEach(() => {
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue({
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没有任何因子时给出中文空态提示，且不渲染 svg', () => {
    const { container } = render(<IcDecayChart data={[]} />);

    expect(
      screen.getByText(
        '可用持有期不足两个（回看窗口或样本不足），无法绘制 IC 衰减曲线。拉长回测区间后重试。',
      ),
    ).toBeInTheDocument();
    expect(container.querySelector('.ic-decay-empty')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('只有单个有效持有期的因子被剔除，只剩它时仍是空态', () => {
    const { container } = render(<IcDecayChart data={[sparseFactor('volatility_1m')]} />);

    expect(screen.getByText(/可用持有期不足两个（回看窗口或样本不足）/)).toBeInTheDocument();
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
  });

  it('有效点不足的因子被剔除，其余因子照常绘制', () => {
    const { container } = render(
      <IcDecayChart
        data={[gridFactor('volatility_1m', [0.2, 0.1, 0.08, 0.06, 0.04]), sparseFactor('beta')]}
      />,
    );

    expect(container.querySelectorAll('polyline')).toHaveLength(1);
    expect(container.querySelectorAll('.ic-decay-chip')).toHaveLength(1);
    expect(screen.queryByText(/可用持有期不足两个/)).toBeNull();
  });

  it('整图带读屏可用的 role=img 与中文替代文本，标题与说明同步可见', () => {
    render(<IcDecayChart data={[gridFactor('volatility_1m', [0.2, 0.1, 0.08, 0.06, 0.04])]} />);

    expect(
      screen.getByRole('img', { name: 'IC 衰减曲线：各因子经济方向 IC 随持有期的变化' }),
    ).toBeInTheDocument();
    expect(screen.getByText('IC 衰减曲线')).toBeInTheDocument();
    expect(
      screen.getByText('信号随持有期的衰减（经济方向 IC）：衰减越慢，因子越扛得住低频调仓'),
    ).toBeInTheDocument();
  });
});

describe('IcDecayChart —— 坐标与折线几何', () => {
  beforeEach(() => {
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue({
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('纵轴上限按最大绝对 IC 向上取整到 0.1，±参考线贴在绘图区上下沿', () => {
    const { container } = render(
      <IcDecayChart data={[gridFactor('volatility_1m', [0.42, 0.3, 0.2, 0.1, 0.05])]} />,
    );

    expect(screen.getByText('0.5')).toBeInTheDocument();
    expect(screen.getByText('-0.5')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();

    const gridlines = Array.from(container.querySelectorAll('.ic-decay-gridline'));
    expect(gridlines).toHaveLength(2);
    expect(gridlines.map((l) => l.getAttribute('y1'))).toEqual([
      String(yAxis(0.5, 0.5)),
      String(yAxis(-0.5, 0.5)),
    ]);
    // ±上限即绘图区上下沿
    expect(gridlines.map((l) => l.getAttribute('y1'))).toEqual(['12', '166']);
    expect(container.querySelectorAll('.ic-decay-zero')).toHaveLength(1);
  });

  it('IC 绝对值很小时纵轴至少 ±0.1，不会退化成 0', () => {
    render(<IcDecayChart data={[gridFactor('beta', [0.02, -0.01, 0.005, -0.003, 0.001])]} />);

    expect(screen.getByText('0.1')).toBeInTheDocument();
    expect(screen.getByText('-0.1')).toBeInTheDocument();
  });

  it('缺失的网格点断线：折线点数等于有效点数，首尾贴住绘图区两侧', () => {
    const { container } = render(
      <IcDecayChart data={[gridFactor('volatility_1m', [0.2, 0.1, null, 0.15, 0.05])]} />,
    );

    const line = container.querySelector('polyline') as SVGPolylineElement;
    const points = pointsOf(line);
    expect(points).toHaveLength(4);
    expect(points.map((p) => p[0])).toEqual([xAt(0), xAt(1), xAt(3), xAt(4)]);
    expect(points.map((p) => p[0])).toEqual([34, 162.5, 419.5, 548]);
    // 纵轴上限 0.2：四个点分别落在 12 / 50.5 / 31.25 / 69.75
    const expectedY = [12, 50.5, 31.25, 69.75];
    points.forEach((p, i) => expect(p[1]).toBeCloseTo(expectedY[i], 6));
  });

  it('有效 IC 恰好为 0 时仍算有效点，画在零轴上而不是被当成缺失', () => {
    const { container } = render(
      <IcDecayChart data={[gridFactor('beta', [0, 0.1, -0.05, 0.02, -0.01])]} />,
    );

    const points = pointsOf(container.querySelector('polyline') as SVGPolylineElement);
    expect(points).toHaveLength(5);
    expect(points[0][0]).toBe(34);
    expect(points[0][1]).toBe(yAxis(0, 0.1));
  });

  it('横轴刻度按 1/5/10/21/63 交易日显示中文档位', () => {
    const { container } = render(
      <IcDecayChart data={[gridFactor('volatility_1m', [0.2, 0.1, 0.08, 0.06, 0.04])]} />,
    );

    const labels = Array.from(container.querySelectorAll('.ic-decay-xlabel')).map(
      (t) => t.textContent,
    );
    expect(labels).toEqual(['1日', '5日', '10日', '1月', '3月']);
  });

  it('全部持有期都存在时折线连续（5 个网格点）', () => {
    const { container } = render(
      <IcDecayChart data={[gridFactor('volatility_1m', [0.2, 0.1, 0.08, 0.06, 0.04])]} />,
    );

    const points = pointsOf(container.querySelector('polyline') as SVGPolylineElement);
    expect(points.map((p) => p[0])).toEqual([34, 162.5, 291, 419.5, 548]);
  });
});

describe('IcDecayChart —— 显著性与图例', () => {
  beforeEach(() => {
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue({
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('显著且过半网格点为正的因子画「方向一致」线并进图例', () => {
    const { container } = render(
      <IcDecayChart data={[gridFactor('volatility_1m', [0.2, 0.15, 0.1, 0.08, 0.04])]} />,
    );

    expect(container.querySelector('polyline')).toHaveClass('ic-decay-line-valid');
    const chip = screen.getByText('波动1月');
    expect(chip).toHaveClass('ic-decay-chip', 'sig-valid');
  });

  it('显著但过半网格点为负的因子画「反向」线，图例用琥珀色', () => {
    const { container } = render(
      <IcDecayChart
        data={[
          makeFactor('reversal_1m', {
            1: makeHorizon({ effectiveIc: -0.2, significant: true }),
            5: makeHorizon({ effectiveIc: -0.15, significant: true }),
            10: makeHorizon({ effectiveIc: 0.05, significant: true }),
            21: makeHorizon({ effectiveIc: -0.02, significant: false }),
            63: makeHorizon({ effectiveIc: -0.01, significant: false }),
          }),
        ]}
      />,
    );

    expect(container.querySelector('polyline')).toHaveClass('ic-decay-line-inverted');
    expect(screen.getByText('反转1月')).toHaveClass('ic-decay-chip', 'sig-inverted');
  });

  it('显著点正负各半（平局）不算方向一致，按反向处理', () => {
    const { container } = render(
      <IcDecayChart
        data={[
          makeFactor('beta', {
            1: makeHorizon({ effectiveIc: 0.2, significant: true }),
            5: makeHorizon({ effectiveIc: -0.1, significant: true }),
            10: makeHorizon({ effectiveIc: 0.05, significant: false }),
            21: makeHorizon({ effectiveIc: 0.04, significant: false }),
            63: makeHorizon({ effectiveIc: 0.03, significant: false }),
          }),
        ]}
      />,
    );

    // 1 正 1 负谈不上「方向一致」：平局按反向着色，避免给出虚假的方向结论
    expect(container.querySelector('polyline')).toHaveClass('ic-decay-line-inverted');
    expect(screen.getByText('贝塔')).toHaveClass('sig-inverted');
  });

  it('不显著的因子画浅灰背景线，且不出现同名图例条目', () => {
    const { container } = render(
      <IcDecayChart
        data={[
          makeFactor('momentum_12_1', {
            1: makeHorizon({ effectiveIc: 0.2, significant: false }),
            5: makeHorizon({ effectiveIc: 0.1, significant: false }),
            10: makeHorizon({ effectiveIc: 0.05, significant: false }),
            21: null,
            63: null,
          }),
        ]}
      />,
    );

    expect(container.querySelector('polyline')).toHaveClass('ic-decay-line-muted');
    expect(screen.queryByText('12-1动量')).toBeNull();
    expect(
      screen.getByText(
        /本股无因子通过显著性门槛（已做重叠修正与 Holm 校正）——灰色曲线仍可观察衰减形态/,
      ),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('.ic-decay-chip')).toHaveLength(0);
  });

  it('图例按数据顺序用中文短名列出显著因子', () => {
    const { container } = render(
      <IcDecayChart
        data={[
          gridFactor('volatility_3m', [0.2, 0.15, 0.1, 0.08, 0.04]),
          gridFactor('turnover_ratio_reversal', [0.3, 0.25, 0.2, 0.1, 0.05]),
        ]}
      />,
    );

    expect(chipTexts(container)).toEqual(['波动3月', '换手反转']);
    const lines = Array.from(container.querySelectorAll('polyline'));
    expect(lines.map((l) => l.getAttribute('class'))).toEqual([
      'ic-decay-line-valid',
      'ic-decay-line-valid',
    ]);
  });

  it('显著与不显著的因子混排时，背景线在前、高亮线在后', () => {
    const { container } = render(
      <IcDecayChart
        data={[
          gridFactor('volatility_1m', [0.2, 0.15, 0.1, 0.08, 0.04]),
          gridFactor('amihud_illiquidity', [0.05, 0.04, 0.03, 0.02, 0.01], { significant: false }),
          gridFactor('reversal_1m', [0.25, 0.2, 0.18, 0.1, 0.06]),
        ]}
      />,
    );

    expect(chipTexts(container)).toEqual(['波动1月', '反转1月']);
    const classes = Array.from(container.querySelectorAll('polyline')).map((l) =>
      l.getAttribute('class'),
    );
    expect(classes).toEqual(['ic-decay-line-muted', 'ic-decay-line-valid', 'ic-decay-line-valid']);
  });

  it('未收录短名的因子在图例里回退显示原始字段名', () => {
    const { container } = render(
      <IcDecayChart
        data={[
          gridFactor('brand_new_alpha' as PriceVolumeFactorName, [0.2, 0.1, 0.08, 0.06, 0.04]),
        ]}
      />,
    );

    expect(chipTexts(container)).toEqual(['brand_new_alpha']);
  });

  it('标了 significant 但 effectiveIc 非有限值时不按显著处理', () => {
    const { container } = render(
      <IcDecayChart
        data={[
          makeFactor('beta', {
            1: makeHorizon({ effectiveIc: 0.05, significant: false }),
            5: makeHorizon({ effectiveIc: NaN, significant: true }),
            10: makeHorizon({ effectiveIc: 0.03, significant: false }),
            21: null,
            63: null,
          }),
        ]}
      />,
    );

    expect(container.querySelector('polyline')).toHaveClass('ic-decay-line-muted');
    expect(container.querySelectorAll('.ic-decay-chip')).toHaveLength(0);
    expect(container.querySelector('.ic-decay-legend-empty')).not.toBeNull();
  });

  it('没有任何显著因子时图例位置给出说明文案而不是空白', () => {
    const { container } = render(
      <IcDecayChart
        data={[gridFactor('beta', [0.05, 0.04, 0.03, 0.02, 0.01], { significant: false })]}
      />,
    );

    expect(
      screen.getByText(/本股无因子通过显著性门槛（已做重叠修正与 Holm 校正）/),
    ).toBeInTheDocument();
    expect(container.querySelector('.ic-decay-legend-empty')).not.toBeNull();
    expect(container.querySelector('.ic-decay-legend')).not.toBeNull();
  });
});

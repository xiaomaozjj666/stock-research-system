// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import FactorPanel from '../FactorPanel';
import type {
  CompositeAlpha,
  FactorPredictability,
  FactorPredictabilityHorizon,
  PriceVolumeFactor,
  PriceVolumeFactorName,
} from '../types';

/**
 * FactorPanel 行为测试
 * ----------------------------------------------------------------------------
 * 该面板有两条独立语义的色板（见 lib/colors.ts）：
 *   1) 组合方向「看多/看空/中性」= 涨跌语义 → signCls → val-positive(红)/val-negative(绿)/val-neutral；
 *   2) 预测力「显著·方向一致 / 方向相反 / 不显著」= 统计显著性 → sig-valid/sig-inverted/sig-none。
 * 下面分别钉住，避免两者再次互串（历史上「看多」曾被渲染成绿色）。
 * IC 衰减曲线用桩替换（其自身有独立测试），只验证「何时挂载、拿到哪些因子」。
 */

const icDecayMock = vi.hoisted(() => vi.fn((_props: { data: FactorPredictability[] }) => null));

vi.mock('../IcDecayChart', () => ({
  default: icDecayMock,
}));

function makeHorizon(over: Partial<FactorPredictabilityHorizon> = {}): FactorPredictabilityHorizon {
  return {
    ic: 0.2,
    effectiveIc: 0.2,
    tStat: 2.5,
    pValue: 0.0234,
    significant: true,
    n: 120,
    ...over,
  };
}

function makePredictability(
  horizons: Record<number, FactorPredictabilityHorizon | null>,
  over: Partial<FactorPredictability> = {},
): FactorPredictability {
  return {
    name: 'volatility_1m',
    direction: 1,
    category: 'volatility',
    horizons,
    hasSignal: true,
    ...over,
  };
}

function makeFactor(over: Partial<PriceVolumeFactor> = {}): PriceVolumeFactor {
  return {
    name: 'volatility_1m',
    value: 0.123,
    direction: 1,
    category: 'volatility',
    evidence: '低波动异象：波动率越高，后续收益越低',
    aShareAdjusted: false,
    available: true,
    ...over,
  };
}

function makeComposite(over: Partial<CompositeAlpha> = {}): CompositeAlpha {
  return {
    horizons: [
      {
        period: 21,
        alpha: 0.1234,
        direction: 'up',
        significantCount: 2,
        evaluableCount: 5,
        agreement: 0.666,
        topContributors: [],
      },
      {
        period: 63,
        alpha: -0.05,
        direction: 'down',
        significantCount: 1,
        evaluableCount: 4,
        agreement: 1,
        topContributors: [],
      },
      {
        period: 10,
        alpha: 0,
        direction: 'neutral',
        significantCount: 0,
        evaluableCount: 3,
        agreement: 0,
        topContributors: [],
      },
    ],
    hasSignal: true,
    overallDirection: 'up',
    overallAlpha: 0.02,
    ...over,
  };
}

function renderPanel(data: PriceVolumeFactor[], compositeAlpha?: CompositeAlpha) {
  return render(<FactorPanel data={data} compositeAlpha={compositeAlpha} />);
}

/** 取某因子所在行（因子名以直接文本出现在 .factor-name 里） */
function rowOf(factorLabel: string): HTMLTableRowElement {
  return screen.getByText(factorLabel).closest('tr') as HTMLTableRowElement;
}

/** 行内第 3 列（当前值） */
function valueCell(row: HTMLTableRowElement): HTMLTableCellElement {
  return row.cells[2];
}

beforeEach(() => {
  icDecayMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FactorPanel —— 空态与骨架', () => {
  it('无因子数据时整体返回 null（不渲染空卡片）', () => {
    const { container } = renderPanel([]);

    expect(container).toBeEmptyDOMElement();
    expect(icDecayMock).not.toHaveBeenCalled();
  });

  it('data 为 null 时同样不渲染', () => {
    const { container } = renderPanel(null as unknown as PriceVolumeFactor[]);

    expect(container).toBeEmptyDOMElement();
  });

  it('有因子时渲染标题、说明、六个表头与脚注口径', () => {
    const { container } = renderPanel([makeFactor()]);

    expect(screen.getByText('量价因子与预测力')).toBeInTheDocument();
    expect(screen.getByText(/1\/5\/10\/21\/63 交易日，Spearman \+ Student/)).toBeInTheDocument();
    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['因子', '方向', '当前值', '1月预测力', '3月预测力', '实证依据']);
    expect(screen.getByText(/此处为单股时间序列 IC/)).toBeInTheDocument();
    expect(screen.getByText(/无市场收益时 Beta 类因子恒为「样本不足」/)).toBeInTheDocument();
  });
});

describe('FactorPanel —— 因子行字段与格式化', () => {
  it('因子名与分类显示中文标签', () => {
    renderPanel([makeFactor({ name: 'amihud_illiquidity', category: 'liquidity' })]);

    expect(screen.getByText('Amihud非流动性')).toBeInTheDocument();
    expect(screen.getByText('流动性')).toBeInTheDocument();
  });

  it('未收录中文名的因子回退显示原始字段名', () => {
    renderPanel([
      makeFactor({ name: 'brand_new_alpha' as PriceVolumeFactorName, category: 'volume' }),
    ]);

    expect(screen.getByText('brand_new_alpha')).toBeInTheDocument();
  });

  it('aShareAdjusted=true 时显示「A股校正」标签并带 title 说明', () => {
    renderPanel([makeFactor({ aShareAdjusted: true })]);

    const tag = screen.getByText('A股校正');
    expect(tag).toHaveClass('factor-tag', 'tag-adjusted');
    expect(tag).toHaveAttribute('title', '按 A 股实证做过方向翻转');
  });

  it('aShareAdjusted=false 时不出现 A 股校正标签', () => {
    renderPanel([makeFactor({ aShareAdjusted: false })]);

    expect(screen.queryByText('A股校正')).toBeNull();
  });

  it('direction=1 与 -1 分别给出「值高→收益高」「值低→收益高」', () => {
    const { unmount } = renderPanel([makeFactor({ direction: 1 })]);
    expect(rowOf('1月波动率').cells[1]).toHaveTextContent('↑ 值高→收益高');
    unmount();

    renderPanel([makeFactor({ direction: -1 })]);
    expect(rowOf('1月波动率').cells[1]).toHaveTextContent('↓ 值低→收益高');
  });

  it('当前值保留两位小数，实证依据同时写入单元格文本与 title', () => {
    renderPanel([makeFactor({ value: 1234.5678, evidence: '低波动异象' })]);

    const row = rowOf('1月波动率');
    expect(valueCell(row)).toHaveTextContent('1234.57');
    expect(row.cells[5]).toHaveAttribute('title', '低波动异象');
  });

  it('值为 0 时显示 0.00（不因 falsy 被当成缺失）', () => {
    renderPanel([makeFactor({ value: 0 })]);

    expect(valueCell(rowOf('1月波动率'))).toHaveTextContent('0.00');
  });

  it('available=false 时当前值走 factor-muted，且非有限值显示破折号', () => {
    const { unmount } = renderPanel([makeFactor({ value: Number.NaN, available: false })]);
    const muted = valueCell(rowOf('1月波动率'));
    expect(muted).toHaveClass('factor-muted');
    expect(muted).toHaveTextContent('—');
    unmount();

    renderPanel([makeFactor({ value: Number.POSITIVE_INFINITY, available: false })]);
    expect(valueCell(rowOf('1月波动率'))).toHaveTextContent('—');
  });

  it('available=true 时当前值不着 muted 类', () => {
    renderPanel([makeFactor({ value: -0.5 })]);

    const cell = valueCell(rowOf('1月波动率'));
    expect(cell.className).toBe('');
    expect(cell).toHaveTextContent('-0.50');
  });

  it('无 predictability 时两个预测力列都是破折号', () => {
    renderPanel([makeFactor({ predictability: undefined })]);

    const row = rowOf('1月波动率');
    expect(row.cells[3]).toHaveTextContent('—');
    expect(row.cells[4]).toHaveTextContent('—');
    expect(row.className).toBe('');
  });

  it('hasSignal=true 的因子行带 factor-row-signal 高亮类，false 则不带', () => {
    const { unmount } = renderPanel([
      makeFactor({
        predictability: makePredictability({ 21: makeHorizon() }, { hasSignal: true }),
      }),
    ]);
    expect(rowOf('1月波动率').className).toBe('factor-row-signal');
    unmount();

    renderPanel([
      makeFactor({
        predictability: makePredictability({ 21: makeHorizon() }, { hasSignal: false }),
      }),
    ]);
    expect(rowOf('1月波动率').className).toBe('');
  });
});

describe('FactorPanel —— 预测力单元格（IC / p 值 / 显著徽标）', () => {
  function renderOne(horizon: FactorPredictabilityHorizon | null, column: '1月' | '3月' = '1月') {
    const horizons = column === '1月' ? { 21: horizon } : { 63: horizon };
    renderPanel([makeFactor({ predictability: makePredictability(horizons) })]);
    return rowOf('1月波动率').cells[column === '1月' ? 3 : 4];
  }

  it('IC 固定三位小数（含负数），p 值用科学计数法并带样本数', () => {
    const cell = renderOne(makeHorizon({ ic: -0.185, pValue: 0.0234, n: 120 }));

    expect(cell).toHaveTextContent('IC -0.185');
    expect(cell.querySelector('.factor-pval')).toHaveTextContent('p=2.34e-2 · n=120');
  });

  it('p 值小于 1e-4 时显示 <1e-4', () => {
    const cell = renderOne(makeHorizon({ pValue: 0.00005 }));

    expect(cell.querySelector('.factor-pval')).toHaveTextContent('p=<1e-4');
  });

  it('p 值非有限值（NaN）显示破折号而不是 NaN', () => {
    const cell = renderOne(makeHorizon({ pValue: Number.NaN }));

    expect(cell.querySelector('.factor-pval')).toHaveTextContent('p=— · n=120');
  });

  it('显著且 effectiveIc>0：sig-valid + 「显著·方向一致」', () => {
    const cell = renderOne(makeHorizon({ significant: true, effectiveIc: 0.2 }));

    expect(cell.querySelector('.factor-ic')).toHaveClass('sig-valid');
    expect(cell.querySelector('.factor-badge')).toHaveClass('sig-valid');
    expect(cell.querySelector('.factor-badge')).toHaveTextContent('显著·方向一致');
  });

  it('显著但 effectiveIc<0：sig-inverted + 「显著·方向相反」', () => {
    const cell = renderOne(makeHorizon({ significant: true, effectiveIc: -0.2 }));

    expect(cell.querySelector('.factor-ic')).toHaveClass('sig-inverted');
    expect(cell.querySelector('.factor-badge')).toHaveTextContent('显著·方向相反');
  });

  it('显著但 effectiveIc 恰为 0 时归入「方向相反」（现状边界）', () => {
    const cell = renderOne(makeHorizon({ significant: true, effectiveIc: 0 }));

    expect(cell.querySelector('.factor-badge')).toHaveClass('sig-inverted');
    expect(cell.querySelector('.factor-badge')).toHaveTextContent('显著·方向相反');
  });

  it('不显著时走 sig-none + 「不显著」，但 IC 与 p 值照常展示', () => {
    const cell = renderOne(makeHorizon({ significant: false, effectiveIc: 0.3, ic: 0.3 }));

    expect(cell.querySelector('.factor-ic')).toHaveClass('sig-none');
    expect(cell.querySelector('.factor-badge')).toHaveTextContent('不显著');
    expect(cell).toHaveTextContent('IC 0.300');
  });

  it('该持有期为 null（样本不足）时只显示「样本不足」占位', () => {
    const cell = renderOne(null);

    expect(cell).toHaveTextContent('样本不足');
    expect(cell.querySelector('.factor-muted')).not.toBeNull();
    expect(cell.querySelector('.factor-badge')).toBeNull();
  });

  it('1月与 3月两列各取各的持有期，缺一个不影响另一个', () => {
    renderPanel([
      makeFactor({
        predictability: makePredictability({
          21: makeHorizon({ ic: 0.111 }),
          63: null,
        }),
      }),
    ]);

    const row = rowOf('1月波动率');
    expect(row.cells[3]).toHaveTextContent('IC 0.111');
    expect(row.cells[4]).toHaveTextContent('样本不足');
  });
});

describe('FactorPanel —— 组合 alpha 汇总条', () => {
  it('不传 compositeAlpha 时不渲染组合信号条', () => {
    const { container } = renderPanel([makeFactor()]);

    expect(screen.queryByText('组合信号')).toBeNull();
    expect(container.querySelector('.composite-summary')).toBeNull();
  });

  it('看多走红（val-positive）、看空走绿（val-negative）', () => {
    const up = renderPanel([makeFactor()], makeComposite({ overallDirection: 'up' }));
    const upOverall = screen.getByText('看多').closest('.composite-overall');
    expect(upOverall).toHaveClass('val-positive');
    expect(screen.getByText('组合信号')).toBeInTheDocument();
    expect(up.container.querySelector('.composite-overall')).toHaveClass('val-positive');
    up.unmount();

    const down = renderPanel([makeFactor()], makeComposite({ overallDirection: 'down' }));
    expect(screen.getByText('看空').closest('.composite-overall')).toHaveClass('val-negative');
    expect(down.container.querySelector('.composite-overall')).toHaveClass('val-negative');
  });

  it('中性方向走 val-neutral（既不是红也不是绿）', () => {
    const { container } = renderPanel(
      [makeFactor()],
      makeComposite({ overallDirection: 'neutral' }),
    );

    expect(screen.getByText('中性').closest('.composite-overall')).toHaveClass('val-neutral');
    expect(container.querySelector('.composite-overall')).toHaveClass('val-neutral');
  });

  it('持有期 21/63 显示「1月/3月」，其它按「N日」显示', () => {
    renderPanel([makeFactor()], makeComposite());

    expect(screen.getByText('1月')).toBeInTheDocument();
    expect(screen.getByText('3月')).toBeInTheDocument();
    expect(screen.getByText('10日')).toBeInTheDocument();
  });

  it('各持有期 alpha 保留三位小数，正数补 + 号、负数自带 -、0 显示 +0.000', () => {
    renderPanel([makeFactor()], makeComposite());

    expect(screen.getByText('α +0.123')).toHaveClass('composite-alpha', 'val-positive');
    expect(screen.getByText('α -0.050')).toHaveClass('composite-alpha', 'val-negative');
    expect(screen.getByText('α +0.000')).toHaveClass('composite-alpha', 'val-neutral');
  });

  it('显著因子数 >0 时追加方向一致率，=0 时不追加', () => {
    renderPanel([makeFactor()], makeComposite());

    expect(screen.getByText('显著 2/5 · 一致率 67%')).toBeInTheDocument();
    expect(screen.getByText('显著 1/4 · 一致率 100%')).toBeInTheDocument();
    expect(screen.getByText('显著 0/3')).toBeInTheDocument();
    expect(screen.queryByText(/显著 0\/3 · 一致率/)).toBeNull();
  });

  it('hasSignal=true 时给出加权口径说明', () => {
    renderPanel([makeFactor()], makeComposite({ hasSignal: true }));

    expect(
      screen.getByText(/仅纳入统计显著（p<0.05）因子，按 \|t\| 置信度加权方向校正 IC/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/本轮无因子通过显著门槛/)).toBeNull();
  });

  it('hasSignal=false 时改为如实说明「本轮无因子通过显著门槛」', () => {
    const { container } = renderPanel([makeFactor()], makeComposite({ hasSignal: false }));

    expect(
      screen.getByText(/本轮无因子通过显著门槛（p<0.05，已做重叠修正与 Holm/),
    ).toBeInTheDocument();
    expect(container.querySelector('.composite-foot-empty')).not.toBeNull();
    expect(screen.queryByText(/仅纳入统计显著/)).toBeNull();
  });

  it('多持有期按数据顺序渲染', () => {
    const { container } = renderPanel([makeFactor()], makeComposite());

    const periods = Array.from(container.querySelectorAll('.composite-horizon-period')).map(
      (p) => p.textContent,
    );
    expect(periods).toEqual(['1月', '3月', '10日']);
  });
});

describe('FactorPanel —— IC 衰减曲线挂载条件', () => {
  it('至少一个因子带 predictability 时挂载曲线，且只传带预测力的因子', () => {
    renderPanel([
      makeFactor({
        name: 'volatility_1m',
        predictability: makePredictability({ 21: makeHorizon() }),
      }),
      makeFactor({ name: 'beta', predictability: undefined }),
      makeFactor({
        name: 'reversal_1m',
        predictability: makePredictability({ 63: makeHorizon() }, { name: 'reversal_1m' }),
      }),
    ]);

    expect(icDecayMock).toHaveBeenCalledTimes(1);
    const passed = icDecayMock.mock.calls[0][0].data;
    expect(passed).toHaveLength(2);
    expect(passed.map((p) => p.name)).toEqual(['volatility_1m', 'reversal_1m']);
  });

  it('所有因子都没有 predictability 时不挂载曲线', () => {
    renderPanel([makeFactor(), makeFactor({ name: 'beta' })]);

    expect(icDecayMock).not.toHaveBeenCalled();
  });
});

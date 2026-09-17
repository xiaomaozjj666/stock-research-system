// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import OptimizationPanel from '../OptimizationPanel';
import type { OptimizationReport } from '../types';

/**
 * OptimizationPanel 行为测试
 * ----------------------------------------------------------------------------
 * 可见分支：建议按 impact 高→中→低排序（且不改动入参数组）、三档 impact 徽标
 * 文案与类名、参数敏感性表（空则整块不渲染）、风险指标三项（始终渲染，含 0 与负数）、
 * 迭代方向列表（空则不渲染）。
 */

function makeSuggestion(
  category: string,
  impact: 'high' | 'medium' | 'low',
): OptimizationReport['suggestions'][number] {
  return { category, title: `${category}优化`, detail: `${category}的具体做法`, impact };
}

function makeReport(over: Partial<OptimizationReport> = {}): OptimizationReport {
  return {
    performanceScore: 68,
    suggestions: [
      makeSuggestion('止损', 'low'),
      makeSuggestion('仓位', 'high'),
      makeSuggestion('择时', 'medium'),
    ],
    parameterSensitivity: [
      {
        param: 'fast',
        currentValue: 5,
        suggestedRange: { min: 3, max: 8, optimal: 4 },
        sensitivity: '高',
      },
      {
        param: 'slow',
        currentValue: 20,
        suggestedRange: { min: 15, max: 30, optimal: 25 },
        sensitivity: '低',
      },
    ],
    riskMetrics: { var95: 2.5, maxConsecutiveLoss: 4, avgHoldingDays: 7 },
    iterationDirections: ['引入波动率过滤', '按行业中性化'],
    ...over,
  };
}

function renderPanel(data: OptimizationReport) {
  return render(<OptimizationPanel data={data} />);
}

function suggestionCats(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.quant-opt-suggestion-cat')).map(
    (c) => c.textContent ?? '',
  );
}

function suggestionCards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.quant-opt-suggestion-card'));
}

describe('OptimizationPanel —— 性能评分与建议排序', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('显示标题、性能评分与满分口径', () => {
    const { container } = renderPanel(makeReport());

    expect(screen.getByRole('heading', { name: '策略优化建议' })).toBeInTheDocument();
    expect(container.querySelector('.quant-opt-score')?.textContent).toBe('68/100性能评分');
  });

  it('建议按 impact 高→中→低重排，与入参顺序无关', () => {
    const { container } = renderPanel(makeReport());

    expect(suggestionCats(container)).toEqual(['仓位', '择时', '止损']);
  });

  it('排序是同 impact 稳定排序（同级保持入参先后）', () => {
    const { container } = renderPanel(
      makeReport({
        suggestions: [
          makeSuggestion('甲', 'medium'),
          makeSuggestion('乙', 'medium'),
          makeSuggestion('丙', 'high'),
        ],
      }),
    );

    expect(suggestionCats(container)).toEqual(['丙', '甲', '乙']);
  });

  it('排序不修改调用方传入的数组（内部先复制再排）', () => {
    const suggestions = makeReport().suggestions;
    const before = suggestions.map((s) => s.category);

    renderPanel(makeReport({ suggestions }));

    expect(suggestions.map((s) => s.category)).toEqual(before);
    expect(suggestions.map((s) => s.category)).toEqual(['止损', '仓位', '择时']);
  });

  it('每条建议渲染分类、标题与细节', () => {
    const { container } = renderPanel(makeReport());

    const first = suggestionCards(container)[0];
    expect(first).toHaveTextContent('仓位');
    expect(first).toHaveTextContent('仓位优化');
    expect(first).toHaveTextContent('仓位的具体做法');
  });

  it('suggestions 为空数组时不渲染「优化建议」小节', () => {
    const { container } = renderPanel(makeReport({ suggestions: [] }));

    expect(screen.queryByText('优化建议')).toBeNull();
    expect(container.querySelectorAll('.quant-opt-suggestion-card')).toHaveLength(0);
  });
});

describe('OptimizationPanel —— impact 徽标', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('高影响 → chip-negative，中影响 → chip-neutral，低影响 → chip-positive', () => {
    const { container } = renderPanel(makeReport());

    const badges = Array.from(container.querySelectorAll('.quant-opt-suggestion-head .chip'));
    expect(badges.map((b) => b.textContent)).toEqual(['高影响', '中影响', '低影响']);
    expect(badges[0]).toHaveClass('chip', 'chip-negative');
    expect(badges[1]).toHaveClass('chip', 'chip-neutral');
    expect(badges[2]).toHaveClass('chip', 'chip-positive');
  });
});

describe('OptimizationPanel —— 参数敏感性表', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染表头与每行参数名、当前值、建议范围、最优值、敏感度', () => {
    const { container } = renderPanel(makeReport());

    expect(screen.getByText('参数敏感性')).toBeInTheDocument();
    const headers = Array.from(container.querySelectorAll('.quant-sensitivity-table th')).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(['参数', '当前值', '建议范围', '最优值', '敏感度']);

    const cells = Array.from(container.querySelectorAll('.quant-sensitivity-table tbody tr')).map(
      (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
    );
    expect(cells).toEqual([
      ['fast', '5', '3 ~ 8', '4', '高'],
      ['slow', '20', '15 ~ 30', '25', '低'],
    ]);
  });

  it('最优值走强调色类名（quant-accent-text）', () => {
    const { container } = renderPanel(makeReport());

    const optimal = container.querySelector('.quant-accent-text');
    expect(optimal).toHaveTextContent('4');
  });

  it('parameterSensitivity 为空数组时不渲染表格', () => {
    const { container } = renderPanel(makeReport({ parameterSensitivity: [] }));

    expect(screen.queryByText('参数敏感性')).toBeNull();
    expect(container.querySelector('.quant-sensitivity-table')).toBeNull();
  });
});

describe('OptimizationPanel —— 风险指标', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('三项指标始终渲染：VaR 保留两位百分比、连亏次数、平均持仓天数带「天」', () => {
    const { container } = renderPanel(makeReport());

    expect(screen.getByText('风险指标')).toBeInTheDocument();
    const labels = Array.from(container.querySelectorAll('.quant-risk-metric-label')).map(
      (l) => l.textContent,
    );
    expect(labels).toEqual(['VaR (95%)', '最大连亏次数', '平均持仓天数']);
    const values = Array.from(container.querySelectorAll('.quant-risk-metric-val')).map(
      (v) => v.textContent,
    );
    expect(values).toEqual(['2.50%', '4', '7天']);
  });

  it('零值照常显示为 0.00% / 0 / 0天，不被替换成占位符', () => {
    const { container } = renderPanel(
      makeReport({ riskMetrics: { var95: 0, maxConsecutiveLoss: 0, avgHoldingDays: 0 } }),
    );

    const values = Array.from(container.querySelectorAll('.quant-risk-metric-val')).map(
      (v) => v.textContent,
    );
    expect(values).toEqual(['0.00%', '0', '0天']);
  });

  it('负 VaR 与极大值按数值格式化：-1.234 → -1.23%、1e6 → 1000000.00%', () => {
    const { container, unmount } = renderPanel(
      makeReport({ riskMetrics: { var95: -1.234, maxConsecutiveLoss: 3, avgHoldingDays: 2 } }),
    );
    expect(container.querySelectorAll('.quant-risk-metric-val')[0]).toHaveTextContent('-1.23%');
    unmount();

    const second = renderPanel(
      makeReport({ riskMetrics: { var95: 1e6, maxConsecutiveLoss: 999, avgHoldingDays: 120 } }),
    );
    const values = Array.from(second.container.querySelectorAll('.quant-risk-metric-val')).map(
      (v) => v.textContent,
    );
    expect(values).toEqual(['1000000.00%', '999', '120天']);
  });

  it('风险指标块不受其它小节为空影响（无建议/无敏感性/无方向时仍在）', () => {
    const { container } = renderPanel(
      makeReport({ suggestions: [], parameterSensitivity: [], iterationDirections: [] }),
    );

    expect(screen.getByText('风险指标')).toBeInTheDocument();
    expect(container.querySelectorAll('.quant-risk-metric')).toHaveLength(3);
  });
});

describe('OptimizationPanel —— 迭代方向', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('有方向时列出全部条目（含圆点装饰）', () => {
    const { container } = renderPanel(makeReport());

    expect(screen.getByText('迭代方向')).toBeInTheDocument();
    const items = Array.from(container.querySelectorAll('.quant-iteration-item')).map(
      (i) => i.textContent,
    );
    expect(items).toEqual(['引入波动率过滤', '按行业中性化']);
    expect(container.querySelectorAll('.quant-iteration-dot')).toHaveLength(2);
  });

  it('iterationDirections 为空数组时整块不渲染', () => {
    const { container } = renderPanel(makeReport({ iterationDirections: [] }));

    expect(screen.queryByText('迭代方向')).toBeNull();
    expect(container.querySelector('.quant-iteration-list')).toBeNull();
  });
});

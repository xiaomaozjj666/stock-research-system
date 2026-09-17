// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import DataQualityPanel from '../DataQualityPanel';
import type { DataQualityReport } from '../types';

/**
 * DataQualityPanel 行为测试
 * ----------------------------------------------------------------------------
 * 关注三件事：总分档位配色（状态语义，**不是**涨跌色：>=80 状态绿 / >=60 强调蓝 /
 * 其余危险红）、进度条宽度与颜色是否与总分同源，以及「问题/建议」两块的显示条件。
 */

function makeQuality(over: Partial<DataQualityReport> = {}): DataQualityReport {
  return {
    overallScore: 92,
    totalRecords: 600,
    missingDates: [],
    outliers: [],
    duplicates: [],
    issues: ['缺失 3 个交易日', '成交量存在 0 值'],
    suggestions: ['前向填充缺失交易日', '剔除停牌日样本'],
    dataRange: { start: '2023-01-01', end: '2025-12-31', tradingDays: 720 },
    ...over,
  };
}

function renderPanel(data: DataQualityReport) {
  return render(<DataQualityPanel data={data} />);
}

function scoreEl(container: HTMLElement): HTMLElement {
  return container.querySelector('.quant-quality-score') as HTMLElement;
}

function barEl(container: HTMLElement): HTMLElement {
  return container.querySelector('.quant-quality-bar') as HTMLElement;
}

/** 总分 → 状态语义色档位（>=80 优秀 / >=60 良好 / 其余较差） */
const COLOR_CASES: { score: number; cls: string; note: string }[] = [
  { score: 100, cls: 'score-excellent', note: '满分' },
  { score: 80, cls: 'score-excellent', note: '80 为高档下限' },
  { score: 79.9, cls: 'score-good', note: '79.9 掉到中档' },
  { score: 60, cls: 'score-good', note: '60 为中档下限' },
  { score: 59.9, cls: 'score-poor', note: '59.9 掉到低档' },
  { score: 0, cls: 'score-poor', note: '0 分仍走低档色' },
];

describe('DataQualityPanel —— 总分与进度条', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const c of COLOR_CASES) {
    it(`${c.note}（${c.score}）用状态色 ${c.cls} 着色，进度条宽度同步为 ${c.score}%`, () => {
      const { container } = renderPanel(makeQuality({ overallScore: c.score }));

      expect(scoreEl(container)).toHaveTextContent(String(c.score));
      expect(scoreEl(container).className.split(/\s+/)).toContain(c.cls);
      expect(barEl(container).className.split(/\s+/)).toContain(`score-bar-${c.cls.slice(6)}`);
      expect(barEl(container).style.width).toBe(`${c.score}%`);
    });
  }

  it('不再借用涨跌色：不出现 val-positive / val-negative / --color-positive', () => {
    const { container } = renderPanel(makeQuality({ overallScore: 95 }));

    const html = container.innerHTML;
    expect(html).not.toContain('val-positive');
    expect(html).not.toContain('val-negative');
    expect(html).not.toContain('--color-positive');
    expect(html).not.toContain('--color-negative');
    // 配色只在类里，内联样式不该再带颜色
    expect(scoreEl(container).style.color).toBe('');
    expect(barEl(container).style.background).toBe('');
  });

  it('标题与满分口径固定为「数据质量报告」+ /100', () => {
    const { container } = renderPanel(makeQuality());

    expect(screen.getByRole('heading', { name: '数据质量报告' })).toBeInTheDocument();
    expect(scoreEl(container).textContent).toBe('92/100');
  });

  it('总分越界（-5）时钳制为 0：数字显示 0，进度条宽度 0%（不再出现"数字 -5、条形满格"）', () => {
    const { container } = renderPanel(makeQuality({ overallScore: -5 }));

    expect(scoreEl(container)).toHaveTextContent('0');
    expect(scoreEl(container).textContent).toBe('0/100');
    expect(barEl(container).style.width).toBe('0%');
  });

  it('总分超过 100（150）时钳制为 100：数字与进度条同步为 100', () => {
    const { container } = renderPanel(makeQuality({ overallScore: 150 }));

    expect(barEl(container).style.width).toBe('100%');
    expect(scoreEl(container).textContent).toBe('100/100');
  });
});

describe('DataQualityPanel —— 数据范围与计数', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('展示起止日期、交易日数与总记录数', () => {
    const { container } = renderPanel(makeQuality());

    const meta = container.querySelector('.quant-quality-meta')?.textContent ?? '';
    expect(meta).toContain('数据范围：2023-01-01 ~ 2025-12-31');
    expect(meta).toContain('交易日：720 天');
    expect(meta).toContain('总记录：600 条');
  });

  it('计数为 0 时照常显示 0 而不是被当成缺失', () => {
    const { container } = renderPanel(
      makeQuality({ totalRecords: 0, dataRange: { start: '—', end: '—', tradingDays: 0 } }),
    );

    const meta = container.querySelector('.quant-quality-meta')?.textContent ?? '';
    expect(meta).toContain('交易日：0 天');
    expect(meta).toContain('总记录：0 条');
  });

  it('极大记录数不做单位换算，原样带千分位缺失展示（现状：1000000000 条）', () => {
    const { container } = renderPanel(makeQuality({ totalRecords: 1e9 }));

    expect(container.querySelector('.quant-quality-meta')?.textContent).toContain(
      '总记录：1000000000 条',
    );
  });
});

describe('DataQualityPanel —— 发现问题与预处理建议', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('有问题时渲染「发现问题」小节，每条前带 ⚠ 图标', () => {
    const { container } = renderPanel(makeQuality());

    expect(screen.getByText('发现问题')).toBeInTheDocument();
    expect(screen.getByText('缺失 3 个交易日')).toBeInTheDocument();
    expect(screen.getByText('成交量存在 0 值')).toBeInTheDocument();
    const icons = Array.from(container.querySelectorAll('.quant-issue-icon')).map(
      (i) => i.textContent,
    );
    expect(icons).toEqual(['⚠', '⚠']);
  });

  it('issues 为空数组时不渲染「发现问题」小节', () => {
    const { container } = renderPanel(makeQuality({ issues: [] }));

    expect(screen.queryByText('发现问题')).toBeNull();
    expect(container.querySelector('.quant-issues')).toBeNull();
  });

  it('有建议时渲染「预处理建议」小节，按顺序列出全部条目', () => {
    const { container } = renderPanel(makeQuality());

    expect(screen.getByText('预处理建议')).toBeInTheDocument();
    const items = Array.from(container.querySelectorAll('.quant-suggestion-item')).map(
      (i) => i.textContent,
    );
    expect(items).toEqual(['前向填充缺失交易日', '剔除停牌日样本']);
  });

  it('suggestions 为空数组时不渲染「预处理建议」小节', () => {
    const { container } = renderPanel(makeQuality({ suggestions: [] }));

    expect(screen.queryByText('预处理建议')).toBeNull();
    expect(container.querySelector('.quant-suggestions')).toBeNull();
  });

  it('问题与建议都为空时只剩头部与元信息（空态不是空白）', () => {
    const { container } = renderPanel(makeQuality({ issues: [], suggestions: [] }));

    expect(container.querySelectorAll('li')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: '数据质量报告' })).toBeInTheDocument();
    expect(container.querySelector('.quant-quality-meta')).not.toBeNull();
  });
});

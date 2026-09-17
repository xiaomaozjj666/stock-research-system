// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import DataQualityPanel from '../DataQualityPanel';
import type { DataQualityReport } from '../types';

/**
 * DataQualityPanel 行为测试
 * ----------------------------------------------------------------------------
 * 关注三件事：总分档位配色（>=80 绿?不——本项目 --color-positive 为红）、
 * 进度条宽度与颜色是否与总分同源，以及「问题/建议」两块的显示条件。
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

/** 总分 → 颜色档位（>=80 / >=60 / 其余） */
const COLOR_CASES: { score: number; color: string; note: string }[] = [
  { score: 100, color: 'var(--color-positive)', note: '满分' },
  { score: 80, color: 'var(--color-positive)', note: '80 为高档下限' },
  { score: 79.9, color: 'var(--color-warning)', note: '79.9 掉到中档' },
  { score: 60, color: 'var(--color-warning)', note: '60 为中档下限' },
  { score: 59.9, color: 'var(--color-negative)', note: '59.9 掉到低档' },
  { score: 0, color: 'var(--color-negative)', note: '0 分仍走低档色' },
];

describe('DataQualityPanel —— 总分与进度条', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const c of COLOR_CASES) {
    it(`${c.note}（${c.score}）用 ${c.color} 着色，进度条宽度同步为 ${c.score}%`, () => {
      const { container } = renderPanel(makeQuality({ overallScore: c.score }));

      expect(scoreEl(container)).toHaveTextContent(String(c.score));
      expect(scoreEl(container).style.color).toBe(c.color);
      expect(barEl(container).style.width).toBe(`${c.score}%`);
      expect(barEl(container).style.background).toBe(c.color);
    });
  }

  it('标题与满分口径固定为「数据质量报告」+ /100', () => {
    const { container } = renderPanel(makeQuality());

    expect(screen.getByRole('heading', { name: '数据质量报告' })).toBeInTheDocument();
    expect(scoreEl(container).textContent).toBe('92/100');
  });

  it('总分越界（-5）时宽度声明被丢弃，进度条退化成满格（现状：未做 0~100 钳制）', () => {
    const { container } = renderPanel(makeQuality({ overallScore: -5 }));

    // '-5%' 不是合法 CSS 长度，浏览器与 jsdom 都会丢掉这条声明；
    // .quant-quality-bar 自身没有 width（block 元素），于是整条轨道被填满——
    // 数字写着 -5，条形却显示 100%，属展示口径不一致。
    expect(scoreEl(container)).toHaveTextContent('-5');
    expect(barEl(container).style.width).toBe('');
    expect(barEl(container).getAttribute('style')).not.toContain('width');
  });

  it('总分超过 100（150）时宽度照写成 150%，不做上限钳制', () => {
    const { container } = renderPanel(makeQuality({ overallScore: 150 }));

    expect(barEl(container).style.width).toBe('150%');
    expect(scoreEl(container).textContent).toBe('150/100');
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

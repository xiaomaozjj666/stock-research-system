// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import FinancialSection from '../FinancialSection';

afterEach(cleanup);

function cellTexts(container: HTMLElement): string[][] {
  return [...container.querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''),
  );
}

describe('FinancialSection', () => {
  it('没有年份数据时整块不渲染', () => {
    const { container } = render(<FinancialSection data={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it('完整数据：首列不带同比，正/负/零增长分别带箭头与色值类', () => {
    const { container } = render(
      <FinancialSection
        data={{
          years: ['2023', '2024', '2025'],
          revenue: [100, 120, 90],
          netProfit: [10, 10, 10],
          grossMargin: [50, 52.5, 47.25],
          netMargin: [10, 11, 12],
          roe: [15, 16, 17],
          operatingCashFlow: [8, 9, 10],
          eps: [1.5, 1.65, 1.8],
        }}
      />,
    );

    const rows = cellTexts(container);
    const revenue = rows[0];
    expect(revenue[1]).toBe('100.0'); // 首列不显示同比
    expect(revenue[2]).toContain('120.0');
    expect(revenue[2]).toContain('↑20.0%');
    expect(revenue[3]).toContain('↓25.0%');
    expect(container.querySelectorAll('.val-positive').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.val-negative').length).toBeGreaterThan(0);

    const netProfit = rows[1];
    expect(netProfit[2]).toContain('0.0%');
    expect(netProfit[2]).not.toContain('↑');
    expect(netProfit[2]).not.toContain('↓');
    expect(container.querySelectorAll('.val-neutral').length).toBeGreaterThan(0);

    // 百分比/货币/普通数值三种格式
    expect(rows[2][2]).toContain('52.5%');
    expect(rows[6][2]).toContain('1.65');
  });

  it('缺指标/缺中间值：显示占位符且不回退成 NaN%', () => {
    const { container } = render(
      <FinancialSection
        data={{
          years: ['2023', '2024', '2025'],
          revenue: [100, undefined, 130],
          // 除 revenue 外全部缺失：应整行显示 —
          roe: [0, 0, 5],
        }}
      />,
    );

    const rows = cellTexts(container);
    expect(rows[0]).toEqual(['营业收入(亿)', '100.0', '—', '130.0']);
    // 整行指标缺失时不渲染空的年份单元格（只有标签列）
    expect(rows[1]).toEqual(['净利润(亿)']);
    // prev=0 不计算同比，也不出现 NaN
    expect(rows.find((r) => r[0] === 'ROE')?.[2]).toBe('0.0%');
    expect(container.textContent).not.toContain('NaN');
  });
});

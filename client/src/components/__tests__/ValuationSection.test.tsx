// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ValuationSection from '../ValuationSection';

/**
 * ValuationSection 行为测试
 * ----------------------------------------------------------------------------
 * 重点在「缺失值不得被当成实测值展示」：
 * - 总市值缺失 / 非有限值（NaN、Infinity）/ 非正数一律显示「—」；
 *   此前只判 `!cap`，Infinity 会被渲染成「Infinity万亿」、负数会被渲染成「-5亿」。
 * - PE/PB/PS 走同一套非有限性判断（`NaN.toFixed()` 会原样输出 "NaN"）。
 */

function renderSection(data: Parameters<typeof ValuationSection>[0]['data']) {
  return render(<ValuationSection data={data} stockName="贵州茅台" />);
}

/** 取「总市值」卡片的值 */
function capValue(container: HTMLElement): string {
  const cards = Array.from(container.querySelectorAll('.val-card'));
  const card = cards.find((c) => c.querySelector('.val-card-label')?.textContent === '总市值');
  return card?.querySelector('.val-card-value')?.textContent ?? '';
}

describe('ValuationSection —— 总市值展示口径', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('正常值按「亿」展示，达到一万亿（10000 亿）改按「万亿」', () => {
    const { container, unmount } = renderSection({ marketCap: 2300 });
    expect(capValue(container)).toBe('2300亿');
    unmount();

    const big = renderSection({ marketCap: 23000 });
    expect(capValue(big.container)).toBe('2.3万亿');
  });

  it('marketCap 缺失时显示「—」，不显示 undefined / NaN', () => {
    const { container } = renderSection({});

    expect(capValue(container)).toBe('—');
  });

  it('marketCap 为 Infinity / -100 等非有限或非正值时显示「—」，不印成实测值', () => {
    const inf = renderSection({ marketCap: Number.POSITIVE_INFINITY });
    expect(capValue(inf.container)).toBe('—');
    expect(capValue(inf.container)).not.toContain('Infinity');
    inf.unmount();

    const nan = renderSection({ marketCap: Number.NaN });
    expect(capValue(nan.container)).toBe('—');
    nan.unmount();

    const negative = renderSection({ marketCap: -100 });
    expect(capValue(negative.container)).toBe('—');
    expect(capValue(negative.container)).not.toContain('-');
  });
});

describe('ValuationSection —— 估值倍数与同业对比', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PE / PB / PS 为 NaN 时显示「—」而不是 "NaN"', () => {
    const { container } = renderSection({
      pe: Number.NaN,
      pb: Number.NaN,
      ps: Number.POSITIVE_INFINITY,
    });

    const values = Array.from(container.querySelectorAll('.val-card-value')).map(
      (v) => v.textContent,
    );
    expect(values).toEqual(['—', '—', '—', '—']);
  });

  it('同业对比表里缺失的市值同样按「—」处理（不出现 Infinity）', () => {
    const { container } = renderSection({
      marketCap: 1000,
      peerComparison: [
        { name: '同行A', code: '000001', pe: 12.3, pb: 1.2, roe: 15, marketCap: Number.NaN },
      ],
    });

    const rows = Array.from(container.querySelectorAll('.peer-table tbody tr'));
    const peerCells = Array.from(rows[1].querySelectorAll('td')).map((td) => td.textContent);
    expect(peerCells[4]).toBe('—');
    expect(peerCells[1]).toBe('12.3');
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  });
});

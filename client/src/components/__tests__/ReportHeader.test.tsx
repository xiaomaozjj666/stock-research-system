// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReportHeader from '../ReportHeader';

const base = {
  stock_code: '600519',
  stock_name: '贵州茅台',
  industry: '白酒',
  total_score: 85,
  rating: '优先跟踪',
};

describe('ReportHeader 较上次分析（记忆反思闭环）', () => {
  it('无 vs_previous 时不渲染对比标签', () => {
    render(<ReportHeader data={base} />);
    expect(screen.queryByText(/较上次分析/)).toBeNull();
  });

  it('评分上升显示 ▲ 与正增量（红涨）', () => {
    render(
      <ReportHeader
        data={{
          ...base,
          vs_previous: {
            previous_date: '2026-07-01',
            previous_rating: '持续观察',
            previous_score: 78,
            score_delta: 7,
            rating_changed: true,
          },
        }}
      />,
    );
    const tag = screen.getByText(/较上次分析/);
    expect(tag.textContent).toContain('▲');
    expect(tag.textContent).toContain('+7');
    expect(tag.textContent).toContain('评级 持续观察 → 优先跟踪');
    expect(tag.className).toContain('vs-previous-up');
  });

  it('评分下降显示 ▼ 与负增量（绿跌），评级未变不重复评级', () => {
    render(
      <ReportHeader
        data={{
          ...base,
          rating: '持续观察',
          total_score: 60,
          vs_previous: {
            previous_date: '2026-07-01',
            previous_rating: '持续观察',
            previous_score: 72,
            score_delta: -12,
            rating_changed: false,
          },
        }}
      />,
    );
    const tag = screen.getByText(/较上次分析/);
    expect(tag.textContent).toContain('▼');
    expect(tag.textContent).toContain('-12');
    expect(tag.textContent).not.toContain('评级');
    expect(tag.className).toContain('vs-previous-down');
  });

  it('评分持平显示 ＝ 且无符号', () => {
    render(
      <ReportHeader
        data={{
          ...base,
          vs_previous: {
            previous_date: '2026-07-01',
            previous_rating: '优先跟踪',
            previous_score: 85,
            score_delta: 0,
            rating_changed: false,
          },
        }}
      />,
    );
    const tag = screen.getByText(/较上次分析/);
    expect(tag.textContent).toContain('＝');
    expect(tag.textContent).toContain('0 分');
    expect(tag.className).toContain('vs-previous-flat');
  });
});

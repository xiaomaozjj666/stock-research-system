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

describe('ReportHeader 专家覆盖度（degraded_experts）', () => {
  it('无降级时不渲染覆盖度标签', () => {
    render(<ReportHeader data={base} />);
    expect(screen.queryByText(/位专家降级未参与/)).toBeNull();
  });

  it('有降级时显示人数，title 带降级名单与置信度提示', () => {
    render(<ReportHeader data={{ ...base, degraded_experts: ['政策专家', '解禁专家'] }} />);
    const tag = screen.getByText(/位专家降级未参与/);
    expect(tag.textContent).toContain('2 位专家降级未参与');
    expect(tag.getAttribute('title')).toContain('政策专家、解禁专家');
    expect(tag.getAttribute('title')).toContain('置信度相应下调');
  });
});

describe('ReportHeader 评级事后校准（rating_accuracy）', () => {
  it('样本不足（accuracyPct 为 null）时不渲染命中率标签', () => {
    render(
      <ReportHeader
        data={{
          ...base,
          rating_accuracy: {
            stock: {
              sampleCount: 1,
              judgedCount: 1,
              hitCount: 1,
              accuracyPct: null,
              avgReturnPct: 5,
            },
            overall: {
              sampleCount: 1,
              judgedCount: 1,
              hitCount: 1,
              accuracyPct: null,
              avgReturnPct: 5,
            },
          },
        }}
      />,
    );
    expect(screen.queryByText(/历史命中率/)).toBeNull();
  });

  it('样本充足时显示命中率与命中次数，title 带平均区间收益', () => {
    render(
      <ReportHeader
        data={{
          ...base,
          rating_accuracy: {
            stock: {
              sampleCount: 3,
              judgedCount: 3,
              hitCount: 2,
              accuracyPct: 66.67,
              avgReturnPct: 4.5,
            },
            overall: {
              sampleCount: 12,
              judgedCount: 10,
              hitCount: 7,
              accuracyPct: 70,
              avgReturnPct: 3.2,
            },
          },
        }}
      />,
    );
    const tag = screen.getByText(/历史命中率/);
    expect(tag.textContent).toContain('66.67%');
    expect(tag.textContent).toContain('（2/3）');
    expect(tag.getAttribute('title')).toContain('3 次方向判断命中 2 次');
    expect(tag.getAttribute('title')).toContain('平均区间收益 4.5%');
  });
});

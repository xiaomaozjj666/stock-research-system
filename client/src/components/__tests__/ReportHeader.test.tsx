// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
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

describe('ReportHeader 报告时间语境', () => {
  it('缺 generatedAt / dataAsOf 时不渲染时间信息（兼容改动前保存的历史记录）', () => {
    render(<ReportHeader data={base} />);
    expect(screen.queryByText(/数据截止/)).toBeNull();
    expect(screen.queryByText(/生成于/)).toBeNull();
  });

  it('渲染数据截止日与生成时间（本地时区 YYYY-MM-DD HH:mm）', () => {
    render(
      <ReportHeader data={base} generatedAt="2026-09-16T13:30:00.000Z" dataAsOf="2026-09-15" />,
    );
    const cutoff = screen.getByText(/数据截止/).textContent || '';
    expect(cutoff).toContain('2026-09-15');
    expect(cutoff).toContain('收盘');
    // 生成时间用本地时区格式化，只断言格式（避免测试机时区差异导致脆断言）
    expect(screen.getByText(/生成于/).textContent || '').toMatch(
      /生成于：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/,
    );
  });

  it('数据截止明显滞后（>5 天）时给出"可能滞后"提示', () => {
    const stale = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    render(<ReportHeader data={base} dataAsOf={stale} />);
    expect(screen.getByText(/数据截止/).textContent || '').toContain('可能滞后');
  });

  it('数据截止为最近交易日时不给滞后提示（避免天天报警）', () => {
    const fresh = new Date().toISOString().slice(0, 10);
    render(<ReportHeader data={base} dataAsOf={fresh} />);
    expect(screen.getByText(/数据截止/).textContent || '').not.toContain('可能滞后');
  });
});

describe('ReportHeader 打印友好（.no-print）', () => {
  it('导出 / 打印按钮带 no-print：按钮不该被印进报告纸面', () => {
    render(<ReportHeader data={base} onExport={vi.fn()} />);

    const buttons = [
      screen.getByRole('button', { name: '导出报告' }),
      screen.getByRole('button', { name: '打印' }),
    ];
    for (const btn of buttons) {
      expect(btn.className.split(/\s+/)).toContain('no-print');
    }
    // 容器本身也带，避免两个按钮都被改成其它类名时整块动作区又出现在纸上
    expect(buttons[0].parentElement?.className.split(/\s+/)).toContain('no-print');
  });

  it('未传 onExport 时只剩打印按钮，且同样带 no-print', () => {
    render(<ReportHeader data={base} />);

    expect(screen.queryByRole('button', { name: '导出报告' })).toBeNull();
    expect(screen.getByRole('button', { name: '打印' }).className.split(/\s+/)).toContain(
      'no-print',
    );
  });

  it('报告正文（股票名 / 评分 / 评级）不带 no-print，仍会印出来', () => {
    render(<ReportHeader data={base} />);

    expect(screen.getByText('贵州茅台').className.split(/\s+/)).not.toContain('no-print');
    expect(screen.getByText('85').className.split(/\s+/)).not.toContain('no-print');
    expect(screen.getByText('优先跟踪').className.split(/\s+/)).not.toContain('no-print');
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import QuantPage from '../QuantPage';
import type { QuantResearchReport } from '../types';

const mocks = vi.hoisted(() => {
  class AnalysisCancelledError extends Error {
    constructor(message = '量化分析已取消') {
      super(message);
      this.name = 'AnalysisCancelledError';
    }
  }
  return {
    runQuantAnalysis: vi.fn(),
    showToast: vi.fn(),
    AnalysisCancelledError,
  };
});

vi.mock('../../../api/client', () => ({
  runQuantAnalysis: mocks.runQuantAnalysis,
  AnalysisCancelledError: mocks.AnalysisCancelledError,
}));
vi.mock('../../../components/Toast', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../StrategyInput', () => ({
  default: ({ onSubmit, loading }: { onSubmit: (c: unknown) => void; loading: boolean }) => (
    <button
      type="button"
      data-testid="strategy-submit"
      disabled={loading}
      onClick={() => onSubmit({ fast: 5, slow: 20 })}
    >
      开始研究
    </button>
  ),
}));
vi.mock('../BacktestChart', () => ({ default: () => <div data-testid="backtest" /> }));
vi.mock('../DataQualityPanel', () => ({ default: () => <div data-testid="data-quality" /> }));
vi.mock('../AuditPanel', () => ({ default: () => <div data-testid="audit" /> }));
vi.mock('../OptimizationPanel', () => ({ default: () => <div data-testid="optimization" /> }));
vi.mock('../ReportSummary', () => ({ default: () => <div data-testid="summary" /> }));
vi.mock('../FactorPanel', () => ({ default: () => <div data-testid="factors" /> }));
vi.mock('../../../components/NewsSentimentCard', () => ({
  default: () => <div data-testid="news-card" />,
}));
vi.mock('../CompositeBatchPanel', () => ({ default: () => <div data-testid="batch-panel" /> }));
vi.mock('../CrossSectionPanel', () => ({
  default: ({ active }: { active: boolean }) => (
    <div data-testid="cross-panel" data-active={String(active)} />
  ),
}));
vi.mock('../FactorLabPanel', () => ({ default: () => <div data-testid="factor-lab" /> }));
vi.mock('../DigestPanel', () => ({ default: () => <div data-testid="digest" /> }));
vi.mock('../ValuationPanel', () => ({ default: () => <div data-testid="valuation" /> }));

function makeReport(over: Record<string, unknown> = {}): QuantResearchReport {
  return {
    stockCode: '600519',
    backtest: {
      totalReturn: 12,
      annualizedReturn: 8,
      sharpeRatio: 1.2,
      maxDrawdown: -9,
      winRate: 55,
      tradeCount: 20,
      profitFactor: 1.5,
      equityCurve: [],
      trades: [],
    },
    dataQuality: {},
    audit: {},
    optimization: {},
    ...over,
  } as unknown as QuantResearchReport;
}

/** 对比表中某一行的「变化」单元格 */
function deltaCell(label: string): HTMLElement {
  const row = screen.getByText(label).closest('tr') as HTMLElement;
  return row.querySelectorAll('td')[3] as HTMLElement;
}

function paneOf(testId: string): HTMLElement {
  return screen.getByTestId(testId).closest('.quant-mode-pane') as HTMLElement;
}

beforeEach(() => {
  mocks.runQuantAnalysis.mockReset();
  mocks.showToast.mockReset();
  mocks.runQuantAnalysis.mockResolvedValue(makeReport());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('QuantPage —— 三种模式的切换与常驻挂载', () => {
  it('默认单股研究：展示策略配置与最新消息控件，右侧为空态', () => {
    render(<QuantPage />);
    expect(screen.getByRole('group', { name: '量化模式' })).toBeInTheDocument();
    expect(screen.getByText('策略配置')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText(/配置左侧策略后点击「开始研究」/)).toBeInTheDocument();
  });

  it('切到批量测算：给出口径说明，且不影响已挂载的其它面板', () => {
    render(<QuantPage />);
    fireEvent.click(screen.getByRole('button', { name: '批量测算' }));
    expect(screen.getByText(/逐只计算方向性组合 alpha/)).toBeInTheDocument();
    expect(paneOf('batch-panel')).not.toHaveAttribute('hidden');
    expect(paneOf('cross-panel')).toHaveAttribute('hidden');
  });

  it('切到截面因子：把 active 传下去（面板据此决定是否轮询），切走即撤销', () => {
    render(<QuantPage />);
    fireEvent.click(screen.getByRole('button', { name: '截面因子' }));
    expect(screen.getByText(/横截面因子评估/)).toBeInTheDocument();
    expect(screen.getByTestId('cross-panel')).toHaveAttribute('data-active', 'true');

    fireEvent.click(screen.getByRole('button', { name: '单股研究' }));
    expect(screen.getByTestId('cross-panel')).toHaveAttribute('data-active', 'false');
  });

  it('批量/截面面板常驻挂载（用 hidden 隐藏而非卸载，几十秒的测算结果不会因切页丢失）', () => {
    render(<QuantPage />);
    // 默认在单股模式，但另两个模式的面板仍在 DOM 中
    expect(paneOf('batch-panel')).toHaveAttribute('hidden');
    expect(screen.getByTestId('cross-panel')).toBeInTheDocument();
    expect(screen.getByTestId('factor-lab')).toBeInTheDocument();
    expect(screen.getByTestId('digest')).toBeInTheDocument();
    expect(screen.getByTestId('valuation')).toBeInTheDocument();
  });
});

describe('QuantPage —— 提交研究', () => {
  it('提交后展示进行中面板与取消入口，空态让位', async () => {
    mocks.runQuantAnalysis.mockReturnValue(new Promise(() => {}));
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));

    expect(await screen.findByText('研究进行中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消研究' })).toBeInTheDocument();
    expect(screen.queryByText(/配置左侧策略后点击「开始研究」/)).toBeNull();
  });

  it('完成后渲染完整报告各分区并弹出耗时提示', async () => {
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));

    expect(await screen.findByTestId('summary')).toBeInTheDocument();
    expect(screen.getByTestId('backtest')).toBeInTheDocument();
    expect(screen.getByTestId('data-quality')).toBeInTheDocument();
    expect(screen.getByTestId('audit')).toBeInTheDocument();
    expect(screen.getByTestId('optimization')).toBeInTheDocument();
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/^研究完成，总耗时 \d+ 秒$/),
    );
    expect(screen.queryByText('研究进行中')).toBeNull();
  });

  it('已耗时是真实计时（每秒 +1），不是伪造的阶段进度', async () => {
    vi.useFakeTimers();
    mocks.runQuantAnalysis.mockReturnValue(new Promise(() => {}));
    render(<QuantPage />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('strategy-submit'));
    });
    const elapsed = () => document.querySelector('.quant-elapsed-time b')?.textContent;
    expect(elapsed()).toBe('0');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(elapsed()).toBe('3');
  });

  it('没有量价因子数据时不渲染因子面板（避免空卡片）', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(makeReport({ priceVolumeFactors: [] }));
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByTestId('summary');
    expect(screen.queryByTestId('factors')).toBeNull();
  });

  it('有量价因子数据时渲染因子面板', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(
      makeReport({ priceVolumeFactors: [{ name: '动量', ic: 0.03 }] }),
    );
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    expect(await screen.findByTestId('factors')).toBeInTheDocument();
  });
});

describe('QuantPage —— 最新消息参数', () => {
  it('粘贴的多行消息被解析为 newsItems（去空行、逐行 trim）', async () => {
    render(<QuantPage />);
    fireEvent.change(screen.getByLabelText('粘贴最新消息（每行一条，自动情绪打分）'), {
      target: { value: '  公司中标大单  \n\n机构下调评级至中性\n' },
    });
    fireEvent.click(screen.getByTestId('strategy-submit'));

    await waitFor(() => expect(mocks.runQuantAnalysis).toHaveBeenCalled());
    const payload = mocks.runQuantAnalysis.mock.calls[0][0] as {
      newsItems?: { id: string; title: string }[];
      useNews: boolean;
    };
    expect(payload.newsItems?.map((n) => n.title)).toEqual(['公司中标大单', '机构下调评级至中性']);
    expect(payload.newsItems?.[0].id).toBe('pasted-0');
    // 有粘贴消息时不再实时抓取
    expect(payload.useNews).toBe(false);
  });

  it('未粘贴消息且未勾选时 useNews=false（不额外抓新闻，省时间）', async () => {
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await waitFor(() => expect(mocks.runQuantAnalysis).toHaveBeenCalled());
    const payload = mocks.runQuantAnalysis.mock.calls[0][0] as {
      newsItems?: unknown;
      useNews: boolean;
    };
    expect(payload.newsItems).toBeUndefined();
    expect(payload.useNews).toBe(false);
  });

  it('勾选"启用最新消息情绪叠加"后 useNews=true（勾选框是唯一口径）', async () => {
    render(<QuantPage />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await waitFor(() => expect(mocks.runQuantAnalysis).toHaveBeenCalled());
    expect((mocks.runQuantAnalysis.mock.calls[0][0] as { useNews: boolean }).useNews).toBe(true);
  });

  it('取消勾选后 useNews=false（未勾选不再偷偷实时抓新闻）', async () => {
    render(<QuantPage />);
    const box = screen.getByRole('checkbox');
    fireEvent.click(box);
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await waitFor(() => expect(mocks.runQuantAnalysis).toHaveBeenCalled());
    expect((mocks.runQuantAnalysis.mock.calls[0][0] as { useNews: boolean }).useNews).toBe(false);
  });

  it('粘贴消息时 useNews 仍如实反映勾选状态（粘贴内容在服务端优先）', async () => {
    render(<QuantPage />);
    fireEvent.change(screen.getByLabelText('粘贴最新消息（每行一条，自动情绪打分）'), {
      target: { value: '公司中标大单' },
    });
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await waitFor(() => expect(mocks.runQuantAnalysis).toHaveBeenCalled());
    const payload = mocks.runQuantAnalysis.mock.calls[0][0] as {
      newsItems?: { title: string }[];
      useNews: boolean;
    };
    expect(payload.newsItems?.map((n) => n.title)).toEqual(['公司中标大单']);
    expect(payload.useNews).toBe(false);
  });
});

describe('QuantPage —— 取消与失败处理', () => {
  it('取消按钮中止在途请求，并以 toast 静默收尾（不渲染成失败）', async () => {
    let rejectRun: (e: unknown) => void = () => {};
    let signal: AbortSignal | undefined;
    mocks.runQuantAnalysis.mockImplementation((_p: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise((_res, rej) => {
        rejectRun = rej;
      });
    });
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByText('研究进行中');

    fireEvent.click(screen.getByRole('button', { name: '取消研究' }));
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      rejectRun(new mocks.AnalysisCancelledError());
    });
    expect(mocks.showToast).toHaveBeenCalledWith('已取消本次研究');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('失败时展示具体原因（不是一句通用失败）并提供重试与关闭', async () => {
    mocks.runQuantAnalysis.mockRejectedValue(new Error('请求超时：分析耗时超过预期，请稍后重试'));
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('请求超时：分析耗时超过预期，请稍后重试');
    expect(banner).toHaveTextContent('（可点「重试」用相同参数重跑）');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
    // 失败后不应被空态掩盖
    expect(screen.queryByText(/配置左侧策略后点击「开始研究」/)).toBeNull();
  });

  it('重试使用与首次完全相同的参数', async () => {
    mocks.runQuantAnalysis.mockRejectedValue(new Error('后端服务异常（500）'));
    render(<QuantPage />);
    fireEvent.change(screen.getByLabelText('粘贴最新消息（每行一条，自动情绪打分）'), {
      target: { value: '公司中标大单' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(mocks.runQuantAnalysis).toHaveBeenCalledTimes(2));

    // publishedAt 由提交时刻生成，比较时只对齐有语义的部分
    const shape = (call: unknown[]) => {
      const p = call[0] as {
        strategy: unknown;
        useNews: boolean;
        newsItems?: { title: string }[];
      };
      return { strategy: p.strategy, useNews: p.useNews, titles: p.newsItems?.map((n) => n.title) };
    };
    expect(shape(mocks.runQuantAnalysis.mock.calls[1])).toEqual(
      shape(mocks.runQuantAnalysis.mock.calls[0]),
    );
  });

  it('关闭错误横幅后回到空态', async () => {
    mocks.runQuantAnalysis.mockRejectedValue(new Error('后端服务异常（500）'));
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/配置左侧策略后点击「开始研究」/)).toBeInTheDocument();
  });

  it('切换子模式不会清掉错误（否则用户再也无法复现/重跑）', async () => {
    mocks.runQuantAnalysis.mockRejectedValue(new Error('上游行情源不可用'));
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: '批量测算' }));
    fireEvent.click(screen.getByRole('button', { name: '单股研究' }));
    expect(screen.getByRole('alert')).toHaveTextContent('上游行情源不可用');
  });

  it('非 Error 抛出时给出兜底文案', async () => {
    mocks.runQuantAnalysis.mockRejectedValue('boom');
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '量化研究失败，请检查后端服务是否启动',
    );
  });

  it('重新提交时清掉上一次的错误横幅', async () => {
    mocks.runQuantAnalysis.mockRejectedValueOnce(new Error('第一次失败'));
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByRole('alert');

    mocks.runQuantAnalysis.mockResolvedValue(makeReport());
    fireEvent.click(screen.getByTestId('strategy-submit'));
    expect(await screen.findByTestId('summary')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('组件卸载时中止在途请求（不再向已卸载组件写状态）', async () => {
    let signal: AbortSignal | undefined;
    mocks.runQuantAnalysis.mockImplementation((_p: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    const { unmount } = render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByText('研究进行中');

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('研究进行中禁用策略提交与消息输入，避免重复提交', async () => {
    mocks.runQuantAnalysis.mockReturnValue(new Promise(() => {}));
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByText('研究进行中');
    expect(screen.getByTestId('strategy-submit')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByLabelText('粘贴最新消息（每行一条，自动情绪打分）')).toBeDisabled();
  });
});

describe('QuantPage —— 含最新消息 vs 不含新闻 对比表', () => {
  const BASE = makeReport().backtest as unknown as Record<string, number>;
  const withNews = (aware: Record<string, number> = {}, baseline: Record<string, number> = {}) =>
    makeReport({
      newsSentiment: { hasNews: true },
      backtest: { ...BASE, ...aware },
      backtestBaseline: { ...BASE, ...baseline },
    });

  it('仅有新闻时展示新闻卡与对比表', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(withNews());
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    expect(await screen.findByTestId('news-card')).toBeInTheDocument();
    expect(screen.getByText('含最新消息 vs 不含新闻（回测对比）')).toBeInTheDocument();
  });

  it('没有新闻时不展示对比表（避免出现一屏空表）', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(makeReport());
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByTestId('summary');
    expect(screen.queryByText('含最新消息 vs 不含新闻（回测对比）')).toBeNull();
  });

  it('变化列按数值方向着色：正红负绿（与全站 signCls 口径一致）', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(
      withNews(
        { totalReturn: 12, maxDrawdown: -9, sharpeRatio: 1.2 },
        { totalReturn: 8, maxDrawdown: -15, sharpeRatio: 0.9 },
      ),
    );
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByText('含最新消息 vs 不含新闻（回测对比）');

    expect(deltaCell('总收益率')).toHaveTextContent('+4.00%');
    expect(deltaCell('总收益率')).toHaveClass('val-positive');
    // 回撤收窄 = 数值变大 = 红：此前这一行整列反色（+6% 显示成绿色）
    expect(deltaCell('最大回撤')).toHaveTextContent('+6.00%');
    expect(deltaCell('最大回撤')).toHaveClass('val-positive');
    expect(deltaCell('夏普比率')).toHaveTextContent('+0.30');
  });

  it('指标变差时显示为负值并着绿', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(
      withNews({ totalReturn: 5, maxDrawdown: -18 }, { totalReturn: 12, maxDrawdown: -9 }),
    );
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByText('含最新消息 vs 不含新闻（回测对比）');

    expect(deltaCell('总收益率')).toHaveTextContent('-7.00%');
    expect(deltaCell('总收益率')).toHaveClass('val-negative');
    expect(deltaCell('最大回撤')).toHaveTextContent('-9.00%');
    expect(deltaCell('最大回撤')).toHaveClass('val-negative');
  });

  it('无变化时用中性色且不带正号（不误导成上涨）', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(
      withNews({ totalReturn: 9, winRate: 50 }, { totalReturn: 9, winRate: 50 }),
    );
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByText('含最新消息 vs 不含新闻（回测对比）');

    expect(deltaCell('总收益率')).toHaveTextContent('0.00%');
    expect(deltaCell('总收益率')).not.toHaveTextContent('+');
    expect(deltaCell('总收益率')).toHaveClass('val-neutral');
  });

  it('不再使用旧的 positive/negative 类（避免与 val-* 两套口径并存）', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(withNews({ totalReturn: 12 }, { totalReturn: 8 }));
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    await screen.findByText('含最新消息 vs 不含新闻（回测对比）');
    const classes = deltaCell('总收益率').className.split(/\s+/);
    expect(classes).not.toContain('positive');
    expect(classes).not.toContain('negative');
  });

  it('展示新闻姿态仓位系数与组合 alpha 叠加说明', async () => {
    mocks.runQuantAnalysis.mockResolvedValue(
      makeReport({
        newsSentiment: { hasNews: true },
        backtest: {
          ...(makeReport().backtest as object),
          newsPosture: 0.5,
          factorAware: true,
          factorDirection: 'long',
          factorPosture: 0.3,
        },
        backtestBaseline: makeReport().backtest,
      }),
    );
    render(<QuantPage />);
    fireEvent.click(screen.getByTestId('strategy-submit'));
    expect(await screen.findByText(/新闻姿态仓位系数：50%/)).toBeInTheDocument();
    expect(screen.getByText(/组合 alpha 信号叠加已生效（综合方向 long/)).toBeInTheDocument();
    expect(screen.getByText(/姿态仓位系数 30%/)).toBeInTheDocument();
  });
});

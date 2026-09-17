// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/Toast';
import FactorLabPanel from '../FactorLabPanel';
import type {
  FactorExperiment,
  FactorExperimentSummary,
  FactorPortfolioBacktest,
} from '../../../api/client';
import type * as ApiClient from '../../../api/client';

type FactorRunResult = Awaited<ReturnType<typeof ApiClient.runFactorExpression>>;

/**
 * 取消错误类必须与组件拿到的是同一个类对象（组件用 instanceof 判定），
 * 因此在本 hoisted 工厂里定义并回传给 mock 与测试共用。
 */
const api = vi.hoisted(() => {
  class AnalysisCancelledError extends Error {
    constructor(message = '分析已取消') {
      super(message);
      this.name = 'AnalysisCancelledError';
    }
  }
  return {
    AnalysisCancelledError,
    getUniverseBoards: vi.fn(),
    getFactorExperiments: vi.fn(),
    runFactorExpression: vi.fn(),
  };
});

vi.mock('../../../api/client', () => ({
  AnalysisCancelledError: api.AnalysisCancelledError,
  getUniverseBoards: api.getUniverseBoards,
  getFactorExperiments: api.getFactorExperiments,
  runFactorExpression: api.runFactorExpression,
}));

// 组合回测净值曲线走 EChart：真实 echarts 在 jsdom 下无法 init
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../../lib/echarts', () => ({ default: { init: echartsMock.init } }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubMatchMedia() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

/**
 * 板块列表：首项是「煤炭」（真实数据里按市值降序，首项往往过大过杂），
 * 白酒店铺不在首位——用来验证默认值走「名称优先级」而不是「取首项」。
 */
function boardsPayload() {
  return {
    boards: [
      { code: 'BK0478', name: '煤炭' },
      { code: 'BK0477', name: '白酒' },
      { code: 'BK0475', name: '银行' },
    ],
  };
}

function ledgerItem(over: Partial<FactorExperiment> = {}): FactorExperiment {
  return {
    id: 'e1',
    createdAt: '2026-09-15T02:00:00.000Z',
    source: 'expression',
    name: '20日反转',
    expression: 'close / mean(close, 20) - 1',
    universe: { board: 'BK0477', requested: 50, included: 42 },
    horizon: 21,
    sampleSize: 1260,
    icMean: 0.123,
    pValue: 0.045,
    oosStable: true,
    kept: true,
    ...over,
  };
}

function ledgerSummary(over: Partial<FactorExperimentSummary> = {}): FactorExperimentSummary {
  return {
    total: 12,
    kept: 3,
    bySource: { expression: 9, hypothesis: 3 },
    lastAt: '2026-09-15T02:00:00.000Z',
    keptExpectedFalse: 0.15,
    keptOosShare: 0.67,
    ...over,
  };
}

function ledgerPayload(
  over: Partial<{ items: FactorExperiment[]; summary: FactorExperimentSummary | null }> = {},
) {
  return { items: [ledgerItem()], summary: ledgerSummary(), ...over };
}

function portfolio(over: Partial<FactorPortfolioBacktest> = {}): FactorPortfolioBacktest {
  return {
    equityCurve: [
      { date: '2026-01-05', value: 1 },
      { date: '2026-02-05', value: 1.123 },
    ],
    benchmarkCurve: [
      { date: '2026-01-05', value: 1 },
      { date: '2026-02-05', value: 1.04 },
    ],
    rebalances: [],
    totalReturn: 12.3,
    annualizedReturn: 9.8,
    sharpe: 1.25,
    maxDrawdown: -6.4,
    winRate: 58,
    avgTurnover: 0.35,
    periods: 12,
    ...over,
  };
}

function runResult(over: Partial<FactorRunResult> = {}): FactorRunResult {
  return {
    stocksIncluded: Array.from({ length: 42 }, (_, i) => String(600000 + i)),
    stocksSkipped: [],
    factor: {
      name: '20日反转',
      report: {
        sampleSize: 1260,
        byPeriod: [
          {
            period: 21,
            ic: { mean: 0.123, pValue: 0.045, n: 1260 },
            oos: { stable: true },
            verdict: { effective: true, reasons: [] },
          },
          {
            period: 63,
            ic: { mean: -0.031, pValue: 0.42, n: 1240 },
            oos: { stable: false },
            verdict: { effective: false, reasons: ['不显著'] },
          },
        ],
      },
    },
    portfolio: null,
    ledger: { recorded: 2, total: 12 },
    ...over,
  };
}

/** 在途请求：abort 时以 AnalysisCancelledError 拒绝（对齐 api/client 的真实语义） */
function pendingRun() {
  let signal: AbortSignal | undefined;
  api.runFactorExpression.mockImplementation((_payload: unknown, s?: AbortSignal) => {
    signal = s;
    return new Promise((_resolve, reject) => {
      s?.addEventListener('abort', () => reject(new api.AnalysisCancelledError('因子评估已取消')));
    });
  });
  return { signalOf: () => signal };
}

function renderPanel() {
  return render(
    <ToastProvider>
      <FactorLabPanel />
    </ToastProvider>,
  );
}

const boardSelect = () => screen.getByRole('combobox');
const submitButton = () => screen.getByRole('button', { name: '评估因子假设' });

/** 取匹配元素合并后的可见文本（跨 text 节点，忽略子元素边界） */
function textOf(re: RegExp): string {
  return (screen.getByText(re).textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('FactorLabPanel —— 首次加载与可提交性', () => {
  beforeEach(() => {
    const chart = {
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    };
    echartsMock.init.mockReset();
    echartsMock.init.mockReturnValue(chart);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia();

    api.getUniverseBoards.mockReset();
    api.getFactorExperiments.mockReset();
    api.runFactorExpression.mockReset();
    api.getUniverseBoards.mockResolvedValue(boardsPayload());
    api.getFactorExperiments.mockResolvedValue(ledgerPayload());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('板块列表未到达时下拉禁用并显示「加载板块中…」，评估按钮被拦截', async () => {
    api.getUniverseBoards.mockReturnValue(new Promise(() => {}));
    api.getFactorExperiments.mockReturnValue(new Promise(() => {}));
    renderPanel();

    await waitFor(() => expect(api.getUniverseBoards).toHaveBeenCalled());
    expect(boardSelect()).toBeDisabled();
    expect(screen.getByText('加载板块中…')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute('title', '请填写表达式并选择板块');
  });

  it('板块加载成功后按名称优先级默认选中「白酒」，选项展示「名称（代码）」', async () => {
    renderPanel();

    await waitFor(() => expect(boardSelect()).toBeEnabled());
    expect(boardSelect()).toHaveValue('BK0477');
    expect(screen.getByRole('option', { name: '白酒（BK0477）' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '煤炭（BK0478）' })).toBeInTheDocument();
    // 板块就位 + 默认表达式非空 → 提交入口放行
    expect(submitButton()).toBeEnabled();
    expect(submitButton()).toHaveAttribute('title', '评估该因子假设');
  });

  it('板块列表没有白酒/银行时取首项作为默认', async () => {
    api.getUniverseBoards.mockResolvedValue({ boards: [{ code: 'BK0478', name: '煤炭' }] });
    renderPanel();

    await waitFor(() => expect(boardSelect()).toBeEnabled());
    expect(boardSelect()).toHaveValue('BK0478');
  });

  it('板块接口失败时说明原因并可就地重试（不再永远停在「加载板块中…」）', async () => {
    api.getUniverseBoards.mockRejectedValueOnce(new Error('行业板块列表获取失败'));
    renderPanel();

    await waitFor(() => expect(screen.getByText('20日反转')).toBeInTheDocument());
    expect(screen.getByText(/板块列表加载失败：行业板块列表获取失败/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '板块列表不可用' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '加载板块中…' })).toBeNull();
    expect(boardSelect()).toBeDisabled();

    api.getUniverseBoards.mockResolvedValue({ boards: [{ code: 'BK0477', name: '白酒' }] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(boardSelect()).toBeEnabled());
    expect(screen.getByRole('option', { name: '白酒（BK0477）' })).toBeInTheDocument();
    expect(screen.queryByText(/板块列表加载失败/)).toBeNull();
  });

  it('表达式为空时提交被拦截：按钮禁用且 title 提示需要表达式与板块', async () => {
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    const expression = screen.getByPlaceholderText('close / mean(close, 20) - 1');
    fireEvent.change(expression, { target: { value: '   ' } });

    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute('title', '请填写表达式并选择板块');

    fireEvent.click(submitButton());
    expect(api.runFactorExpression).not.toHaveBeenCalled();
  });

  it('切换板块后提交：请求按新选中的板块发出，而不是默认板块', async () => {
    api.runFactorExpression.mockResolvedValue(runResult());
    renderPanel();
    await waitFor(() => expect(boardSelect()).toBeEnabled());
    expect(boardSelect()).toHaveValue('BK0477');

    fireEvent.change(boardSelect(), { target: { value: 'BK0478' } });
    expect(boardSelect()).toHaveValue('BK0478');

    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText(/已入台账/)).toBeInTheDocument());
    const payload = api.runFactorExpression.mock.calls[0][0] as { board?: string };
    expect(payload.board).toBe('BK0478');
  });

  it('默认参数提交：请求带板块/成分股数/持有期与填写的表达式；未勾选组合回测时不带 portfolio', async () => {
    api.runFactorExpression.mockResolvedValue(runResult());
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.change(screen.getByPlaceholderText('close / mean(close, 20) - 1'), {
      target: { value: 'volume / mean(volume, 5)' },
    });
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '20' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByText(/已入台账/)).toBeInTheDocument());
    expect(api.runFactorExpression).toHaveBeenCalledTimes(1);
    const payload = api.runFactorExpression.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      expression: 'volume / mean(volume, 5)',
      board: 'BK0477',
      topN: 20,
      horizons: [21, 63],
    });
    expect(payload.portfolio).toBeUndefined();
    expect(api.getFactorExperiments).toHaveBeenCalledWith({ limit: 20 });
  });
});

describe('FactorLabPanel —— 结果渲染与统计口径', () => {
  beforeEach(() => {
    echartsMock.init.mockReset();
    echartsMock.init.mockReturnValue({
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia();

    api.getUniverseBoards.mockReset();
    api.getFactorExperiments.mockReset();
    api.runFactorExpression.mockReset();
    api.getUniverseBoards.mockResolvedValue(boardsPayload());
    // 台账留空：让「采信」等文案只在结果摘要里出现一次，避免多元素歧义
    api.getFactorExperiments.mockResolvedValue({ items: [], summary: ledgerSummary() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runOnce(result: FactorRunResult) {
    api.runFactorExpression.mockResolvedValue(result);
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText(/已入台账/)).toBeInTheDocument());
  }

  it('成功结果：渲染入组/观测/入台账摘要与每个持有期的 IC、p、OOS、采信结论', async () => {
    await runOnce(runResult());

    expect(textOf(/已入台账/)).toContain('入组 42 只 · 观测 1260 · 已入台账 2 条');

    const p21 = textOf(/21日：IC/);
    expect(p21).toContain('21日：IC 0.123');
    expect(p21).toContain('p=0.045');
    expect(p21).toContain('OOS稳定');
    expect(p21).toContain('采信');
    expect(p21).not.toContain('不采信');

    const p63 = textOf(/63日：IC/);
    expect(p63).toContain('63日：IC -0.031');
    expect(p63).toContain('p=0.420');
    expect(p63).toContain('OOS不稳');
    expect(p63).toContain('不采信');

    // 采信与否是统计显著性判定，走 .sig-* 色板而不是涨跌色
    expect(screen.getByText('采信').className).toContain('sig-valid');
    expect(screen.getByText('不采信').className).toContain('sig-none');
  });

  it('p 值小于 1e-4 显示 <1e-4；IC 非有限值显示破折号', async () => {
    await runOnce(
      runResult({
        factor: {
          name: '20日反转',
          report: {
            sampleSize: 300,
            byPeriod: [
              {
                period: 5,
                ic: { mean: Number.NaN, pValue: 0.00001, n: 300 },
                oos: { stable: false },
                verdict: { effective: false, reasons: [] },
              },
            ],
          },
        },
      }),
    );

    const row = textOf(/5日：IC/);
    expect(row).toContain('5日：IC —');
    expect(row).toContain('p=<1e-4');
  });

  it('结果数组为空时摘要退化为 0，且不渲染持有期行、不初始化图表', async () => {
    await runOnce(
      runResult({
        stocksIncluded: [],
        factor: { name: '空结果', report: { sampleSize: 0, byPeriod: [] } },
        ledger: { recorded: 0, total: 0 },
      }),
    );

    expect(textOf(/已入台账/)).toContain('入组 0 只 · 观测 0 · 已入台账 0 条');
    expect(screen.queryByText(/日：IC/)).toBeNull();
    expect(echartsMock.init).not.toHaveBeenCalled();
  });

  it('评估失败：渲染中文错误横幅，按钮恢复可点且再次提交即重试成功', async () => {
    api.runFactorExpression.mockRejectedValueOnce(
      new Error('因子表达式评估失败：板块内无可用样本'),
    );
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(screen.getByText('因子表达式评估失败：板块内无可用样本')).toBeInTheDocument(),
    );
    expect(submitButton()).toBeEnabled();

    api.runFactorExpression.mockResolvedValueOnce(runResult());
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText(/已入台账/)).toBeInTheDocument());
    expect(screen.queryByText('因子表达式评估失败：板块内无可用样本')).toBeNull();
  });

  it('非 Error 失败时用兜底文案，不把 undefined 渲染进横幅', async () => {
    api.runFactorExpression.mockRejectedValueOnce('boom');
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByText('因子表达式评估失败')).toBeInTheDocument());
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it('取消评估走静默收尾：只弹「已取消本次评估」，不渲染失败横幅', async () => {
    pendingRun();
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: '取消评估' }));

    await waitFor(() => expect(screen.getByText(/已取消本次评估/)).toBeInTheDocument());
    // 取消不是失败：错误对象本身不得被渲染成横幅
    expect(screen.queryByText('因子评估已取消')).toBeNull();
    expect(document.querySelector('.error-banner')).toBeNull();
    expect(submitButton()).toBeEnabled();
  });

  it('评估中显示计时与取消入口，已耗时随秒数递增', async () => {
    pendingRun();
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.click(submitButton());

    expect(screen.getByText(/已耗时 0 秒/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消评估' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '评估中…' })).toBeDisabled();

    await waitFor(() => expect(screen.getByText(/已耗时 [1-9]\d* 秒/)).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('卸载时中止在途评估请求（分钟级请求不再空转）', async () => {
    const { signalOf } = pendingRun();
    const { unmount } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.click(submitButton());
    await waitFor(() => expect(signalOf()).toBeDefined());
    expect(signalOf()?.aborted).toBe(false);

    unmount();
    expect(signalOf()?.aborted).toBe(true);
  });
});

describe('FactorLabPanel —— 组合回测', () => {
  let setOption: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const chart = {
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    };
    setOption = chart.setOption;
    echartsMock.init.mockReset();
    echartsMock.init.mockReturnValue(chart);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia();

    api.getUniverseBoards.mockReset();
    api.getFactorExperiments.mockReset();
    api.runFactorExpression.mockReset();
    api.getUniverseBoards.mockResolvedValue(boardsPayload());
    api.getFactorExperiments.mockResolvedValue({ items: [], summary: ledgerSummary() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runWithPortfolio(result: FactorRunResult, holdDays = '21', topN = '5') {
    api.runFactorExpression.mockResolvedValue(result);
    const view = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    // 未勾选前不出现组合参数输入
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('调仓周期（交易日）'), { target: { value: holdDays } });
    fireEvent.change(screen.getByLabelText('持仓只数'), { target: { value: topN } });

    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText(/已入台账/)).toBeInTheDocument());
    return view;
  }

  it('勾选「同时跑组合回测」才出现调仓周期/持仓只数，并按填写值提交 portfolio 参数', async () => {
    await runWithPortfolio(runResult({ portfolio: portfolio() }), '10', '3');

    const payload = api.runFactorExpression.mock.calls[0][0] as { portfolio?: unknown };
    expect(payload.portfolio).toEqual({ holdDays: 10, topN: 3 });
  });

  it('组合回测结果：渲染收益指标与净值曲线，总收益为正走红（val-positive）', async () => {
    const { container } = await runWithPortfolio(runResult({ portfolio: portfolio() }));

    const summary = textOf(/平均换手/);
    expect(summary).toContain('组合回测');
    expect(summary).toContain('（12 期 · 平均换手 35%）：总收益');
    expect(summary).toContain('年化 9.8%');
    expect(summary).toContain('夏普 1.25');
    expect(summary).toContain('最大回撤 -6.4%');
    expect(summary).toContain('周期胜率 58%');

    expect(screen.getByText('+12.3%').className).toContain('val-positive');

    expect(container.querySelector('.portfolio-curve')).not.toBeNull();
    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    const option = setOption.mock.calls[0][0] as {
      xAxis: { data: string[] };
      series: { name: string }[];
    };
    expect(option.series.map((s) => s.name)).toEqual(['组合', '宇宙等权基准']);
    expect(option.xAxis.data).toEqual(['2026-01-05', '2026-02-05']);
  });

  it('组合回测亏损时总收益走绿（val-negative）', async () => {
    await runWithPortfolio(runResult({ portfolio: portfolio({ totalReturn: -4.5 }) }));

    expect(screen.getByText('-4.5%').className).toContain('val-negative');
    expect(textOf(/平均换手/)).toContain('最大回撤 -6.4%');
  });
});

describe('FactorLabPanel —— 实验台账', () => {
  beforeEach(() => {
    echartsMock.init.mockReset();
    echartsMock.init.mockReturnValue({
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    stubMatchMedia();

    api.getUniverseBoards.mockReset();
    api.getFactorExperiments.mockReset();
    api.runFactorExpression.mockReset();
    api.getUniverseBoards.mockResolvedValue(boardsPayload());
    api.getFactorExperiments.mockResolvedValue(ledgerPayload());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('台账表展示来源中文标签、IC 方向色与采信结论，并给出假阳性上界', async () => {
    api.getFactorExperiments.mockResolvedValue(
      ledgerPayload({
        items: [
          ledgerItem(),
          ledgerItem({
            id: 'e2',
            source: 'hypothesis',
            name: '高 ROE 低负债',
            expression: undefined,
            createdAt: '2026-09-14T06:30:00.000Z',
            icMean: -0.045,
            pValue: 0.31,
            oosStable: false,
            kept: false,
          }),
          ledgerItem({
            id: 'e3',
            source: 'cross-section',
            name: '动量因子',
            createdAt: '2026-09-13T01:05:00.000Z',
            icMean: 0.2,
            pValue: 0.00001,
            oosStable: true,
            kept: true,
          }),
        ],
      }),
    );
    renderPanel();

    await waitFor(() => expect(screen.getByText('动量因子')).toBeInTheDocument());

    const summary = textOf(/累计/);
    expect(summary).toContain('累计 12 条 · 采信 3 条');
    expect(summary).toContain('期望假阳性上界 ≈0.15');
    expect(summary).toContain('OOS 稳定 67%');

    // 表头与行：来源走中文标签，时间按 shortDate 截取
    expect(screen.getByRole('columnheader', { name: '持有期' })).toBeInTheDocument();
    expect(screen.getByText('表达式')).toBeInTheDocument();
    expect(screen.getByText('假设')).toBeInTheDocument();
    expect(screen.getByText('截面')).toBeInTheDocument();
    expect(screen.getByText('09-15 02:00')).toBeInTheDocument();

    // IC 是方向量 → 涨跌色；显著性另有 OOS/采信列
    expect(screen.getByText('0.123').className).toBe('val-positive');
    expect(screen.getByText('-0.045').className).toBe('val-negative');
    expect(screen.getByText('0.045')).not.toHaveClass(/val-/);
    expect(screen.getByText('<1e-4')).toBeInTheDocument();

    expect(screen.getAllByText('稳定')).toHaveLength(2);
    expect(screen.getByText('不稳')).toBeInTheDocument();
    expect(screen.getAllByText('采信')[0].className).toContain('sig-valid');
    expect(screen.getByText('不采信').className).toContain('sig-none');

    // 无表达式时 title 回退到因子名（可选字段 undefined 的兜底）
    expect(screen.getByText('20日反转')).toHaveAttribute('title', 'close / mean(close, 20) - 1');
    expect(screen.getByText('高 ROE 低负债')).toHaveAttribute('title', '高 ROE 低负债');
  });

  it('台账一条都没有时给出「怎么才会有记录」的指引，而不是空白', async () => {
    api.getFactorExperiments.mockResolvedValue(ledgerPayload({ items: [], summary: null }));
    renderPanel();

    await waitFor(() =>
      expect(
        screen.getByText('还没有实验记录：评估一次截面或因子假设后自动留痕。'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/累计/)).toBeNull();
  });

  it('采信数为 0 时不显示期望假阳性上界（避免 0 × 5% 的噪声）', async () => {
    api.getFactorExperiments.mockResolvedValue(
      ledgerPayload({
        summary: ledgerSummary({
          total: 5,
          kept: 0,
          keptExpectedFalse: 0,
          keptOosShare: undefined,
        }),
      }),
    );
    renderPanel();

    await waitFor(() => expect(screen.getByText('20日反转')).toBeInTheDocument());
    const summary = textOf(/累计/);
    expect(summary).toContain('累计 5 条 · 采信 0 条');
    expect(summary).not.toContain('期望假阳性上界');
    expect(summary).not.toContain('OOS 稳定');
  });

  it('台账接口失败时静默降级为空态，不打断主流程', async () => {
    api.getFactorExperiments.mockRejectedValue(new Error('实验台账读取失败'));
    renderPanel();

    await waitFor(() =>
      expect(
        screen.getByText('还没有实验记录：评估一次截面或因子假设后自动留痕。'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('实验台账读取失败')).toBeNull();
    expect(document.querySelector('.error-banner')).toBeNull();
    // 主流程不受影响：板块就位后仍可提交
    await waitFor(() => expect(submitButton()).toBeEnabled());
  });
});

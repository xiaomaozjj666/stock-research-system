// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CrossSectionPanel from '../CrossSectionPanel';
import { ToastProvider } from '../../../components/Toast';
import { AnalysisCancelledError } from '../../../api/client';
import type {
  CrossSectionFactor,
  CrossSectionPeriodReport,
  CrossSectionResult,
  IndustryBoard,
} from '../types';

/**
 * 截面因子评估面板行为测试
 * ----------------------------------------------------------------------------
 * 断言全部打在用户能看到的东西上：中文标签 / 数值 / 占位选项 / 按钮可点性 /
 * aria 与着色类名（红涨绿跌 + 显著性色板两套语义）。
 *
 * mock 说明：组件真正 import 的三个符号（getUniverseBoards、
 * runCrossSectionEvaluation、AnalysisCancelledError）必须全部由工厂导出，
 * 漏一个渲染时就会报 "No export is defined on the mock"。
 */
const apiMocks = vi.hoisted(() => ({
  getUniverseBoards: vi.fn(),
  runCrossSectionEvaluation: vi.fn(),
}));

vi.mock('../../../api/client', () => ({
  getUniverseBoards: apiMocks.getUniverseBoards,
  runCrossSectionEvaluation: apiMocks.runCrossSectionEvaluation,
  AnalysisCancelledError: class AnalysisCancelledError extends Error {
    constructor(message = '截面评估已取消') {
      super(message);
      this.name = 'AnalysisCancelledError';
    }
  },
}));

/** 板块列表按总市值降序，「电子」在首位而「白酒」不在——用来验证默认值是按名称挑的 */
const BOARDS: IndustryBoard[] = [
  { code: 'BK0448', name: '电子' },
  { code: 'BK0475', name: '白酒' },
  { code: 'BK0473', name: '银行' },
];

function makePeriod(over: Partial<CrossSectionPeriodReport> = {}): CrossSectionPeriodReport {
  return {
    period: 21,
    sampleSize: 1200,
    ic: { n: 120, mean: 0.123, ir: 0.5, tStat: 2.6, pValue: 0.012 },
    oos: {
      isMeanIc: 0.13,
      oosMeanIc: 0.11,
      signAgree: true,
      isSignificant: true,
      oosSignificant: true,
      stable: true,
      isN: 84,
      oosN: 36,
    },
    quantile: { period: 21, spread: 0.0234, monotonicity: 0.75, rows: [] },
    turnover: null,
    alphaBeta: null,
    longShortCumulative: 0.125,
    verdict: { effective: true, reasons: ['IC 显著', '分层单调 0.75 ≥ 0.6'] },
    ...over,
  };
}

type FactorOverrides = Partial<Omit<CrossSectionFactor, 'name' | 'report'>> & {
  byPeriod?: CrossSectionPeriodReport[];
};

function makeFactor(name: string, over: FactorOverrides = {}): CrossSectionFactor {
  const { byPeriod, ...rest } = over;
  const reports = byPeriod ?? [makePeriod()];
  return {
    name,
    type: 'price_volume',
    report: {
      periods: reports.map((p) => p.period),
      byPeriod: reports,
      sampleSize: 1200,
      dropped: 12,
      dropRatio: 0.01,
      neutralized: true,
    },
    ...rest,
  };
}

/** 63 日档的报告：各项数值都与 21 日档不同，避免断言时撞到同名数值 */
function makePeriod63(): CrossSectionPeriodReport {
  return makePeriod({
    period: 63,
    ic: { n: 100, mean: 0.061, ir: 0.35, tStat: 1.8, pValue: 0.045 },
    oos: {
      isMeanIc: 0.07,
      oosMeanIc: 0.03,
      signAgree: false,
      isSignificant: true,
      oosSignificant: false,
      stable: false,
      isN: 70,
      oosN: 30,
    },
    quantile: { period: 63, spread: 0.0512, monotonicity: 0.6, rows: [] },
    longShortCumulative: 0.184,
  });
}

/** 两档持有期都有报告的默认因子 */
function twoPeriodFactor(name: string, over: FactorOverrides = {}): CrossSectionFactor {
  return makeFactor(name, {
    byPeriod: [makePeriod({ period: 21 }), makePeriod63()],
    ...over,
  });
}

function makeResult(over: Partial<CrossSectionResult> = {}): CrossSectionResult {
  return {
    universe: { source: 'board', board: 'BK0475', requested: 12 },
    stocksIncluded: [
      '600519',
      '000858',
      '603288',
      '600036',
      '000001',
      '601318',
      '000333',
      '600276',
    ],
    stocksSkipped: [],
    horizons: [21, 63],
    factors: [twoPeriodFactor('volatility_1m')],
    ...over,
  };
}

function portfolio(totalReturn: number) {
  return {
    equityCurve: [],
    benchmarkCurve: [],
    totalReturn,
    annualizedReturn: 8.5,
    sharpe: 1.42,
    maxDrawdown: -9.9,
    winRate: 55.5,
    avgTurnover: 0.35,
    periods: 12,
    rebalances: [],
  };
}

type RunPayload = {
  codes?: string[];
  board?: string;
  topN?: number;
  indexUniverse?: { index: string; date?: string };
  horizons?: number[];
  includeFundamental?: boolean;
  includeEvents?: boolean;
  includeMargin?: boolean;
  portfolio?: { holdDays?: number; topN?: number; costBps?: number };
};

function lastPayload(): RunPayload {
  const calls = apiMocks.runCrossSectionEvaluation.mock.calls;
  return calls[calls.length - 1][0] as RunPayload;
}

function lastSignal(): AbortSignal {
  const calls = apiMocks.runCrossSectionEvaluation.mock.calls;
  return calls[calls.length - 1][1] as AbortSignal;
}

/** 在途请求永不 resolve 的桩：用于观察加载态 */
function pending(): Promise<CrossSectionResult> {
  return new Promise<CrossSectionResult>(() => {});
}

/** 收到 abort 时以 AnalysisCancelledError 拒绝（与真实 client 行为一致） */
function rejectOnAbort() {
  return (_payload: RunPayload, signal: AbortSignal) =>
    new Promise<CrossSectionResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new AnalysisCancelledError('截面评估已取消')));
    });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPanel(props: { active?: boolean } = {}) {
  return render(
    <ToastProvider>
      <CrossSectionPanel {...props} />
    </ToastProvider>,
  );
}

/** 渲染并等板块列表就绪（默认选中白酒） */
async function renderWithBoards() {
  const utils = renderPanel();
  await screen.findByRole('option', { name: '白酒（BK0475）' });
  return utils;
}

async function clickRun() {
  fireEvent.click(screen.getByRole('button', { name: '开始评估' }));
}

function factorRow(label: string): HTMLElement {
  return screen.getByRole('cell', { name: label }).closest('tr') as HTMLElement;
}

function factorsTable(): HTMLElement {
  return screen.getByRole('columnheader', { name: '因子' }).closest('table') as HTMLElement;
}

function portfolioTable(): HTMLElement {
  const head = screen.getByRole('columnheader', { name: /^因子组合回测（/ });
  return head.closest('table') as HTMLElement;
}

describe('CrossSectionPanel —— 初始渲染与板块列表', () => {
  beforeEach(() => {
    apiMocks.getUniverseBoards.mockReset();
    apiMocks.runCrossSectionEvaluation.mockReset();
    apiMocks.getUniverseBoards.mockResolvedValue({ boards: BOARDS });
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(makeResult());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('标题与三种 universe 来源入口可见，且默认停在「按行业板块」', async () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: /截面因子评估/ })).toBeInTheDocument();

    const group = screen.getByRole('group', { name: 'universe 来源' });
    expect(within(group).getByRole('button', { name: '按行业板块' })).toHaveClass('active');
    expect(within(group).getByRole('button', { name: '指数历史成分' })).toBeEnabled();
    expect(within(group).getByRole('button', { name: '手输代码' })).toBeEnabled();
    // 未选来源前只渲染板块表单，不渲染 codes/指数控件
    expect(screen.getByLabelText(/^行业板块/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^股票代码/)).toBeNull();
  });

  it('板块列表返回后按名称优先级默认选中「白酒」而不是列表首项「电子」', async () => {
    renderPanel();
    await screen.findByText('3 个行业板块 · 成分股取总市值前 N 只');

    expect(screen.getByLabelText(/^行业板块/)).toHaveValue('BK0475');
    expect(screen.getByRole('option', { name: '白酒（BK0475）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始评估' })).toBeEnabled();
  });

  it('优先级板块都不在列表时回退到首项', async () => {
    apiMocks.getUniverseBoards.mockResolvedValue({
      boards: [
        { code: 'BK0448', name: '电子' },
        { code: 'BK0999', name: '医药' },
      ],
    });
    renderPanel();
    await screen.findByText('2 个行业板块 · 成分股取总市值前 N 只');

    expect(screen.getByLabelText(/^行业板块/)).toHaveValue('BK0448');
  });

  it('未激活时不请求板块列表，激活后才拉取并允许评估', async () => {
    const { rerender } = render(
      <ToastProvider>
        <CrossSectionPanel active={false} />
      </ToastProvider>,
    );
    expect(apiMocks.getUniverseBoards).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: '加载板块中…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();

    rerender(
      <ToastProvider>
        <CrossSectionPanel active />
      </ToastProvider>,
    );
    await waitFor(() => expect(apiMocks.getUniverseBoards).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('option', { name: '白酒（BK0475）' })).toBeInTheDocument();
  });

  it('板块列表加载失败时给出中文提示、占位选项与替代路径，并禁用评估', async () => {
    apiMocks.getUniverseBoards.mockRejectedValue(new Error('行业板块列表获取失败'));
    renderPanel();

    expect(
      await screen.findByText(
        '板块列表加载失败：行业板块列表获取失败，可切换「手输代码」模式评估个股组合',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '板块列表不可用' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();
  });

  it('板块列表为空时给出明确空态，不再假装还在加载', async () => {
    apiMocks.getUniverseBoards.mockResolvedValue({ boards: [] });
    renderPanel();

    expect(
      await screen.findByText(
        '行业板块列表为空（上游未返回数据），可切换「手输代码」模式评估个股组合',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '暂无可选板块' })).toBeInTheDocument();
    // "数据已到达但为空" 与 "还在请求" 是两种状态，不能都写成加载中
    expect(screen.queryByRole('option', { name: '加载板块中…' })).toBeNull();
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();
  });

  it('板块列表加载失败后可以就地重试（不必刷新整页）', async () => {
    apiMocks.getUniverseBoards.mockRejectedValueOnce(new Error('上游超时'));
    renderPanel();
    expect(await screen.findByText(/板块列表加载失败：上游超时/)).toBeInTheDocument();

    apiMocks.getUniverseBoards.mockResolvedValue({ boards: [{ code: 'BK0477', name: '白酒' }] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByRole('option', { name: '白酒（BK0477）' })).toBeInTheDocument();
    expect(screen.queryByText(/板块列表加载失败/)).toBeNull();
  });
});

describe('CrossSectionPanel —— 提交、加载态与取消', () => {
  beforeEach(() => {
    apiMocks.getUniverseBoards.mockReset();
    apiMocks.runCrossSectionEvaluation.mockReset();
    apiMocks.getUniverseBoards.mockResolvedValue({ boards: BOARDS });
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(makeResult());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('评估中按钮变「评估中…」并禁用，同时出现进度文案、取消入口与禁用的表单', async () => {
    const d = deferred<CrossSectionResult>();
    apiMocks.runCrossSectionEvaluation.mockReturnValue(d.promise);
    await renderWithBoards();

    await clickRun();

    expect(screen.getByRole('button', { name: '评估中…' })).toBeDisabled();
    expect(
      screen.getByText(/正在逐只拉取行情与财务数据并装配截面面板…（已耗时 0 秒）/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消评估' })).toBeEnabled();
    expect(screen.getByLabelText(/^成分股数量（topN）/)).toBeDisabled();
    expect(screen.getByLabelText(/^持有期（交易日）/)).toBeDisabled();
    expect(
      within(screen.getByRole('group', { name: 'universe 来源' })).getByRole('button', {
        name: '手输代码',
      }),
    ).toBeDisabled();

    await act(async () => {
      d.resolve(makeResult());
    });
    expect(await screen.findByRole('button', { name: '开始评估' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '取消评估' })).toBeNull();
  });

  it('评估期间每秒刷新已耗时秒数', async () => {
    apiMocks.runCrossSectionEvaluation.mockReturnValue(pending());
    renderPanel();
    // 先用真实计时器让板块列表落地，再接管时钟（fake timers 下 findBy* 会等不到）
    await act(async () => {});
    expect(screen.getByRole('option', { name: '白酒（BK0475）' })).toBeInTheDocument();
    vi.useFakeTimers();

    await clickRun();
    expect(screen.getByText(/已耗时 0 秒/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText(/已耗时 2 秒/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/已耗时 5 秒/)).toBeInTheDocument();
  });

  it('点击「取消评估」会 abort 在途请求、弹出成功提示且不显示错误横幅', async () => {
    apiMocks.runCrossSectionEvaluation.mockImplementation(rejectOnAbort());
    await renderWithBoards();

    await clickRun();
    fireEvent.click(await screen.findByRole('button', { name: '取消评估' }));

    expect(lastSignal().aborted).toBe(true);
    const toast = await screen.findByText(/已取消本次评估/);
    expect(toast).toHaveClass('toast-success');
    expect(document.querySelector('.error-banner')).toBeNull();
    expect(await screen.findByRole('button', { name: '开始评估' })).toBeEnabled();
  });

  it('评估失败展示中文错误横幅，按钮回到「开始评估」并可重试成功', async () => {
    apiMocks.runCrossSectionEvaluation
      .mockRejectedValueOnce(new Error('截面因子评估失败：上游行情源超时'))
      .mockResolvedValueOnce(makeResult());
    await renderWithBoards();

    await clickRun();

    const banner = await screen.findByText('截面因子评估失败：上游行情源超时');
    expect(banner).toHaveClass('error-banner');
    const retry = screen.getByRole('button', { name: '开始评估' });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    expect(await screen.findByRole('columnheader', { name: '1月截面IC' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.error-banner')).toBeNull());
  });

  it('面板卸载时中止在途请求，且不再弹出「已取消」提示', async () => {
    function Host() {
      const [shown, setShown] = useState(true);
      return (
        <ToastProvider>
          {shown && <CrossSectionPanel />}
          <button type="button" onClick={() => setShown(false)}>
            卸载面板
          </button>
        </ToastProvider>
      );
    }
    apiMocks.runCrossSectionEvaluation.mockImplementation(rejectOnAbort());
    render(<Host />);
    await screen.findByRole('option', { name: '白酒（BK0475）' });

    await clickRun();
    fireEvent.click(screen.getByRole('button', { name: '卸载面板' }));

    expect(lastSignal().aborted).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    // ToastProvider 仍在树上，提示若被弹出这里一定能看到
    expect(screen.queryByText(/已取消本次评估/)).toBeNull();
  });
});

describe('CrossSectionPanel —— 成功结果渲染', () => {
  beforeEach(() => {
    apiMocks.getUniverseBoards.mockReset();
    apiMocks.runCrossSectionEvaluation.mockReset();
    apiMocks.getUniverseBoards.mockResolvedValue({ boards: BOARDS });
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(makeResult());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('汇总行展示板块中文名、请求/入组/跳过数、因子数与持有期', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        universe: { source: 'board', board: 'BK0475', requested: 12 },
        stocksIncluded: [
          '600519',
          '000858',
          '603288',
          '600036',
          '000001',
          '601318',
          '000333',
          '600276',
        ],
        stocksSkipped: [
          { code: '000002', reason: '行情数据不足' },
          { code: '600000', reason: '上市时间太短' },
        ],
      }),
    );
    await renderWithBoards();
    await clickRun();

    const summary = await screen.findByText(/入组/);
    expect(summary).toHaveTextContent(
      '板块 白酒（BK0475） · 请求 12 只 · 入组 8 · 跳过 2 · 因子 1 个 · 持有期 1月/3月',
    );
  });

  it('有跳过标的时列出代码与原因，并把跳过计数标为风险色', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        stocksSkipped: [
          { code: '600519', reason: '行情数据不足' },
          { code: '000858', reason: '上市时间太短' },
        ],
      }),
    );
    await renderWithBoards();
    await clickRun();

    expect(
      await screen.findByText('⚠ 跳过：600519（行情数据不足）；000858（上市时间太短）'),
    ).toBeInTheDocument();
    // 裸 .negative 在 index.css 里没有规则（等于不上色），改用全局风险琥珀
    expect(document.querySelector('.batch-summary b.val-warn')).toHaveTextContent('2');
  });

  it('没有跳过标的时不显示跳过提示，计数也不着色', async () => {
    await renderWithBoards();
    await clickRun();
    await screen.findByText(/入组/);

    expect(screen.queryByText(/⚠ 跳过/)).toBeNull();
    expect(document.querySelector('.batch-summary b.negative')).toBeNull();
    const counts = document.querySelectorAll('.batch-summary b');
    expect(counts[0]).toHaveTextContent('8'); // 入组
    expect(counts[1]).toHaveTextContent('0'); // 跳过
  });

  it('因子表展示中文因子名、类型与各项指标，且不渲染组合回测表', async () => {
    await renderWithBoards();
    await clickRun();

    await screen.findByRole('columnheader', { name: '因子' });
    const table = within(factorsTable());
    expect(table.getByRole('columnheader', { name: '类型' })).toBeInTheDocument();
    expect(table.getByRole('columnheader', { name: '1月截面IC' })).toBeInTheDocument();
    expect(table.getByRole('columnheader', { name: '3月截面IC' })).toBeInTheDocument();
    expect(table.getByRole('columnheader', { name: '单调性（最长档）' })).toBeInTheDocument();
    expect(table.getByRole('columnheader', { name: '多空价差（最长档）' })).toBeInTheDocument();
    expect(table.getByRole('columnheader', { name: '多空净值（最长档）' })).toBeInTheDocument();
    expect(table.getByRole('columnheader', { name: '判定（最长档）' })).toBeInTheDocument();

    const row = within(factorRow('1月波动率'));
    expect(row.getByText('量价')).toBeInTheDocument();
    // 每个持有期各有 IC 单元格：1 月档（21 日）
    expect(row.getByText('+0.123')).toHaveClass('cs-ic-mean', 'sig-valid');
    expect(row.getByText('p=0.012 · 120日')).toBeInTheDocument();
    expect(row.getByText('OOS稳定')).toHaveClass('cs-oos-ok');
    // 3 月档（63 日）：均值/显著性/OOS 都是另一套值
    expect(row.getByText('+0.061')).toHaveClass('cs-ic-mean', 'sig-valid');
    expect(row.getByText('p=0.045 · 100日')).toBeInTheDocument();
    expect(row.getByText('OOS不稳')).toHaveClass('cs-oos-no');
    // 末四列取该因子样本够用的最长持有期（此处 = 63 日档）
    expect(row.getByText('0.60')).toBeInTheDocument();
    expect(row.getByText('5.1%')).toBeInTheDocument();
    expect(row.getByText('0.184')).toBeInTheDocument();
    expect(row.getByText('有效')).toHaveClass('factor-badge', 'sig-valid');

    expect(screen.queryByRole('columnheader', { name: /^因子组合回测（/ })).toBeNull();
  });

  it('IC 着色分三档：显著同向 sig-valid、显著反向 sig-inverted、不显著 sig-none', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        factors: [
          makeFactor('momentum_12_1', {
            byPeriod: [makePeriod({ ic: { n: 120, mean: 0.2, ir: 0.6, tStat: 3, pValue: 0.001 } })],
          }),
          makeFactor('reversal_1m', {
            byPeriod: [
              makePeriod({
                ic: { n: 120, mean: -0.15, ir: -0.5, tStat: -3, pValue: 0.002 },
                oos: { ...makePeriod().oos, stable: false },
              }),
            ],
          }),
          makeFactor('beta', {
            byPeriod: [
              makePeriod({ ic: { n: 120, mean: 0.05, ir: 0.1, tStat: 0.5, pValue: 0.4 } }),
            ],
          }),
        ],
      }),
    );
    await renderWithBoards();
    await clickRun();
    await screen.findByText('+0.200');

    expect(screen.getByText('+0.200')).toHaveClass('sig-valid');
    expect(screen.getByText('-0.150')).toHaveClass('sig-inverted');
    expect(screen.getByText('+0.050')).toHaveClass('sig-none');
    // 反向显著的因子里 OOS 不稳走灰
    expect(within(factorRow('1月反转')).getByText('OOS不稳')).toHaveClass('cs-oos-no');
  });

  it('p 值小于 1e-4 时显示「<1e-4」而不是 0.000', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        factors: [
          makeFactor('amihud_illiquidity', {
            byPeriod: [
              makePeriod({ ic: { n: 240, mean: 0.31, ir: 0.9, tStat: 4.2, pValue: 0.000001 } }),
            ],
          }),
        ],
      }),
    );
    await renderWithBoards();
    await clickRun();

    expect(await screen.findByText('p=<1e-4 · 240日')).toBeInTheDocument();
  });

  it('末四列取持有期最长的那一档，与 byPeriod 的数组顺序无关', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        // 服务端把长档排在前面：若实现按 [length-1] 取末元素，判定就会变成 21 日档
        factors: [makeFactor('volatility_3m', { byPeriod: [makePeriod63(), makePeriod()] })],
      }),
    );
    await renderWithBoards();
    await clickRun();

    const row = within(await screen.findByRole('row', { name: /3月波动率/ }));
    expect(row.getByText('0.60')).toBeInTheDocument(); // 63 日档单调性
    expect(row.getByText('0.184')).toBeInTheDocument(); // 63 日档多空净值
    expect(row.queryByText('0.75')).toBeNull(); // 21 日档的单调性没有顶上来
  });

  it('某档持有期没有报告时该单元格显示「样本不足」，其余档位照常', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        horizons: [21, 63, 5],
        factors: [makeFactor('volatility_3m', { byPeriod: [makePeriod({ period: 21 })] })],
      }),
    );
    await renderWithBoards();
    await clickRun();

    const row = within(await screen.findByRole('row', { name: /3月波动率/ }));
    expect(row.getAllByText('样本不足')).toHaveLength(2);
    expect(row.getByText('+0.123')).toBeInTheDocument();
    expect(screen.getByText(/持有期 1月\/3月\/5日/)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '5日截面IC' })).toBeInTheDocument();
  });

  it('因子报告为空数组时末四列显示「—」，且不出现判定徽标', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        factors: [makeFactor('volatility_1m', { byPeriod: [] })],
      }),
    );
    await renderWithBoards();
    await clickRun();

    const row = within(await screen.findByRole('row', { name: /1月波动率/ }));
    expect(row.getAllByText('—')).toHaveLength(4);
    expect(row.queryByText('有效')).toBeNull();
    expect(row.queryByText('未通过')).toBeNull();
  });

  it('未收录中文名的因子回退显示原始字段名，类型也已翻译', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        factors: [makeFactor('brand_new_factor', { type: 'fundamental' })],
      }),
    );
    await renderWithBoards();
    await clickRun();

    const row = within(await screen.findByRole('row', { name: /brand_new_factor/ }));
    expect(row.getByText('brand_new_factor')).toBeInTheDocument();
    expect(row.getByText('基本面')).toBeInTheDocument();
  });

  it('判定未通过时展示「未通过」徽标，并把原因写进 title', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        factors: [
          makeFactor('cs_roe', {
            type: 'fundamental',
            byPeriod: [
              makePeriod({
                verdict: { effective: false, reasons: ['IC 不显著', '分层单调 0.30 < 0.6'] },
              }),
            ],
          }),
        ],
      }),
    );
    await renderWithBoards();
    await clickRun();

    const badge = await screen.findByText('未通过');
    expect(badge).toHaveClass('sig-none');
    expect(badge).toHaveAttribute('title', 'IC 不显著；分层单调 0.30 < 0.6');
  });

  it('全部因子样本不足时展示空态文案，且不渲染因子表', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(makeResult({ factors: [] }));
    await renderWithBoards();
    await clickRun();

    expect(
      await screen.findByText(
        '没有因子凑齐最低样本（每因子 ≥30 个观测）。截面宽度不足是主因——试试增大 topN 或延长持有期。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('指数宇宙展示指数名与成分快照日期，并附幸存者偏差说明', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        universe: {
          source: 'index',
          index: 'zz500',
          updateDate: '2024-01-31',
          requested: 500,
          survivorshipNote: '历史成分含其后退市证券，可正面观察幸存者偏差。',
        },
        stocksIncluded: ['600519', '000858'],
        horizons: [21],
      }),
    );
    await renderWithBoards();
    await clickRun();

    expect(await screen.findByText(/入组/)).toHaveTextContent(
      '指数历史成分（zz500 @ 2024-01-31） · 请求 500 只 · 入组 2 · 跳过 0 · 因子 1 个 · 持有期 1月',
    );
    expect(screen.getByText('历史成分含其后退市证券，可正面观察幸存者偏差。')).toBeInTheDocument();
  });

  it('指数宇宙没有快照日期时只显示指数名', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        universe: { source: 'index', index: 'hs300', requested: 300 },
        horizons: [21],
      }),
    );
    await renderWithBoards();
    await clickRun();

    expect(await screen.findByText(/入组/)).toHaveTextContent(
      '指数历史成分（hs300） · 请求 300 只 · 入组 8 · 跳过 0 · 因子 1 个 · 持有期 1月',
    );
  });

  it('手输代码宇宙的汇总行显示「手输代码」', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        universe: { source: 'codes', requested: 3 },
        horizons: [21],
      }),
    );
    await renderWithBoards();
    await clickRun();

    expect(await screen.findByText(/入组/)).toHaveTextContent(
      '手输代码 · 请求 3 只 · 入组 8 · 跳过 0 · 因子 1 个 · 持有期 1月',
    );
  });

  it('组合回测表按总收益降序排列，正收益标红、负收益标绿', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        factors: [
          makeFactor('reversal_1m', { portfolio: portfolio(12.5) }),
          makeFactor('beta', { portfolio: portfolio(-6.2) }),
          makeFactor('momentum_12_1', { portfolio: portfolio(3) }),
        ],
      }),
    );
    await renderWithBoards();
    await clickRun();

    const head = await screen.findByRole('columnheader', { name: /^因子组合回测（/ });
    const table = within(head.closest('table') as HTMLElement);
    expect(
      table.getByRole('columnheader', {
        name: '因子组合回测（21日调仓 · top-5 等权 · 30bps）',
      }),
    ).toBeInTheDocument();
    for (const name of ['期数', '总收益', '年化', '夏普', '最大回撤', '周期胜率', '平均换手']) {
      expect(table.getByRole('columnheader', { name })).toBeInTheDocument();
    }

    const rows = table.getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      '1月反转',
      '12-1动量',
      '贝塔',
    ]);
    expect(within(rows[0]).getByText('+12.5%')).toHaveClass('val-positive');
    expect(within(rows[1]).getByText('+3.0%')).toHaveClass('val-positive');
    expect(within(rows[2]).getByText('-6.2%')).toHaveClass('val-negative');
    expect(within(rows[0]).getByText('12')).toBeInTheDocument();
    expect(within(rows[0]).getByText('8.5%')).toBeInTheDocument();
    expect(within(rows[0]).getByText('1.42')).toBeInTheDocument();
    expect(within(rows[0]).getByText('-9.9%')).toBeInTheDocument();
    expect(within(rows[0]).getByText('56%')).toBeInTheDocument();
    expect(within(rows[0]).getByText('35%')).toBeInTheDocument();
    expect(
      screen.getByText('基准 = 候选宇宙等权（因子中性对照）；T+1 次日开盘撮合、涨停不建模。'),
    ).toBeInTheDocument();
    expect(factorsTable()).not.toBe(portfolioTable());
  });

  it('结果里的板块代码不在已加载列表时，汇总只显示代码而不编造名称', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        universe: { source: 'board', board: 'BK9999', requested: 5 },
        horizons: [21],
      }),
    );
    await renderWithBoards();
    await clickRun();

    expect(await screen.findByText(/入组/)).toHaveTextContent(
      '板块 BK9999 · 请求 5 只 · 入组 8 · 跳过 0 · 因子 1 个 · 持有期 1月',
    );
  });

  it('因子类型按中文标签展示（事件/形态/两融）', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({
        horizons: [21],
        factors: [
          makeFactor('ev_dividend_yield', { type: 'event' }),
          makeFactor('pat_limit_up', { type: 'pattern' }),
          makeFactor('mg_balance_chg20', { type: 'margin' }),
        ],
      }),
    );
    await renderWithBoards();
    await clickRun();

    await screen.findByText('分红股息率（事件）');
    expect(within(factorRow('分红股息率（事件）')).getByText('事件')).toBeInTheDocument();
    expect(within(factorRow('涨停强度（形态）')).getByText('形态')).toBeInTheDocument();
    expect(within(factorRow('两融余额20日变化（资金）')).getByText('两融')).toBeInTheDocument();
  });

  it('改组合参数后表头仍描述这批数据用的口径（不改表单状态就改表头＝显示与数据脱节）', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({ factors: [makeFactor('beta', { portfolio: portfolio(12.5) })] }),
    );
    await renderWithBoards();
    fireEvent.click(screen.getByLabelText(/^因子组合回测/));
    await clickRun();

    expect(
      await screen.findByRole('columnheader', {
        name: '因子组合回测（21日调仓 · top-5 等权 · 30bps）',
      }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^调仓周期/), { target: { value: '40' } });

    // 表内是 21 日那次的 12 期 / +12.5%，表头就必须继续写 21 日，直到重新跑一次
    expect(
      screen.getByRole('columnheader', { name: '因子组合回测（21日调仓 · top-5 等权 · 30bps）' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /40日调仓/ })).not.toBeInTheDocument();
    expect(screen.getByText('+12.5%')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1);
  });

  it('重新按 40 日调仓跑一次后，表头才跟着改成 40 日', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({ factors: [makeFactor('beta', { portfolio: portfolio(12.5) })] }),
    );
    await renderWithBoards();
    fireEvent.click(screen.getByLabelText(/^因子组合回测/));
    await clickRun();
    await screen.findByRole('columnheader', { name: /21日调仓/ });

    fireEvent.change(screen.getByLabelText(/^调仓周期/), { target: { value: '40' } });
    await clickRun();

    expect(
      await screen.findByRole('columnheader', { name: /40日调仓 · top-5 等权 · 30bps/ }),
    ).toBeInTheDocument();
    expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(2);
  });

  it('组合回测总收益为 0 时用中性色，既不红也不绿', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(
      makeResult({ factors: [makeFactor('beta', { portfolio: portfolio(0) })] }),
    );
    await renderWithBoards();
    await clickRun();

    const cell = await screen.findByText('+0.0%');
    expect(cell).toHaveClass('val-neutral');
    expect(cell).not.toHaveClass('val-positive');
  });
});

describe('CrossSectionPanel —— 表单交互与请求体', () => {
  beforeEach(() => {
    apiMocks.getUniverseBoards.mockReset();
    apiMocks.runCrossSectionEvaluation.mockReset();
    apiMocks.getUniverseBoards.mockResolvedValue({ boards: BOARDS });
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(makeResult());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('按板块提交时请求体带板块代码、topN 与三个因子族开关', async () => {
    await renderWithBoards();
    fireEvent.change(screen.getByLabelText(/^成分股数量（topN）/), { target: { value: '30' } });
    await clickRun();

    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    expect(lastPayload()).toEqual({
      board: 'BK0475',
      topN: 30,
      horizons: [21, 63],
      includeFundamental: true,
      includeEvents: true,
      includeMargin: true,
    });
  });

  it('取消勾选事件/两融因子后请求体对应字段为 false', async () => {
    await renderWithBoards();
    fireEvent.click(screen.getByLabelText(/^包含事件因子/));
    fireEvent.click(screen.getByLabelText(/^包含两融因子/));
    await clickRun();

    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    const payload = lastPayload();
    expect(payload.includeFundamental).toBe(true);
    expect(payload.includeEvents).toBe(false);
    expect(payload.includeMargin).toBe(false);
  });

  it('切换到指数历史成分后可选指数与快照日期，请求体带 indexUniverse', async () => {
    await renderWithBoards();
    fireEvent.click(screen.getByRole('button', { name: '指数历史成分' }));

    const indexSelect = screen.getByLabelText(/^指数/);
    expect(indexSelect).toHaveValue('hs300');
    expect(within(indexSelect).getByRole('option', { name: '中证500' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^行业板块/)).toBeNull();
    expect(screen.getByRole('button', { name: '开始评估' })).toBeEnabled();

    fireEvent.change(indexSelect, { target: { value: 'zz500' } });
    fireEvent.change(screen.getByLabelText(/^快照日期/), { target: { value: '2024-01-31' } });
    await clickRun();

    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    expect(lastPayload().indexUniverse).toEqual({ index: 'zz500', date: '2024-01-31' });
    expect(lastPayload().board).toBeUndefined();
  });

  it('快照日期留空时不向请求体写入 date 字段', async () => {
    await renderWithBoards();
    fireEvent.click(screen.getByRole('button', { name: '指数历史成分' }));
    await clickRun();

    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    expect(Object.keys(lastPayload().indexUniverse ?? {})).toEqual(['index']);
  });

  it('手输代码少于 2 只时禁用评估，≥2 只后可提交并解析各种分隔符', async () => {
    await renderWithBoards();
    fireEvent.click(screen.getByRole('button', { name: '手输代码' }));

    const textarea = screen.getByLabelText(/^股票代码/);
    expect(screen.queryByLabelText(/^成分股数量（topN）/)).toBeNull();

    fireEvent.change(textarea, { target: { value: '600519' } });
    expect(screen.getByRole('button', { name: '开始评估' })).toBeDisabled();

    fireEvent.change(textarea, {
      target: { value: '600519, 000858\n603288；600036 000001' },
    });
    expect(screen.getByRole('button', { name: '开始评估' })).toBeEnabled();
    await clickRun();

    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    expect(lastPayload().codes).toEqual(['600519', '000858', '603288', '600036', '000001']);
    expect(lastPayload().board).toBeUndefined();
    expect(lastPayload().topN).toBeUndefined();
  });

  it('手输代码超过 300 只时只提交前 300 只', async () => {
    await renderWithBoards();
    fireEvent.click(screen.getByRole('button', { name: '手输代码' }));

    const codes = Array.from({ length: 301 }, (_v, i) => String(600000 + i));
    fireEvent.change(screen.getByLabelText(/^股票代码/), { target: { value: codes.join('\n') } });
    await clickRun();

    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    const sent = lastPayload().codes ?? [];
    expect(sent).toHaveLength(300);
    expect(sent[0]).toBe('600000');
    expect(sent[299]).toBe('600299');
  });

  it('持有期解析：去重、向下取整、越界丢弃，全非法时回退默认 21/63', async () => {
    apiMocks.runCrossSectionEvaluation.mockResolvedValue(makeResult({ horizons: [5, 21] }));
    await renderWithBoards();
    const horizons = screen.getByLabelText(/^持有期（交易日）/);

    fireEvent.change(horizons, { target: { value: '5, 5, 21.9, 0, 251, abc' } });
    await clickRun();
    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    expect(lastPayload().horizons).toEqual([5, 21]);
    expect(await screen.findByRole('columnheader', { name: '5日截面IC' })).toBeInTheDocument();
    expect(screen.getByText(/持有期 5日\/1月/)).toBeInTheDocument();

    fireEvent.change(horizons, { target: { value: '0, 999, abc' } });
    await clickRun();
    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(2));
    expect(lastPayload().horizons).toEqual([21, 63]);
  });

  it('未勾选组合回测时请求体不带 portfolio 字段', async () => {
    await renderWithBoards();
    expect(screen.queryByLabelText(/^调仓周期/)).toBeNull();
    await clickRun();

    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    expect(Object.keys(lastPayload())).not.toContain('portfolio');
  });

  it('勾选组合回测后出现默认参数控件，请求体带 portfolio', async () => {
    await renderWithBoards();
    fireEvent.click(screen.getByLabelText(/^因子组合回测/));

    expect(screen.getByLabelText(/^调仓周期/)).toHaveValue(21);
    expect(screen.getByLabelText(/^持仓只数/)).toHaveValue(5);
    expect(screen.getByLabelText(/^单边成本/)).toHaveValue(30);

    await clickRun();
    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    expect(lastPayload().portfolio).toEqual({ holdDays: 21, topN: 5, costBps: 30 });
  });

  it('组合参数超出上下限时按边界钳制（0 与超上限都收敛）', async () => {
    await renderWithBoards();
    fireEvent.click(screen.getByLabelText(/^因子组合回测/));

    fireEvent.change(screen.getByLabelText(/^调仓周期/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/^持仓只数/), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/^单边成本/), { target: { value: '999' } });
    await clickRun();
    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(1));
    expect(lastPayload().portfolio).toEqual({ holdDays: 5, topN: 20, costBps: 200 });

    fireEvent.change(screen.getByLabelText(/^调仓周期/), { target: { value: '9999' } });
    fireEvent.change(screen.getByLabelText(/^持仓只数/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/^单边成本/), { target: { value: '' } });
    await clickRun();
    await waitFor(() => expect(apiMocks.runCrossSectionEvaluation).toHaveBeenCalledTimes(2));
    expect(lastPayload().portfolio).toEqual({ holdDays: 250, topN: 1, costBps: 0 });
  });

  it('切换来源会换掉表单控件，且同一时刻只有一套 universe 控件', async () => {
    await renderWithBoards();

    fireEvent.click(screen.getByRole('button', { name: '手输代码' }));
    expect(screen.getByLabelText(/^股票代码/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^行业板块/)).toBeNull();
    expect(screen.queryByLabelText(/^指数/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '指数历史成分' }));
    expect(screen.getByLabelText(/^快照日期/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^股票代码/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '按行业板块' }));
    expect(screen.getByLabelText(/^行业板块/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^快照日期/)).toBeNull();
  });
});

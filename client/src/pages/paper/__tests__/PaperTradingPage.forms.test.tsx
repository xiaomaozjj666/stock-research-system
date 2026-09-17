// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import PaperTradingPage from '../PaperTradingPage';

/**
 * 模拟盘行为测试（补充册）：下单表单校验 / 日终结算 / 绩效统计 / 港美股估值 /
 * 订单流水与净值曲线 / 错误与空态。
 *
 * 既有的 `PaperTradingPage.test.tsx`（首屏概览）与
 * `PaperTradingPage.auditPaging.test.tsx`（审计分页）保持原样未动，本文件只补它们
 * 没有覆盖的用户可见分支。
 *
 * 路径核对（本文件位于 client/src/pages/paper/__tests__/）：
 *   ../PaperTradingPage    → client/src/pages/paper/PaperTradingPage.tsx
 *   ../../../api/client    → client/src/api/client.ts
 *   ../../../lib/echarts   → client/src/lib/echarts.ts（EChart 的按需 echarts）
 * 下单代码输入用**真实** StockSearchInput（不 mock），因此工厂必须导出它 import 的
 * searchStocks；漏一个就会报 "No export is defined on the mock"。
 * 颜色口径：val-positive = 红（涨），val-negative = 绿（跌），与 A 股一致。
 */

const mocks = vi.hoisted(() => ({
  getPaperPortfolio: vi.fn(),
  getPaperStats: vi.fn(),
  placePaperOrder: vi.fn(),
  settlePaperDay: vi.fn(),
  getAuditLog: vi.fn(),
  getIntlFundamentals: vi.fn(),
  getIntlKlines: vi.fn(),
  searchStocks: vi.fn(),
  echartsInit: vi.fn(),
}));

vi.mock('../../../api/client', () => ({
  getPaperPortfolio: mocks.getPaperPortfolio,
  getPaperStats: mocks.getPaperStats,
  placePaperOrder: mocks.placePaperOrder,
  settlePaperDay: mocks.settlePaperDay,
  getAuditLog: mocks.getAuditLog,
  getIntlFundamentals: mocks.getIntlFundamentals,
  getIntlKlines: mocks.getIntlKlines,
  searchStocks: mocks.searchStocks,
  // 只保留被测页面真正依赖的语义：优先服务端给的中文原因，否则回落到页面传入的兜底文案
  normalizeApiError: (error: unknown, fallback = '请求失败') =>
    new Error(
      (error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback,
    ),
}));

vi.mock('../../../lib/echarts', () => ({ default: { init: mocks.echartsInit } }));

const POSITION = { code: '600519', quantity: 100, avgCost: 1800, buyDate: '2026-09-15' };

function portfolio(over: Record<string, unknown> = {}) {
  return {
    initialCapital: 100000,
    cash: 80000,
    currentDate: '2026-09-16',
    positions: [POSITION],
    orders: [],
    equity: [],
    ...over,
  };
}

function stats(over: Record<string, unknown> = {}) {
  return {
    initialCapital: 100000,
    finalEquity: 108500,
    totalReturnPct: 8.5,
    maxDrawdownPct: 3.25,
    sharpeRatio: 1.87,
    totalDays: 12,
    dailyReturns: [],
    ...over,
  };
}

/** 一张统计卡的容器（断言限定在卡内，避免与页面其它同值文本串台） */
function statCard(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

/** 首屏账户就绪（「下单」按钮可用）——表单类用例的公共前置 */
async function renderReady(over: Record<string, unknown> = {}) {
  mocks.getPaperPortfolio.mockResolvedValue(portfolio(over));
  render(<PaperTradingPage />);
  await waitFor(() => expect(screen.getByRole('button', { name: '下单' })).toBeEnabled());
}

/** 输入 6 位代码后失焦：真实 StockSearchInput 的自动提交路径 */
function pickOrderCode(code: string) {
  const input = screen.getByLabelText('下单股票代码');
  fireEvent.change(input, { target: { value: code } });
  fireEvent.blur(input);
}

/** 结算按钮文案会随 settling 变化，用正则取 */
function settleButton(name: RegExp | string = '日终结算') {
  return screen.getByRole('button', { name });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.echartsInit.mockReturnValue({
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    on: vi.fn(),
    getZr: vi.fn(() => ({ on: vi.fn() })),
  });
  mocks.getPaperPortfolio.mockResolvedValue(portfolio());
  mocks.getPaperStats.mockResolvedValue(stats());
  mocks.getAuditLog.mockResolvedValue({ count: 0, entries: [] });
  mocks.searchStocks.mockResolvedValue([]);
  mocks.placePaperOrder.mockResolvedValue({ order: { id: 'o1' } });
  mocks.settlePaperDay.mockResolvedValue({
    date: '2026-09-16',
    cash: 80000,
    latestEquity: { date: '2026-09-16', value: 80000 },
    history: [],
  });
  mocks.getIntlFundamentals.mockResolvedValue({
    fundamentals: null,
    degraded: true,
    source: 'eastmoney',
    fetchedAt: '2026-09-16T02:00:00.000Z',
  });
  mocks.getIntlKlines.mockResolvedValue({ code: '', market: '', count: 0, klines: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PaperTradingPage 加载与绩效统计', () => {
  it('账户未返回前：「下单」「日终结算」都禁用，统计卡退回占位符', () => {
    mocks.getPaperPortfolio.mockReturnValue(new Promise(() => {}));
    mocks.getPaperStats.mockReturnValue(new Promise(() => {}));
    mocks.getAuditLog.mockReturnValue(new Promise(() => {}));
    render(<PaperTradingPage />);

    expect(screen.getByRole('button', { name: '下单' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '日终结算' })).toBeDisabled();
    expect(within(statCard('累计收益')).getByText('—')).toBeInTheDocument();
    expect(within(statCard('年化夏普')).getByText('—')).toBeInTheDocument();

    // 加载中即使被点到也不该发起下单
    fireEvent.click(screen.getByRole('button', { name: '下单' }));
    expect(mocks.placePaperOrder).not.toHaveBeenCalled();
  });

  it('账户读取失败：中文错误横幅 + 统计退回占位，其余区块照常渲染', async () => {
    mocks.getPaperPortfolio.mockRejectedValue(new Error('Network Error'));
    mocks.getPaperStats.mockRejectedValue(new Error('Network Error'));
    render(<PaperTradingPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('读取模拟盘账户失败');
    // 金额类占位是「¥—」，比率类是「—」，都不能是 NaN / undefined
    expect(within(statCard('初始资金')).getByText('¥—')).toBeInTheDocument();
    expect(within(statCard('当前净值')).getByText('¥—')).toBeInTheDocument();
    expect(within(statCard('累计收益')).getByText('—')).toBeInTheDocument();
    expect(screen.getByText('暂无持仓')).toBeInTheDocument();
  });

  it('绩效统计：正收益标红（val-positive）并保留两位小数，回撤/夏普/天数按原值展示', async () => {
    await renderReady();

    expect(within(statCard('初始资金')).getByText('¥100,000.00')).toBeInTheDocument();
    expect(within(statCard('当前净值')).getByText('¥108,500.00')).toBeInTheDocument();
    expect(within(statCard('累计收益')).getByText('+8.50%')).toHaveClass('val-positive');
    expect(within(statCard('最大回撤')).getByText('3.25%')).toBeInTheDocument();
    expect(within(statCard('年化夏普')).getByText('1.87')).toBeInTheDocument();
    expect(within(statCard('结算天数')).getByText('12')).toBeInTheDocument();
    // 可用现金带千分位，且出现在页头副标题里
    expect(screen.getByText(/可用现金 ¥80,000\.00/)).toBeInTheDocument();
  });

  it('亏损时用 val-negative（绿）并保留负号，不把方向擦掉', async () => {
    mocks.getPaperStats.mockResolvedValue(
      stats({ totalReturnPct: -12.34, finalEquity: 87660, maxDrawdownPct: 15.5 }),
    );
    await renderReady();

    expect(within(statCard('累计收益')).getByText('-12.34%')).toHaveClass('val-negative');
    expect(within(statCard('当前净值')).getByText('¥87,660.00')).toBeInTheDocument();
    expect(within(statCard('最大回撤')).getByText('15.50%')).toBeInTheDocument();
  });

  it('收益率/回撤/夏普为 null 时显示「—」而不是 NaN，结算天数 0 照常显示', async () => {
    mocks.getPaperStats.mockResolvedValue(
      stats({
        totalReturnPct: null,
        maxDrawdownPct: null,
        sharpeRatio: null,
        totalDays: 0,
        finalEquity: 100000,
      }),
    );
    await renderReady();

    expect(within(statCard('累计收益')).getByText('—')).toBeInTheDocument();
    expect(within(statCard('最大回撤')).getByText('—')).toBeInTheDocument();
    expect(within(statCard('年化夏普')).getByText('—')).toBeInTheDocument();
    expect(within(statCard('结算天数')).getByText('0')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
    // 收益率为 null 时按 0 处理，沿用 val-positive（中性口径，不误报成亏损绿）
    expect(within(statCard('累计收益')).getByText('—')).toHaveClass('val-positive');
  });

  it('未设置交易日：页头提示「未设置」，下单区给出首次使用引导', async () => {
    await renderReady({ currentDate: null });

    expect(screen.getByText(/当前交易日：未设置，可用现金 ¥80,000\.00/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /首次使用：请先在右侧「日终结算」选定一个交易日完成结算——设定交易日之后才能下单。/,
      ),
    ).toBeInTheDocument();
  });

  it('周末打开页面：默认结算日回退到最近交易日，并提示今天是非交易日', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 19, 10, 0, 0)); // 2026-09-19 周六
    render(<PaperTradingPage />);

    expect(screen.getByLabelText('结算日期')).toHaveValue('2026-09-18');
    expect(screen.getByText('今天是非交易日，默认已回退至最近交易日')).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('PaperTradingPage 下单表单校验', () => {
  it('代码不是 6 位数字：拦下并给中文原因，不发起下单', async () => {
    await renderReady();
    fireEvent.change(screen.getByLabelText('下单股票代码'), { target: { value: '60051' } });
    fireEvent.click(screen.getByRole('button', { name: '下单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('股票代码需为 6 位数字');
    expect(mocks.placePaperOrder).not.toHaveBeenCalled();
  });

  it('数量为 0：拦下并提示「数量必须为正整数」', async () => {
    await renderReady();
    pickOrderCode('600519');
    fireEvent.change(screen.getByLabelText('数量（股）'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '下单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('数量必须为正整数');
    expect(mocks.placePaperOrder).not.toHaveBeenCalled();
  });

  it('数量为小数：前端先拦下（服务端会静默取整，不能放过去）', async () => {
    await renderReady();
    pickOrderCode('600519');
    fireEvent.change(screen.getByLabelText('数量（股）'), { target: { value: '100.5' } });
    fireEvent.click(screen.getByRole('button', { name: '下单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('数量必须为正整数');
    expect(mocks.placePaperOrder).not.toHaveBeenCalled();
  });

  it('限价单缺价格：切到限价才出现限价输入框，缺值时报「限价单需提供正价格」', async () => {
    await renderReady();
    expect(screen.queryByLabelText('限价')).toBeNull();

    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'limit' } });
    expect(screen.getByLabelText('限价')).toBeInTheDocument();

    pickOrderCode('600519');
    fireEvent.change(screen.getByLabelText('数量（股）'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '下单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('限价单需提供正价格');
    expect(mocks.placePaperOrder).not.toHaveBeenCalled();
  });

  it('限价卖出成功：按限价与当前交易日提交，成功提示可见、表单清空、余额刷新', async () => {
    mocks.getPaperPortfolio
      .mockResolvedValueOnce(portfolio())
      .mockResolvedValueOnce(portfolio({ cash: 60000 }));
    render(<PaperTradingPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '下单' })).toBeEnabled());

    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'limit' } });
    fireEvent.change(screen.getByLabelText('方向'), { target: { value: 'sell' } });
    pickOrderCode('600519');
    fireEvent.change(screen.getByLabelText('数量（股）'), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('限价'), { target: { value: '1750.5' } });
    fireEvent.click(screen.getByRole('button', { name: '下单' }));

    expect(await screen.findByText('下单成功，日终结算时按收盘价撮合')).toBeInTheDocument();
    expect(mocks.placePaperOrder).toHaveBeenCalledWith({
      code: '600519',
      side: 'sell',
      type: 'limit',
      quantity: 200,
      price: 1750.5,
      date: '2026-09-16',
    });
    // 表单清空，避免用户以为「点了没反应」而重复下单
    expect(screen.getByLabelText('数量（股）')).toHaveValue(null);
    expect(screen.getByLabelText('限价')).toHaveValue(null);
    // 下单后自动重读账户：页头余额随之变化
    await waitFor(() => expect(screen.getByText(/可用现金 ¥60,000\.00/)).toBeInTheDocument());
  });

  it('市价买入：price 传 undefined（由服务端按收盘价撮合）', async () => {
    await renderReady();
    pickOrderCode('000858');
    fireEvent.change(screen.getByLabelText('数量（股）'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '下单' }));

    await waitFor(() =>
      expect(mocks.placePaperOrder).toHaveBeenCalledWith({
        code: '000858',
        side: 'buy',
        type: 'market',
        quantity: 100,
        price: undefined,
        date: '2026-09-16',
      }),
    );
  });

  it('下单被服务端拒绝：显示服务端中文原因，不显示成功提示', async () => {
    mocks.placePaperOrder.mockRejectedValue({
      response: { data: { error: '交易日未设置，请先完成日终结算' } },
    });
    await renderReady();
    pickOrderCode('600519');
    fireEvent.change(screen.getByLabelText('数量（股）'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '下单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('交易日未设置，请先完成日终结算');
    expect(screen.queryByText('下单成功，日终结算时按收盘价撮合')).toBeNull();
  });

  it('从搜索下拉选中标的：代码与名称一并回填，并按该代码下单（真实防抖检索路径）', async () => {
    mocks.searchStocks.mockResolvedValue([{ code: '600519', name: '贵州茅台' }]);
    await renderReady();

    fireEvent.change(screen.getByLabelText('下单股票代码'), { target: { value: '贵州茅台' } });
    // 输入即防抖检索（250ms），候选出现在下拉里
    const option = await screen.findByRole('option', { name: /600519/ }, { timeout: 2000 });
    fireEvent.mouseDown(option);

    expect(await screen.findByText('贵州茅台')).toBeInTheDocument();
    expect(mocks.searchStocks).toHaveBeenCalledWith('贵州茅台');

    fireEvent.change(screen.getByLabelText('数量（股）'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '下单' }));
    await waitFor(() =>
      expect(mocks.placePaperOrder).toHaveBeenCalledWith(
        expect.objectContaining({ code: '600519', quantity: 100 }),
      ),
    );
  });
});

describe('PaperTradingPage 日终结算', () => {
  it('结算日期格式非法：拦下并提示 YYYY-MM-DD，不发起结算', async () => {
    await renderReady();
    fireEvent.change(screen.getByLabelText('结算日期'), { target: { value: '2026/09/16' } });
    fireEvent.click(settleButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('结算日期格式应为 YYYY-MM-DD');
    expect(mocks.settlePaperDay).not.toHaveBeenCalled();
  });

  it('按持仓填收盘价：正数随结算提交；负数等非法值按停牌剔除', async () => {
    await renderReady();
    const closeInput = await screen.findByLabelText(/^600519 收盘价/);
    fireEvent.change(screen.getByLabelText('结算日期'), { target: { value: '2026-09-16' } });
    fireEvent.change(closeInput, { target: { value: '1850.5' } });
    fireEvent.click(settleButton());

    await waitFor(() => expect(mocks.settlePaperDay).toHaveBeenCalledTimes(1));
    expect(mocks.settlePaperDay).toHaveBeenCalledWith({
      date: '2026-09-16',
      closePrices: { '600519': 1850.5 },
    });

    // 第二次：负数不是有效收盘价 → 剔除（缺省按停牌处理）
    fireEvent.change(closeInput, { target: { value: '-3' } });
    fireEvent.click(settleButton());
    await waitFor(() => expect(mocks.settlePaperDay).toHaveBeenCalledTimes(2));
    expect(mocks.settlePaperDay).toHaveBeenLastCalledWith({
      date: '2026-09-16',
      closePrices: {},
    });
  });

  it('结算成功：提示含结算日期与最新净值（千分位 + 两位小数）', async () => {
    mocks.settlePaperDay.mockResolvedValue({
      date: '2026-09-16',
      cash: 90000,
      latestEquity: { date: '2026-09-16', value: 123456.78 },
      history: [],
    });
    await renderReady();
    fireEvent.click(settleButton());

    expect(
      await screen.findByText('日终结算完成：2026-09-16 净值 ¥123,456.78'),
    ).toBeInTheDocument();
  });

  it('结算成功但没有净值点：提示「净值 ¥—」（照现状锁定，报告里单列）', async () => {
    mocks.settlePaperDay.mockResolvedValue({ date: '2026-09-16', cash: 80000, history: [] });
    await renderReady();
    fireEvent.click(settleButton());

    expect(await screen.findByText('日终结算完成：2026-09-16 净值 ¥—')).toBeInTheDocument();
  });

  it('结算中：按钮变「结算中…」并禁用，避免重复提交', async () => {
    let resolveSettle!: (v: unknown) => void;
    mocks.settlePaperDay.mockReturnValue(
      new Promise((resolve) => {
        resolveSettle = resolve;
      }),
    );
    await renderReady();
    fireEvent.click(settleButton());

    expect(await screen.findByRole('button', { name: '结算中…' })).toBeDisabled();

    resolveSettle({
      date: '2026-09-16',
      cash: 80000,
      latestEquity: { date: '2026-09-16', value: 80000 },
      history: [],
    });
    await waitFor(() => expect(settleButton()).toBeEnabled());
  });

  it('结算失败：显示服务端中文原因', async () => {
    mocks.settlePaperDay.mockRejectedValue({
      response: { data: { error: '2026-09-16 不是交易日，无法结算' } },
    });
    await renderReady();
    fireEvent.click(settleButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('2026-09-16 不是交易日，无法结算');
  });

  it('无持仓：结算区提示仅记录净值，不渲染收盘价输入', async () => {
    await renderReady({ positions: [] });

    expect(screen.getByText('当前无持仓，结算仅记录当日净值。')).toBeInTheDocument();
    expect(screen.queryByLabelText(/收盘价/)).toBeNull();
  });
});

describe('PaperTradingPage 持仓、净值与订单流水', () => {
  it('持仓表：数量、摊薄成本（两位小数）、买入日期', async () => {
    await renderReady();
    // 代码同时出现在持仓表与结算区的收盘价行，按区块限定
    const positionsSection = screen.getByText('持仓').closest('section') as HTMLElement;
    const row = within(positionsSection).getByText('600519').closest('tr') as HTMLElement;

    expect(within(row).getByText('100')).toBeInTheDocument();
    expect(within(row).getByText('¥1800.00')).toBeInTheDocument();
    expect(within(row).getByText('2026-09-15')).toBeInTheDocument();
  });

  it('两个以上结算点：画净值图，表格按前一点算日收益并标涨跌色', async () => {
    await renderReady({
      equity: [
        { date: '2026-09-10', value: 100000 },
        { date: '2026-09-11', value: 101500 },
      ],
    });

    expect(document.querySelector('.paper-equity-chart')).not.toBeNull();
    // EChart 在 passive effect 里 init，DOM 落地后可能还要一拍
    await waitFor(() => expect(mocks.echartsInit).toHaveBeenCalled());

    const firstRow = screen.getByText('2026-09-10').closest('tr') as HTMLElement;
    expect(within(firstRow).getByText('¥100,000.00')).toBeInTheDocument();
    // 首个结算点没有前值 → 日收益「—」（灰，不参与涨跌色）
    expect(within(firstRow).getByText('—')).toHaveClass('muted');

    const secondRow = screen.getByText('2026-09-11').closest('tr') as HTMLElement;
    expect(within(secondRow).getByText('+1.50%')).toHaveClass('val-positive');
  });

  it('净值下跌的结算点用 val-negative，涨跌不混用', async () => {
    await renderReady({
      equity: [
        { date: '2026-09-10', value: 100000 },
        { date: '2026-09-11', value: 98000 },
      ],
    });

    const secondRow = screen.getByText('2026-09-11').closest('tr') as HTMLElement;
    expect(within(secondRow).getByText('-2.00%')).toHaveClass('val-negative');
  });

  it('净值图：X 轴是结算日、Y 轴金额按「万」显示（长数字会挤压绘图区）', async () => {
    const chart = {
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      getZr: vi.fn(() => ({ on: vi.fn() })),
    };
    mocks.echartsInit.mockReturnValue(chart);
    await renderReady({
      equity: [
        { date: '2026-09-10', value: 100000 },
        { date: '2026-09-11', value: 101500 },
      ],
    });

    // 等 setOption 真正被调用（图表初始化在 passive effect 里，别抢跑）
    await waitFor(() => expect(chart.setOption).toHaveBeenCalled());
    const option = chart.setOption.mock.calls.at(-1)?.[0] as {
      xAxis: { data: string[] };
      yAxis: { axisLabel: { formatter: (v: number) => string } };
      series: { name: string; data: number[] }[];
    };
    expect(option.xAxis.data).toEqual(['2026-09-10', '2026-09-11']);
    expect(option.series[0]).toMatchObject({ name: '净值', data: [100000, 101500] });
    // Y 轴刻度文案（用户在坐标轴上看到的字）
    expect(option.yAxis.axisLabel.formatter(123456)).toBe('¥12.3万');
  });

  it('各结算点净值相同：提示账户暂无盈亏变化，避免被读成图表坏了', async () => {
    await renderReady({
      equity: [
        { date: '2026-09-10', value: 100000 },
        { date: '2026-09-11', value: 100000 },
      ],
    });

    expect(
      screen.getByText(
        '账户暂无盈亏变化（各结算点净值相同）：买入成交并完成日终结算后，曲线开始分化。',
      ),
    ).toBeInTheDocument();
  });

  it('订单流水：四种状态徽章、拒绝原因优先于费用、未成交价显示「—」', async () => {
    await renderReady({
      orders: [
        {
          id: 'o1',
          code: '600519',
          side: 'buy',
          type: 'market',
          quantity: 100,
          placedDate: '2026-09-15',
          status: 'filled',
          fillPrice: 1800,
          commission: 5,
          stampDuty: 0,
        },
        {
          id: 'o2',
          code: '000001',
          side: 'sell',
          type: 'limit',
          price: 12.5,
          quantity: 200,
          placedDate: '2026-09-15',
          status: 'rejected',
          rejectReason: '当日无收盘价，订单已拒绝',
        },
        {
          id: 'o3',
          code: '600036',
          side: 'buy',
          type: 'limit',
          price: 30,
          quantity: 100,
          placedDate: '2026-09-16',
          status: 'pending',
        },
        {
          id: 'o4',
          code: '601398',
          side: 'buy',
          type: 'market',
          quantity: 100,
          placedDate: '2026-09-16',
          status: 'expired',
        },
      ],
    });

    expect(screen.getByText('订单流水（最近 4 笔）')).toBeInTheDocument();
    expect(screen.getByText('已成交')).toBeInTheDocument();
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
    expect(screen.getByText('挂单中')).toBeInTheDocument();
    expect(screen.getByText('已过期')).toBeInTheDocument();
    // 拒绝单显示拒绝原因，而不是无意义的「佣金 0 税 0」
    expect(screen.getByText('当日无收盘价，订单已拒绝')).toBeInTheDocument();
    expect(screen.getByText('佣金 5 税 0')).toBeInTheDocument();
    expect(screen.getAllByText('佣金 0 税 0')).toHaveLength(2);
    // 有挂单 → 提示会在日终结算撮合
    expect(screen.getByText(/有 1 笔挂单待成交/)).toBeInTheDocument();

    const ordersTable = screen
      .getByText('订单流水（最近 4 笔）')
      .closest('section')!
      .querySelector('table') as HTMLElement;
    const ordersBody = ordersTable.querySelector('tbody') as HTMLElement;
    expect(within(ordersBody).getAllByText('买入')).toHaveLength(3);
    expect(within(ordersBody).getByText('卖出')).toBeInTheDocument();
    expect(within(ordersBody).getAllByText('市价')).toHaveLength(2);
    expect(within(ordersBody).getAllByText('限价')).toHaveLength(2);
    // 每笔订单未填的「限价/成交价」都显示「—」而不是空白：o1 限价、o2 成交价、
    // o3 成交价、o4 限价与成交价
    expect(within(ordersBody).getAllByText('—')).toHaveLength(5);
  });

  it('无持仓/无订单/无净值：三个区块都给中文空态', async () => {
    await renderReady({ positions: [], orders: [], equity: [] });

    expect(screen.getByText('暂无持仓')).toBeInTheDocument();
    expect(screen.getByText('订单流水（最近 0 笔）')).toBeInTheDocument();
    expect(screen.getByText('暂无订单')).toBeInTheDocument();
    expect(screen.getByText('暂无净值记录，完成一次日终结算后出现')).toBeInTheDocument();
  });
});

describe('PaperTradingPage 港美股财务估值查询', () => {
  const FUNDAMENTALS = {
    code: '00700',
    market: 'HK',
    name: '腾讯控股',
    pe: 18.5,
    pb: 3.2,
    marketCap: 32000,
    revenue: 6000,
    netIncome: 1200,
    totalAssets: 100000,
    totalLiabilities: 40000,
    currency: 'HKD',
    dataSource: 'eastmoney',
  };

  function intlTable(): HTMLElement {
    return screen.getByText('腾讯控股').closest('table') as HTMLElement;
  }

  it('未输入代码就查询：提示先输入港美股代码，不发请求', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请先输入港美股代码');
    expect(mocks.getIntlFundamentals).not.toHaveBeenCalled();
  });

  it('查询成功：渲染估值表（中文市场名 + 货币）与近一年 K 线，并给出数据源', async () => {
    mocks.getIntlFundamentals.mockResolvedValue({
      fundamentals: FUNDAMENTALS,
      degraded: false,
      source: 'eastmoney',
      fetchedAt: '2026-09-16T02:00:00.000Z',
    });
    mocks.getIntlKlines.mockResolvedValue({
      code: '00700',
      market: 'HK',
      count: 2,
      klines: [
        { date: '2026-09-15', open: 380, close: 385.5, high: 390, low: 378, volume: 1000 },
        { date: '2026-09-16', open: 385, close: 390, high: 395, low: 384, volume: 1200 },
      ],
    });
    await renderReady();

    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '00700' } });
    fireEvent.change(screen.getByLabelText('市场'), { target: { value: 'HK' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await screen.findByText('腾讯控股');
    expect(within(intlTable()).getByText('港股')).toBeInTheDocument();
    expect(within(intlTable()).getByText('HKD')).toBeInTheDocument();
    expect(within(intlTable()).getByText('18.5')).toBeInTheDocument();
    expect(within(intlTable()).getByText('32000')).toBeInTheDocument();
    expect(await screen.findByText('近一年日收盘价（2 根）')).toBeInTheDocument();
    expect(screen.getByText(/数据源：eastmoney/)).toBeInTheDocument();

    expect(mocks.getIntlFundamentals).toHaveBeenCalledWith('00700', 'HK');
    expect(mocks.getIntlKlines).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '00700',
        market: 'HK',
        startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    );
    expect(screen.getByRole('button', { name: '查询' })).toBeEnabled();
  });

  it('市场选「自动识别」并命中美股：市场参数传 undefined，表格按美股展示', async () => {
    mocks.getIntlFundamentals.mockResolvedValue({
      fundamentals: {
        ...FUNDAMENTALS,
        code: 'TSLA',
        name: '特斯拉',
        market: 'US',
        currency: 'USD',
      },
      degraded: false,
      source: 'eastmoney',
      fetchedAt: '2026-09-16T02:00:00.000Z',
    });
    await renderReady();

    fireEvent.change(screen.getByLabelText('代码'), { target: { value: 'tsla' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => expect(mocks.getIntlFundamentals).toHaveBeenCalledWith('tsla', undefined));
    const nameCell = await screen.findByText('特斯拉');
    const table = nameCell.closest('table') as HTMLElement;
    expect(within(table).getByText('美股')).toBeInTheDocument();
    expect(within(table).getByText('USD')).toBeInTheDocument();
  });

  it('K 线加载失败：估值表照常显示，K 线区单独给出失败原因', async () => {
    mocks.getIntlFundamentals.mockResolvedValue({
      fundamentals: FUNDAMENTALS,
      degraded: false,
      source: 'eastmoney',
      fetchedAt: '2026-09-16T02:00:00.000Z',
    });
    mocks.getIntlKlines.mockRejectedValue(new Error('K 线接口超时'));
    await renderReady();

    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '00700' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(await screen.findByText('K 线加载失败：K 线接口超时')).toBeInTheDocument();
    expect(screen.getByText('腾讯控股')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('查询降级（未返回 fundamentals）：提示检查代码/市场后重试', async () => {
    await renderReady();

    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '00700' } });
    fireEvent.change(screen.getByLabelText('市场'), { target: { value: 'HK' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(
      await screen.findByText(/查询降级或未返回数据（eastmoney），请检查代码\/市场后重试。/),
    ).toBeInTheDocument();
    expect(mocks.getIntlFundamentals).toHaveBeenCalledWith('00700', 'HK');
    // 没有 fundamentals 可依据时，K 线请求回落到用户显式选中的市场
    expect(mocks.getIntlKlines).toHaveBeenCalledWith(expect.objectContaining({ market: 'HK' }));
  });

  it('查询中：按钮变「查询中…」并禁用，返回后恢复', async () => {
    let resolveIntl!: (v: unknown) => void;
    mocks.getIntlFundamentals.mockReturnValue(
      new Promise((resolve) => {
        resolveIntl = resolve;
      }),
    );
    await renderReady();
    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '00700' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(await screen.findByRole('button', { name: '查询中…' })).toBeDisabled();

    resolveIntl({
      fundamentals: FUNDAMENTALS,
      degraded: false,
      source: 'eastmoney',
      fetchedAt: '2026-09-16T02:00:00.000Z',
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '查询' })).toBeEnabled());
  });

  it('查询失败：错误横幅显示中文原因', async () => {
    mocks.getIntlFundamentals.mockRejectedValue({
      response: { data: { error: '不支持的市场代码' } },
    });
    await renderReady();

    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '00700' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('不支持的市场代码');
  });

  it('估值为 0 的字段被当成缺值渲染成「—」（照现状锁定，报告里单列）', async () => {
    mocks.getIntlFundamentals.mockResolvedValue({
      fundamentals: { ...FUNDAMENTALS, pe: 0, pb: 0, marketCap: 0, revenue: 0, netIncome: 0 },
      degraded: false,
      source: 'eastmoney',
      fetchedAt: '2026-09-16T02:00:00.000Z',
    });
    await renderReady();

    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '00700' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await screen.findByText('腾讯控股');
    expect(within(intlTable()).getAllByText('—')).toHaveLength(5);
  });
});

describe('PaperTradingPage 合规审计日志', () => {
  function auditEntry(over: Record<string, unknown> = {}) {
    return {
      id: 'a1',
      timestamp: Date.UTC(2026, 8, 16, 2, 0, 0),
      sessionId: 's1',
      action: 'trade.signal',
      category: 'trade_signal',
      detail: '超限下单已拦截',
      riskLevel: 'high',
      ...over,
    };
  }

  it('首屏不带过滤条件查询；高危等级用 danger 红徽章（不借用涨跌绿）', async () => {
    mocks.getAuditLog.mockResolvedValue({ count: 1, entries: [auditEntry()] });
    await renderReady();

    expect(await screen.findByText('超限下单已拦截')).toBeInTheDocument();
    expect(screen.getByText('trade.signal')).toBeInTheDocument();
    expect(screen.getByText('高')).toHaveClass('chip-danger');
    expect(mocks.getAuditLog).toHaveBeenCalledWith({ limit: 20, offset: 0 });
  });

  it('低/中等级用中性徽章，等级一律中文展示', async () => {
    mocks.getAuditLog.mockResolvedValue({
      count: 2,
      entries: [
        auditEntry({ id: 'a1', riskLevel: 'info', detail: '查看行情' }),
        auditEntry({ id: 'a2', riskLevel: 'medium', detail: '大额下单' }),
      ],
    });
    await renderReady();

    expect(await screen.findByText('查看行情')).toBeInTheDocument();
    expect(screen.getByText('提示')).toHaveClass('chip-neutral');
    expect(screen.getByText('中')).toHaveClass('chip-neutral');
  });

  it('切换风险等级：带 riskLevel 重新查询', async () => {
    await renderReady();
    await waitFor(() => expect(mocks.getAuditLog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('风险等级过滤'), { target: { value: 'critical' } });

    await waitFor(() =>
      expect(mocks.getAuditLog).toHaveBeenLastCalledWith({
        riskLevel: 'critical',
        limit: 20,
        offset: 0,
      }),
    );
  });

  it('审计查询失败：静默降级为「暂无审计条目」，不弹错误横幅', async () => {
    mocks.getAuditLog.mockRejectedValue(new Error('audit down'));
    await renderReady();

    await waitFor(() => expect(mocks.getAuditLog).toHaveBeenCalled());
    await act(async () => {});

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('暂无审计条目')).toBeInTheDocument();
    // 主流程不受影响
    expect(screen.getByRole('button', { name: '下单' })).toBeEnabled();
  });

  it('「加载更多」失败：保留已显示条目、按钮恢复可点、不报错', async () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      auditEntry({ id: `a${i}`, detail: `d-${i}` }),
    );
    mocks.getAuditLog.mockResolvedValueOnce({ count: 25, entries });
    mocks.getAuditLog.mockRejectedValueOnce(new Error('audit down'));
    await renderReady();

    fireEvent.click(await screen.findByRole('button', { name: /加载更多（还剩 5 条）/ }));

    await waitFor(() => expect(mocks.getAuditLog).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /加载更多（还剩 5 条）/ })).toBeEnabled();
    // 仍有剩余 → 追加「按时间正序，最早在前」的说明
    expect(
      screen.getByText(/共 25 条，当前显示前 20 条（按时间正序，最早在前）/),
    ).toBeInTheDocument();
    expect(screen.getByText('d-0')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('带等级过滤时「加载更多」沿用该过滤条件与 offset（不会串回全部）', async () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      auditEntry({ id: `a${i}`, detail: `d-${i}` }),
    );
    mocks.getAuditLog.mockResolvedValue({ count: 25, entries });
    await renderReady();
    await waitFor(() => expect(mocks.getAuditLog).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('风险等级过滤'), { target: { value: 'high' } });
    await waitFor(() =>
      expect(mocks.getAuditLog).toHaveBeenLastCalledWith({
        riskLevel: 'high',
        limit: 20,
        offset: 0,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: /加载更多/ }));

    await waitFor(() =>
      expect(mocks.getAuditLog).toHaveBeenLastCalledWith({
        riskLevel: 'high',
        limit: 20,
        offset: 20,
      }),
    );
  });

  it('快速切换等级：乱序返回的旧响应被丢弃，不覆盖新结果', async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    mocks.getAuditLog
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );
    await renderReady();

    fireEvent.change(screen.getByLabelText('风险等级过滤'), { target: { value: 'high' } });
    await waitFor(() => expect(mocks.getAuditLog).toHaveBeenCalledTimes(2));

    // 第二次（high）先返回 → 采纳
    resolveSecond({ count: 1, entries: [auditEntry({ detail: '高危-新' })] });
    expect(await screen.findByText('高危-新')).toBeInTheDocument();

    // 第一次（全部）迟到 → 必须被 request-seq 守卫丢弃
    await act(async () => {
      resolveFirst({ count: 1, entries: [auditEntry({ id: 'stale', detail: '旧响应-全部' })] });
    });
    expect(screen.queryByText('旧响应-全部')).toBeNull();
    expect(screen.getByText('高危-新')).toBeInTheDocument();
  });

  it('「加载更多」返回时过滤条件已变：这一页作废，不把旧等级条目追加进来', async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) =>
      auditEntry({ id: `a${i}`, detail: `d-${i}` }),
    );
    const stalePage = Array.from({ length: 5 }, (_, i) =>
      auditEntry({ id: `b${i}`, detail: `d-${20 + i}` }),
    );
    let resolveMore!: (v: unknown) => void;
    mocks.getAuditLog
      .mockResolvedValueOnce({ count: 25, entries: firstPage })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveMore = resolve;
        }),
      )
      .mockResolvedValueOnce({ count: 1, entries: [auditEntry({ detail: '高危-新' })] });
    await renderReady();

    fireEvent.click(await screen.findByRole('button', { name: /加载更多/ }));
    await waitFor(() => expect(mocks.getAuditLog).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText('风险等级过滤'), { target: { value: 'high' } });
    expect(await screen.findByText('高危-新')).toBeInTheDocument();
    expect(screen.getByText(/共 1 条，当前显示前 1 条/)).toBeInTheDocument();

    // 迟到的第 2 页属于旧过滤条件：丢弃（追加进去会让用户看到不属于该等级的条目）
    await act(async () => {
      resolveMore({ count: 25, entries: stalePage });
    });
    expect(screen.queryByText('d-20')).toBeNull();
    expect(screen.getByText('高危-新')).toBeInTheDocument();
    expect(screen.getByText(/共 1 条，当前显示前 1 条/)).toBeInTheDocument();
  });
});

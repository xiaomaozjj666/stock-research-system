// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import WatchlistPage from '../WatchlistPage';
import { ToastProvider } from '../../../components/Toast';
import type { WatchlistAlertsSnapshot } from '../../../api/client';
import type { WatchlistNewsBacktestReport } from '../../../types';

/**
 * 自选股 / 持仓监控页：列表加载 → 添加/移除 → 批量回测 → 异动监控 → 最近快照回看。
 * 每条用例都打在用户能看到的东西上（中文横幅、按钮文案与可点性、表格数值、toast）。
 */
const api = vi.hoisted(() => ({
  getWatchlist: vi.fn(),
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
  runWatchlistNewsBacktest: vi.fn(),
  monitorWatchlist: vi.fn(),
  fetchWatchlistAlerts: vi.fn(),
  searchStocks: vi.fn(),
  normalizeApiError: vi.fn(),
}));

/** 取消错误类必须与组件 import 到的是同一个类对象（组件用 instanceof 判定） */
const CancelError = vi.hoisted(
  () =>
    class AnalysisCancelledError extends Error {
      constructor(message = '已取消') {
        super(message);
        this.name = 'AnalysisCancelledError';
      }
    },
);

vi.mock('../../../api/client', () => ({ ...api, AnalysisCancelledError: CancelError }));

// 回测总览里的新闻姿态热力条走 EChart：真实 echarts 在 jsdom 下无法 init
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../../lib/echarts', () => ({ default: { init: echartsMock.init } }));

interface ChartStub {
  setOption: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getZr: ReturnType<typeof vi.fn>;
}
let chart: ChartStub;

/** 可手动结算的 promise：用来观察「进行中」的按钮文案与取消行为 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function newsSignal(polarity: number, weightedImpact = 0.44, bullishRatio = 0.8) {
  return {
    polarity,
    sentimentZ: 1.2,
    bullishRatio,
    newsCount: 3,
    freshness: 0.9,
    weightedImpact,
    items: [],
    hasNews: true,
  };
}

/** 四行覆盖页面的全部分支：看多 / 看空 / 中性(极性恰为阈值 0.15) / 无新闻且无最优策略 */
function reportFixture(): WatchlistNewsBacktestReport {
  return {
    generatedAt: '2026-09-15T02:00:00.000Z',
    count: 4,
    withNewsCount: 3,
    results: [
      {
        code: '600519',
        name: '贵州茅台',
        newsSentiment: newsSignal(0.82, 0.44, 0.8),
        strategyList: [],
        bestStrategy: {
          strategyType: '动量策略',
          totalReturn: 10.5,
          sharpeRatio: 1.1,
          maxDrawdown: 6,
          winRate: 0.6,
          newsAware: {
            totalReturn: 12.345,
            sharpeRatio: 1.234,
            maxDrawdown: 4,
            winRate: 0.62,
            posture: 0.78,
          },
        },
        simulatedKline: false,
      },
      {
        code: '000001',
        name: '平安银行',
        newsSentiment: newsSignal(-0.62, 0.71, 0.2),
        strategyList: [],
        bestStrategy: {
          strategyType: '均值回归',
          totalReturn: -2,
          sharpeRatio: -0.4,
          maxDrawdown: 9,
          winRate: 0.4,
          newsAware: {
            totalReturn: -3.25,
            sharpeRatio: -0.54,
            maxDrawdown: 9,
            winRate: 0.4,
            posture: 0.31,
          },
        },
        simulatedKline: true,
        error: '行情接口不可达',
      },
      {
        code: '300750',
        name: null,
        newsSentiment: null,
        strategyList: [],
        bestStrategy: {
          strategyType: '网格交易',
          totalReturn: 1,
          sharpeRatio: 0.2,
          maxDrawdown: 3,
          winRate: 0.5,
        },
        simulatedKline: false,
      },
      {
        code: '002594',
        name: '比亚迪',
        newsSentiment: newsSignal(0.15, 0.2, 0.5),
        strategyList: [],
        bestStrategy: undefined,
        simulatedKline: false,
      },
    ],
  };
}

function snapshotFixture(
  overrides: Partial<WatchlistAlertsSnapshot> = {},
): WatchlistAlertsSnapshot {
  return { generatedAt: null, monitored: 0, alerts: [], ...overrides };
}

function renderPage() {
  return render(
    <ToastProvider>
      <WatchlistPage />
    </ToastProvider>,
  );
}

/** 报告表格行：代码在列表与表格里各出现一次，按「祖先是否 tr」取表格那一行 */
function tableRow(code: string) {
  const cell = screen.getAllByText(code).find((el) => el.closest('tr'));
  if (!cell) throw new Error(`表格中没有 ${code} 行`);
  return within(cell.closest('tr') as HTMLElement);
}

/** 展开下拉并选中候选（走真实 StockSearchInput 的 250ms 防抖 + mousedown 提交路径） */
async function pickFromDropdown(keyword: string, optionName: RegExp) {
  fireEvent.change(screen.getByRole('combobox', { name: '自选股搜索' }), {
    target: { value: keyword },
  });
  await waitFor(() => expect(api.searchStocks).toHaveBeenCalledWith(keyword), { timeout: 3000 });
  const option = await screen.findByRole('option', { name: optionName });
  fireEvent.mouseDown(option);
  return option;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.normalizeApiError.mockImplementation(
    (_err: unknown, fallback: string) => new Error(fallback),
  );
  api.getWatchlist.mockResolvedValue({ codes: ['600519'] });
  api.fetchWatchlistAlerts.mockResolvedValue(snapshotFixture());
  api.searchStocks.mockResolvedValue([]);
  chart = {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    on: vi.fn(),
    getZr: vi.fn(() => ({ on: vi.fn() })),
  };
  echartsMock.init.mockReset();
  echartsMock.init.mockReturnValue(chart);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WatchlistPage 首屏与列表', () => {
  it('挂载即拉取自选股列表与最近监控快照，并渲染清单条目', async () => {
    renderPage();

    expect(api.getWatchlist).toHaveBeenCalledTimes(1);
    expect(api.fetchWatchlistAlerts).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('600519')).toBeInTheDocument());
    // 服务端清单里没有名称时，移除按钮退化为只报代码
    expect(screen.getByRole('button', { name: '移除 600519' })).toBeInTheDocument();
    // 清单非空：两个批量操作按钮可点，且回测按钮带上股票数量
    expect(screen.getByRole('button', { name: '批量含最新消息回测（1）' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '监控异动' })).toBeEnabled();
  });

  it('列表加载中显示「加载中…」，不误报「还没有关注的股票」', async () => {
    const pending = deferred<{ codes: string[] }>();
    api.getWatchlist.mockReturnValue(pending.promise);
    renderPage();

    expect(screen.getByText('加载中…')).toBeInTheDocument();
    expect(screen.queryByText('还没有关注的股票')).toBeNull();
    // 加载期间也不能让用户提交添加，避免与首次拉取结果互相覆盖
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();

    pending.resolve({ codes: ['600519'] });
    await waitFor(() => expect(screen.getByText('600519')).toBeInTheDocument());
    expect(screen.queryByText('加载中…')).toBeNull();
  });

  it('加载成功且清单为空：渲染空态标题与添加入口提示，两个批量按钮禁用', async () => {
    api.getWatchlist.mockResolvedValue({ codes: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText('还没有关注的股票')).toBeInTheDocument());
    expect(
      screen.getByText(
        '在上方输入股票代码或名称（如 600519 / 贵州茅台）添加，即可批量回测与异动监控。',
      ),
    ).toBeInTheDocument();
    // 空清单下按钮必须禁用（点击只会得到一句「清单为空」的提示）
    expect(screen.getByRole('button', { name: '批量含最新消息回测（0）' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '监控异动' })).toBeDisabled();
  });

  it('服务端未返回 codes 字段时按空清单处理（不渲染出 undefined）', async () => {
    api.getWatchlist.mockResolvedValue({} as { codes: string[] });
    renderPage();

    await waitFor(() => expect(screen.getByText('还没有关注的股票')).toBeInTheDocument());
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
});

describe('WatchlistPage 加载失败与重试', () => {
  it('加载失败：给出中文原因、英文原文只留在 title，并提供「重试」', async () => {
    api.normalizeApiError.mockReturnValue(
      new Error(
        '无法连接后端服务（localhost:3001）。请确认服务已启动，或运行「启动系统.bat」后重试',
      ),
    );
    api.getWatchlist.mockRejectedValue(new Error('Network Error'));
    renderPage();

    const alert = await screen.findByRole('alert');
    const text = within(alert).getByText(
      '自选股加载失败：无法连接后端服务（localhost:3001）。请确认服务已启动，或运行「启动系统.bat」后重试',
    );
    expect(text).toHaveAttribute('title', 'Network Error');
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument();
    // 加载失败 ≠ 没有关注股票：空态文案不能出现（否则用户以为自己的清单被清空了）
    expect(screen.queryByText('还没有关注的股票')).toBeNull();
  });

  it('失败原因本身已是中文：直接沿用，不再经翻译层包一层', async () => {
    api.getWatchlist.mockRejectedValue(new Error('后端服务异常（500），请查看服务端日志'));
    renderPage();

    const text = await screen.findByText('自选股加载失败：后端服务异常（500），请查看服务端日志');
    expect(api.normalizeApiError).not.toHaveBeenCalled();
    expect(text).not.toHaveAttribute('title');
  });

  it('非 Error 抛出（如字符串）也落到中文兜底原因，不留空横幅', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    api.getWatchlist.mockRejectedValue('boom');
    renderPage();

    const text = await screen.findByText('自选股加载失败：请确认后端服务已启动后重试');
    expect(text).not.toHaveAttribute('title');
    expect(api.normalizeApiError).toHaveBeenCalledWith('boom', '请确认后端服务已启动后重试');
  });

  it('点「重试」重新拉取列表：成功后横幅消失、清单出现', async () => {
    api.getWatchlist.mockRejectedValueOnce(new Error('Network Error'));
    renderPage();
    await screen.findByRole('alert');
    expect(screen.queryByText('600519')).toBeNull();

    api.getWatchlist.mockResolvedValue({ codes: ['000001'] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(screen.getByText('000001')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('WatchlistPage 添加与移除', () => {
  it('输入 6 位代码点「添加」：按代码直接添加，列表出现该代码', async () => {
    api.addToWatchlist.mockResolvedValue({ codes: ['600519', '000858'] });
    renderPage();
    await screen.findByText('600519');

    fireEvent.change(screen.getByRole('combobox', { name: '自选股搜索' }), {
      target: { value: '000858' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(screen.getByText('000858')).toBeInTheDocument());
    expect(api.addToWatchlist).toHaveBeenCalledWith('000858');
    // 没有名称时移除按钮只报代码
    expect(screen.getByRole('button', { name: '移除 000858' })).toBeInTheDocument();
  });

  it('从下拉候选选中：列表显示中文名称，移除按钮同时标注名称与代码', async () => {
    api.searchStocks.mockResolvedValue([{ code: '000858', name: '五粮液' }]);
    api.addToWatchlist.mockResolvedValue({ codes: ['600519', '000858'] });
    const { container } = renderPage();
    await screen.findByText('600519');

    await pickFromDropdown('五粮液', /五粮液/);

    // 接口只收代码；名称仅用于本地清单展示
    await waitFor(() => expect(api.addToWatchlist).toHaveBeenCalledWith('000858'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '移除 五粮液（000858）' })).toBeInTheDocument(),
    );
    const item = screen.getByRole('button', { name: '移除 五粮液（000858）' }).closest('li');
    expect(within(item as HTMLElement).getByText('五粮液')).toHaveClass('watchlist-name');
    expect(within(item as HTMLElement).getByText('000858')).toHaveClass('watchlist-code');
    // 选中后输入框清空、下拉收起，便于连续添加
    expect(screen.getByRole('combobox', { name: '自选股搜索' })).toHaveValue('');
    expect(container.querySelector('.stock-search-dropdown')).toBeNull();
  });

  it('服务端候选返回空代码时不发添加请求（避免写入空标的）', async () => {
    api.searchStocks.mockResolvedValue([{ code: '', name: '异常数据' }]);
    renderPage();
    await screen.findByText('600519');

    await pickFromDropdown('异常', /异常数据/);

    await waitFor(() => expect(api.searchStocks).toHaveBeenCalledTimes(1));
    expect(api.addToWatchlist).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('添加失败：横幅说明是「添加」失败且不给重试按钮（缺原始入参无法安全重放），已有清单不被藏起来', async () => {
    api.searchStocks.mockResolvedValue([{ code: '000858', name: '五粮液' }]);
    api.addToWatchlist.mockRejectedValue(new Error('Network Error'));
    renderPage();
    await screen.findByText('600519');

    await pickFromDropdown('五粮液', /五粮液/);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('添加自选股失败：请确认后端服务已启动后重试');
    expect(within(alert).queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.getByText('600519')).toBeInTheDocument();
  });

  it('移除：点击后该股票从清单消失，清单清空即回到空态', async () => {
    api.removeFromWatchlist.mockResolvedValue({ codes: [] });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '移除 600519' }));

    await waitFor(() => expect(screen.getByText('还没有关注的股票')).toBeInTheDocument());
    expect(api.removeFromWatchlist).toHaveBeenCalledWith('600519');
    expect(screen.queryByText('600519')).toBeNull();
  });

  it('移除失败：横幅说明是「移除」失败、无重试按钮，清单保持原样', async () => {
    api.removeFromWatchlist.mockRejectedValue(new Error('Network Error'));
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '移除 600519' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('移除自选股失败：请稍后重试');
    expect(within(alert).queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.getByText('600519')).toBeInTheDocument();
  });
});

describe('WatchlistPage 批量含最新消息回测', () => {
  it('回测进行中：按钮变「回测中…」并禁用，同时出现「取消回测」', async () => {
    const pending = deferred<WatchlistNewsBacktestReport>();
    api.runWatchlistNewsBacktest.mockReturnValue(pending.promise);
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));

    const running = screen.getByRole('button', { name: '回测中…' });
    expect(running).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消回测' })).toBeInTheDocument();

    pending.resolve(reportFixture());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '批量含最新消息回测（1）' })).toBeEnabled(),
    );
    expect(screen.queryByRole('button', { name: '取消回测' })).toBeNull();
  });

  it('回测成功：汇总行、七列表格数值、模拟 K 线提示与热力条都渲染出来', async () => {
    api.runWatchlistNewsBacktest.mockResolvedValue(reportFixture());
    const { container } = renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));

    await waitFor(() => expect(screen.getByText('共 4 只，命中最新消息 3 只')).toBeInTheDocument());
    for (const header of [
      '代码',
      '名称',
      '新闻',
      '最优策略',
      '含消息收益',
      '含消息夏普',
      '新闻姿态',
    ]) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    // 生成时间按本地时区展示
    expect(
      screen.getByText(new Date('2026-09-15T02:00:00.000Z').toLocaleString('zh-CN')),
    ).toHaveClass('watchlist-report-time');

    // 看多行：偏多文案 + 正收益用红色（val-positive）
    const bull = tableRow('600519');
    expect(bull.getByText('贵州茅台')).toBeInTheDocument();
    expect(bull.getByText('偏多 0.82')).toHaveClass('news-badge--bull');
    expect(bull.getByText('动量策略')).toBeInTheDocument();
    expect(bull.getByText('+12.3%')).toHaveClass('val-positive');
    expect(bull.getByText('1.23')).toBeInTheDocument();
    expect(bull.getByText('78%')).toBeInTheDocument();

    // 看空行：偏空文案 + 负收益用绿色（val-negative）
    const bear = tableRow('000001');
    expect(bear.getByText('偏空 -0.62')).toHaveClass('news-badge--bear');
    expect(bear.getByText('-3.3%')).toHaveClass('val-negative');
    expect(bear.getByText('-0.54')).toBeInTheDocument();
    expect(bear.getByText('31%')).toBeInTheDocument();

    // 无新闻行：新闻列显示「无」，缺失字段一律显示破折号
    const noNews = tableRow('300750');
    expect(noNews.getByText('无')).toBeInTheDocument();
    // 有最优策略但没有含消息回测：策略名照常显示，名称与三个含消息数值列为「—」
    expect(noNews.getByText('网格交易')).toBeInTheDocument();
    expect(noNews.getAllByText('—')).toHaveLength(4);

    // 极性恰为阈值 0.15 判中性；没有 bestStrategy 时策略与数值列全为「—」
    const boundary = tableRow('002594');
    expect(boundary.getByText('中性 0.15')).toHaveClass('news-badge--neutral');
    expect(boundary.getAllByText('—')).toHaveLength(4);

    expect(
      screen.getByText('注：部分标的因行情接口不可达，回测使用模拟 K 线，结果仅供参考。'),
    ).toBeInTheDocument();

    // 热力条：图表标题、图例（红=偏多、绿=偏空）与真实数据点
    expect(screen.getByText('新闻姿态热力条（自选股批量回测总览）')).toBeInTheDocument();
    expect(screen.getByText(/偏多（红）/)).toBeInTheDocument();
    expect(screen.getByText(/偏空（绿）/)).toBeInTheDocument();
    expect(screen.getByText(/无最新消息（灰）/)).toBeInTheDocument();
    // EChart 的 init/setOption 都在 useEffect 里跑：DOM 提交与副作用冲刷之间有一段调度间隙
    // （机器繁忙时会被推迟），所以这里重试等待，避免在副作用落地前读到空调用记录。
    await waitFor(() => {
      expect(echartsMock.init).toHaveBeenCalledTimes(1);
      expect(chart.setOption).toHaveBeenCalledTimes(1);
    });
    const option = chart.setOption.mock.calls[0][0] as {
      series: { data: { itemStyle: { color: string } }[] }[];
      yAxis: { data: string[] };
    };
    expect(option.yAxis.data).toContain('600519 贵州茅台');
    expect(option.series[0].data).toHaveLength(4);
    // 按极性降序：首条（看多 0.82）取红、末条（看空 -0.62）取绿
    expect(option.series[0].data[0].itemStyle.color).toContain('rgba(239,68,68');
    expect(option.series[0].data[3].itemStyle.color).toContain('rgba(34,197,94');
    expect(container.querySelector('.watchlist-report')).not.toBeNull();
  });

  it('收益恰为 0：按「涨」渲染成红色 +0.0%（现状，与 lib/colors 的 0=中性口径冲突，见交付说明）', async () => {
    api.runWatchlistNewsBacktest.mockResolvedValue({
      generatedAt: '2026-09-15T02:00:00.000Z',
      count: 1,
      withNewsCount: 1,
      results: [
        {
          code: '601318',
          name: '中国平安',
          newsSentiment: newsSignal(0.3, 0.1, 0.6),
          strategyList: [],
          bestStrategy: {
            strategyType: '动量策略',
            totalReturn: 3,
            sharpeRatio: 0.4,
            maxDrawdown: 2,
            winRate: 0.5,
            newsAware: {
              totalReturn: 0,
              sharpeRatio: 0,
              maxDrawdown: 0,
              winRate: 0.5,
              posture: 0.5,
            },
          },
          simulatedKline: false,
        },
      ],
    });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));

    await waitFor(() => expect(screen.getByText('共 1 只，命中最新消息 1 只')).toBeInTheDocument());
    const cell = tableRow('601318').getByText('+0.0%');
    expect(cell).toHaveClass('val-positive');
    expect(cell).not.toHaveClass('val-neutral');
    expect(tableRow('601318').getByText('0.00')).toBeInTheDocument();
  });

  it('回测结果为空数组：仍显示汇总行，但不渲染热力条与模拟 K 线提示', async () => {
    api.runWatchlistNewsBacktest.mockResolvedValue({
      generatedAt: '2026-09-15T02:00:00.000Z',
      count: 0,
      withNewsCount: 0,
      results: [],
    });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));

    await waitFor(() => expect(screen.getByText('共 0 只，命中最新消息 0 只')).toBeInTheDocument());
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByText('新闻姿态热力条（自选股批量回测总览）')).toBeNull();
    expect(screen.queryByText(/回测使用模拟 K 线/)).toBeNull();
  });

  it('回测失败：横幅说明回测失败并给「重试」，重试后成功即渲染报告', async () => {
    api.runWatchlistNewsBacktest.mockRejectedValueOnce(new Error('Network Error'));
    api.runWatchlistNewsBacktest.mockResolvedValueOnce(reportFixture());
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('批量回测失败：请确认后端服务已启动后重试');
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));

    await waitFor(() => expect(screen.getByText('共 4 只，命中最新消息 3 只')).toBeInTheDocument());
    expect(api.runWatchlistNewsBacktest).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('取消回测：中止在途请求并提示「已取消本次回测」，不留错误横幅', async () => {
    let signal: AbortSignal | undefined;
    api.runWatchlistNewsBacktest.mockImplementation((_codes: string[], s: AbortSignal) => {
      signal = s;
      return new Promise((_resolve, reject) => {
        s.addEventListener('abort', () => reject(new CancelError('批量回测已取消')));
      });
    });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));
    fireEvent.click(screen.getByRole('button', { name: '取消回测' }));

    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText(/已取消本次回测/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '批量含最新消息回测（1）' })).toBeEnabled(),
    );
  });

  it('卸载页面时中止在途回测，不再向已卸载组件写状态', async () => {
    let signal: AbortSignal | undefined;
    api.runWatchlistNewsBacktest.mockImplementation((_codes: string[], s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    const { unmount } = renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
  });
});

describe('WatchlistPage 异动监控', () => {
  it('监控成功且检出异动：toast 报条数，常驻卡片刷新为「最近监控」并列出三条不同级别', async () => {
    api.monitorWatchlist.mockResolvedValue({
      generatedAt: '2026-09-15T02:00:00.000Z',
      monitored: 2,
      alerts: [
        {
          code: '600519',
          name: '贵州茅台',
          level: 'strong-bull',
          polarity: 0.82,
          weightedImpact: 0.44,
          detail: '贵州茅台 新闻姿态强烈看多',
        },
        {
          code: '000001',
          name: '平安银行',
          level: 'strong-bear',
          polarity: -0.71,
          weightedImpact: 0.62,
          detail: '平安银行 新闻姿态强烈看空',
        },
        {
          code: '300750',
          name: null,
          level: 'high-impact',
          polarity: 0.31,
          weightedImpact: 0.88,
          detail: '宁德时代 出现高影响新闻',
        },
      ],
    });
    const { container } = renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '监控异动' }));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('发现 3 条异动预警');
    expect(toast).toHaveClass('toast-info');
    expect(screen.getByText(/最近监控：.*｜3 条异动 · 覆盖 2 只/)).toBeInTheDocument();

    expect(screen.getByText('强烈看多')).toHaveClass('watchlist-alert-level');
    expect(screen.getByText('强烈看空')).toBeInTheDocument();
    expect(screen.getByText('高影响新闻')).toBeInTheDocument();
    expect(container.querySelector('.watchlist-alert.alert-bull')).not.toBeNull();
    expect(container.querySelector('.watchlist-alert.alert-bear')).not.toBeNull();
    expect(container.querySelector('.watchlist-alert.alert-impact')).not.toBeNull();
    // 极性 / 影响强度按口径格式化；名称为 null 的条目只显示代码
    expect(screen.getByText('极性 0.82 · 影响 44%')).toBeInTheDocument();
    expect(screen.getByText('极性 -0.71 · 影响 62%')).toBeInTheDocument();
    expect(screen.getByText('极性 0.31 · 影响 88%')).toBeInTheDocument();
    expect(screen.getByText('宁德时代 出现高影响新闻')).toBeInTheDocument();
  });

  it('监控完成但无异动：toast 提示「本轮无异动预警」，卡片给出阈值说明', async () => {
    api.monitorWatchlist.mockResolvedValue({
      generatedAt: '2026-09-15T02:00:00.000Z',
      monitored: 1,
      alerts: [],
    });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '监控异动' }));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('本轮无异动预警');
    // 无异动是「正常结果」而非提示级信息
    expect(toast).toHaveClass('toast-success');
    expect(
      screen.getByText('本轮监控未发现异动（阈值：|极性|≥0.5 或影响强度≥0.6）。'),
    ).toBeInTheDocument();
  });

  it('监控进行中：按钮变「监控中…」并禁用，出现「取消监控」', async () => {
    const pending = deferred<WatchlistAlertsSnapshot>();
    api.monitorWatchlist.mockReturnValue(pending.promise);
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '监控异动' }));

    expect(screen.getByRole('button', { name: '监控中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消监控' })).toBeInTheDocument();

    pending.resolve(snapshotFixture({ generatedAt: '2026-09-15T02:00:00.000Z', monitored: 1 }));
    await waitFor(() => expect(screen.getByRole('button', { name: '监控异动' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: '取消监控' })).toBeNull();
  });

  it('监控失败：横幅说明监控失败并给「重试」，重试成功后刷新卡片', async () => {
    api.monitorWatchlist.mockRejectedValueOnce(new Error('Network Error'));
    api.monitorWatchlist.mockResolvedValueOnce({
      generatedAt: '2026-09-15T02:00:00.000Z',
      monitored: 1,
      alerts: [],
    });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '监控异动' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('自选股监控失败：请确认后端服务已启动后重试');
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));

    await waitFor(() => expect(screen.getByText(/｜0 条异动 · 覆盖 1 只/)).toBeInTheDocument());
    expect(api.monitorWatchlist).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('取消监控：中止在途请求并提示「已取消本次监控」', async () => {
    let signal: AbortSignal | undefined;
    api.monitorWatchlist.mockImplementation((s: AbortSignal) => {
      signal = s;
      return new Promise((_resolve, reject) => {
        s.addEventListener('abort', () => reject(new CancelError('监控已取消')));
      });
    });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '监控异动' }));
    fireEvent.click(screen.getByRole('button', { name: '取消监控' }));

    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText(/已取消本次监控/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('WatchlistPage 错误留存与空清单守卫', () => {
  it('回测失败后清单被清空：点「重试」给出「自选股清单为空」提示而非发起请求，且不再给重试按钮', async () => {
    const pending = deferred<WatchlistNewsBacktestReport>();
    api.runWatchlistNewsBacktest.mockReturnValue(pending.promise);
    api.removeFromWatchlist.mockResolvedValue({ codes: [] });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));
    fireEvent.click(screen.getByRole('button', { name: '移除 600519' }));
    await waitFor(() => expect(screen.getByText('还没有关注的股票')).toBeInTheDocument());

    pending.reject(new Error('Network Error'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('批量回测失败：请确认后端服务已启动后重试');

    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));

    const emptyAlert = await screen.findByRole('alert');
    expect(emptyAlert).toHaveTextContent('自选股清单为空，请先添加股票');
    expect(within(emptyAlert).queryByRole('button', { name: '重试' })).toBeNull();
    expect(api.runWatchlistNewsBacktest).toHaveBeenCalledTimes(1);
  });

  it('监控失败后清单被清空：点「重试」同样只提示清单为空', async () => {
    const pending = deferred<WatchlistAlertsSnapshot>();
    api.monitorWatchlist.mockReturnValue(pending.promise);
    api.removeFromWatchlist.mockResolvedValue({ codes: [] });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '监控异动' }));
    fireEvent.click(screen.getByRole('button', { name: '移除 600519' }));
    await waitFor(() => expect(screen.getByText('还没有关注的股票')).toBeInTheDocument());

    pending.reject(new Error('Network Error'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('自选股监控失败：请确认后端服务已启动后重试');

    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));

    expect(await screen.findByText('自选股清单为空，请先添加股票')).toBeInTheDocument();
    expect(api.monitorWatchlist).toHaveBeenCalledTimes(1);
  });
});

describe('WatchlistPage 最近监控快照卡片', () => {
  it('快照时间戳无法解析时原样展示，不让用户看到 Invalid Date', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue(snapshotFixture({ generatedAt: '--:--' }));
    renderPage();

    expect(await screen.findByText(/最近监控：--:--｜0 条异动 · 覆盖 0 只/)).toBeInTheDocument();
    expect(
      screen.getByText('本轮监控未发现异动（阈值：|极性|≥0.5 或影响强度≥0.6）。'),
    ).toBeInTheDocument();
  });

  it('快照读取失败：卡片显示中文原因（经兜底翻译），保留「监控异动」入口', async () => {
    api.fetchWatchlistAlerts.mockRejectedValue(new Error('Network Error'));
    renderPage();

    expect(await screen.findByText('最近监控记录读取失败：请稍后重试')).toBeInTheDocument();
    expect(screen.queryByText(/尚未监控过/)).toBeNull();
    expect(screen.getByRole('button', { name: '监控异动' })).toBeInTheDocument();
  });

  it('两种批量操作可同时发起，但「取消」只有一个且文案指向回测', async () => {
    // 记录当前行为：回测在途时「监控异动」并未被禁用，两者并行会互相覆盖中止器
    let runSignal: AbortSignal | undefined;
    let monitorSignal: AbortSignal | undefined;
    api.runWatchlistNewsBacktest.mockImplementation((_codes: string[], s: AbortSignal) => {
      runSignal = s;
      return new Promise(() => {});
    });
    api.monitorWatchlist.mockImplementation((s: AbortSignal) => {
      monitorSignal = s;
      return new Promise(() => {});
    });
    renderPage();
    await screen.findByText('600519');

    fireEvent.click(screen.getByRole('button', { name: '批量含最新消息回测（1）' }));
    expect(screen.getByRole('button', { name: '监控异动' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '监控异动' }));

    expect(screen.getByRole('button', { name: '回测中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '监控中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '回测中…' })).toBeInTheDocument();
    // 只有一个取消按钮，且文案取 running 优先
    expect(screen.queryByRole('button', { name: '取消监控' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取消回测' }));

    // 现状：中止的是后发起的监控请求，回测请求仍在途
    expect(monitorSignal?.aborted).toBe(true);
    expect(runSignal?.aborted).toBe(false);
  });
});

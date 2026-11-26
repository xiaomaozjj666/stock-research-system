// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// 打桩 API 层：本页只做聚合展示，不应触发任何真实网络请求
const api = vi.hoisted(() => ({
  fetchWatchlistAlerts: vi.fn(),
  getResearchDigests: vi.fn(),
  getWatchlist: vi.fn(),
  fetchHistoryList: vi.fn(),
}));

vi.mock('../../../api/client', () => ({
  ...api,
  normalizeApiError: (_e: unknown, fallback = '请求失败') => new Error(fallback),
}));

const { default: TodayPanel } = await import('../TodayPanel');

/** 最小可用的历史条目（含时间线，用于算出观点变化） */
function historyItem(over: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    stockCode: '600519',
    stockName: '贵州茅台',
    rating: '优先跟踪',
    totalScore: 82,
    createdAt: '2026-09-16T02:00:00.000Z',
    timeline: [
      { date: '2026-09-10', score: 75, rating: '持续观察' },
      { date: '2026-09-16', score: 82, rating: '优先跟踪' },
    ],
    ...over,
  };
}

/** 永不 settle 的桩：用于观察「请求在途」这一态 */
function pending<T = unknown>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('TodayPanel 今日聚合', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWatchlist.mockResolvedValue({ codes: ['600519'] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('三块数据源均无内容时，分别给出"如何才会有内容"的指引而不是空白', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.fetchHistoryList.mockResolvedValue([]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/尚未监控过/)).toBeInTheDocument());
    expect(screen.getByText(/暂无明显观点变化/)).toBeInTheDocument();
    expect(screen.getByText(/还没有简报/)).toBeInTheDocument();
  });

  it('有监控快照与观点变化时渲染条目，并按 A 股约定用红色表示评分上升', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({
      generatedAt: '2026-09-16T02:30:00.000Z',
      monitored: 1,
      alerts: [{ code: '600519', name: '贵州茅台', level: 'strong-bull', detail: '放量涨停' }],
    });
    api.getResearchDigests.mockResolvedValue({
      items: [
        {
          id: 'd1',
          createdAt: '2026-09-16T01:00:00.000Z',
          screener: { hitCount: 2, topHits: [{ code: '000858', name: '五粮液' }] },
        },
      ],
    });
    api.fetchHistoryList.mockResolvedValue([historyItem()]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/放量涨停/)).toBeInTheDocument());
    expect(screen.getByText(/覆盖 1 只/)).toBeInTheDocument();

    const delta = screen.getByText('▲ +7');
    expect(delta.className).toContain('val-positive'); // 红涨
    expect(screen.getByText(/初筛命中 2 只/)).toBeInTheDocument();
  });

  it('单个数据源失败只影响自己那一块（不整页空白）', async () => {
    api.fetchWatchlistAlerts.mockRejectedValue(new Error('后端未启动'));
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.fetchHistoryList.mockResolvedValue([historyItem()]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/异动数据读取失败/)).toBeInTheDocument());
    // 其余两块仍正常渲染
    expect(screen.getByText(/暂无明显观点变化|▲ \+7/)).toBeInTheDocument();
    expect(screen.getByText(/还没有简报/)).toBeInTheDocument();
  });

  it('自选股之外的标的评分变化不进"今日"（只看关注股）', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.fetchHistoryList.mockResolvedValue([
      historyItem({ stockCode: '000001', stockName: '平安银行' }),
    ]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/暂无明显观点变化/)).toBeInTheDocument());
    expect(screen.queryByText(/平安银行/)).toBeNull();
  });
});

/**
 * 加载态必须是独立的第三态。
 * 背景：此前 loading 只用于刷新按钮文案，三块正文的判据是 `alerts === null` /
 * `changes.length === 0` / `!digest`——请求在途时先渲染「尚未监控过」「暂无明显观点变化」
 * 「还没有简报」这些**确定的空态结论**，而四个接口各自 15s 超时，
 * 用户会据此判断「今天没事」。
 */
describe('TodayPanel 加载态不得被渲染成空态结论', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWatchlist.mockResolvedValue({ codes: ['600519'] });
    // 四个接口全部在途：永不 settle，页面停在「加载中」这一态
    api.fetchWatchlistAlerts.mockReturnValue(pending());
    api.getResearchDigests.mockReturnValue(pending());
    api.getWatchlist.mockReturnValue(pending());
    api.fetchHistoryList.mockReturnValue(pending());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('请求在途时三块都显示加载态，且不出现任何"确定性空态"文案', () => {
    render(<TodayPanel />);

    expect(screen.getByText('自选股异动加载中…')).toBeInTheDocument();
    expect(screen.getByText('关注股观点变化加载中…')).toBeInTheDocument();
    expect(screen.getByText('最近研究简报加载中…')).toBeInTheDocument();

    // 这三个结论必须等数据到达后才允许出现
    expect(screen.queryByText(/尚未监控过/)).toBeNull();
    expect(screen.queryByText(/暂无明显观点变化/)).toBeNull();
    expect(screen.queryByText(/还没有简报/)).toBeNull();
    expect(screen.queryByText(/读取失败/)).toBeNull();
  });

  it('数据到达后才判空：加载态收起、空态结论才出现', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.getWatchlist.mockResolvedValue({ codes: ['600519'] });
    api.fetchHistoryList.mockResolvedValue([]);
    render(<TodayPanel />);

    expect(screen.getByText('自选股异动加载中…')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/尚未监控过/)).toBeInTheDocument());
    expect(screen.queryByText(/加载中…/)).toBeNull();
  });
});

/**
 * 失败文案必须来自 Promise.allSettled 的真实 reason。
 * 此前 failedParts 只存布尔、reason 被丢弃，最后用 `normalizeApiError(null, …)` 造文案，
 * 而 client.ts 对「无 response」恒返回「无法连接后端服务」→ 500/超时/404 全被报成「后端没启动」。
 */
describe('TodayPanel 失败文案来自真实 reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('异动接口 500：显示该块自己的失败兜底文案，不凭空断言「后端没启动」', async () => {
    api.fetchWatchlistAlerts.mockRejectedValue({
      response: { status: 500, data: { error: '异动快照落盘失败' } },
    });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.getWatchlist.mockResolvedValue({ codes: [] });
    api.fetchHistoryList.mockResolvedValue([]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/异动数据读取失败/)).toBeInTheDocument());
    expect(screen.getByText(/异动数据读取失败：异动数据读取失败，请稍后重试/)).toBeInTheDocument();
    // reason 若被丢弃就会退化成「无法连接后端服务」（normalizeApiError(null, …) 的恒返回）
    expect(screen.queryByText(/无法连接后端服务/)).toBeNull();
    expect(screen.queryByText(/后端服务已启动/)).toBeNull();
  });

  it('观点变化块失败：用该块自己的失败文案，不误报成「后端没启动」', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.getWatchlist.mockRejectedValue(new Error('Network Error'));
    api.fetchHistoryList.mockRejectedValue(new Error('Network Error'));

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/观点变化读取失败/)).toBeInTheDocument());
    expect(screen.getByText(/观点变化读取失败：观点变化读取失败，请稍后重试/)).toBeInTheDocument();
    expect(screen.queryByText(/后端服务已启动/)).toBeNull();
  });

  it('简报接口失败：错误是该块的失败文案，成功块照常渲染', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({
      generatedAt: '2026-09-16T02:30:00.000Z',
      monitored: 1,
      alerts: [{ code: '600519', name: '贵州茅台', level: 'strong-bull', detail: '放量涨停' }],
    });
    api.getResearchDigests.mockRejectedValue({
      response: { status: 504, data: { error: '简报接口超时' } },
    });
    api.getWatchlist.mockResolvedValue({ codes: ['600519'] });
    api.fetchHistoryList.mockResolvedValue([historyItem()]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/简报读取失败/)).toBeInTheDocument());
    expect(screen.getByText(/简报读取失败：简报读取失败，请稍后重试/)).toBeInTheDocument();
    // 其余两块不受影响
    expect(screen.getByText(/放量涨停/)).toBeInTheDocument();
    expect(screen.getByText('▲ +7')).toBeInTheDocument();
  });

  it('自选/历史任一失败：观点变化块如实报错，不误报成其余两块', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({
      generatedAt: '2026-09-16T02:30:00.000Z',
      monitored: 0,
      alerts: [],
    });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.getWatchlist.mockRejectedValue(new Error('watchlist down'));
    api.fetchHistoryList.mockResolvedValue([historyItem()]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/观点变化读取失败/)).toBeInTheDocument());
    expect(screen.getByText(/本次监控未发现异动/)).toBeInTheDocument();
    expect(screen.getByText(/还没有简报/)).toBeInTheDocument();
  });

  it('变化计算：跳过单点/零变化同评级，保留持平换评级并按幅度排序', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.getWatchlist.mockResolvedValue({ codes: ['600519', '000001', '000002', '000003'] });
    api.fetchHistoryList.mockResolvedValue([
      // 只有一个时间点 → 跳过
      historyItem({
        id: 'h0',
        stockCode: '600519',
        timeline: [{ date: '2026-09-16', score: 80, rating: '持续观察' }],
      }),
      // 分数与评级都没变 → 跳过
      historyItem({
        id: 'h1',
        stockCode: '000001',
        stockName: '平安银行',
        timeline: [
          { date: '2026-09-10', score: 80, rating: '持续观察' },
          { date: '2026-09-16', score: 80, rating: '持续观察' },
        ],
      }),
      // 分数不变但评级变了 → 保留「持平」
      historyItem({
        id: 'h2',
        stockCode: '000002',
        stockName: '',
        timeline: [
          { date: '2026-09-10', score: 80, rating: '持续观察' },
          { date: '2026-09-16', score: 80, rating: '优先跟踪' },
        ],
      }),
      // 大幅下降
      historyItem({
        id: 'h3',
        stockCode: '000003',
        stockName: '万科A',
        timeline: [
          { date: '2026-09-10', score: 85, rating: '优先跟踪' },
          { date: '2026-09-16', score: 76, rating: '持续观察' },
        ],
      }),
    ]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText('万科A（000003）')).toBeInTheDocument());
    // 仅两条保留：-9 排在持平之前；name 为空时用代码兜底
    expect(screen.getByText('000002（000002）')).toBeInTheDocument();
    expect(screen.getByText('▼ -9')).toBeInTheDocument();
    expect(screen.getByText('— 持平')).toBeInTheDocument();
    expect(screen.queryByText(/平安银行/)).toBeNull();

    const rows = screen.getAllByText(/（\d{6}）/);
    expect(rows[0].textContent).toContain('万科A');
    expect(rows[1].textContent).toContain('000002');
  });

  it('简报缺少 screener 字段：命中数按 0 展示且不拼「代表」', async () => {
    api.fetchWatchlistAlerts.mockResolvedValue({ generatedAt: null, monitored: 0, alerts: [] });
    api.getResearchDigests.mockResolvedValue({
      items: [{ id: 'd1', createdAt: 'not-a-date' }],
    });
    api.fetchHistoryList.mockResolvedValue([]);

    render(<TodayPanel />);

    await waitFor(() => expect(screen.getByText(/初筛命中/)).toBeInTheDocument());
    expect(screen.getByText(/初筛命中\s*0\s*只/)).toBeInTheDocument();
    expect(screen.queryByText(/代表：/)).toBeNull();
    expect(screen.getByText(/生成于 —/)).toBeInTheDocument();
  });
});

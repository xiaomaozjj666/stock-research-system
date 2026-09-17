import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AnalysisCancelledError,
  analyzeStock,
  analyzeStockStream,
  getStockList,
  searchStocks,
  runQuantAnalysis,
  runBatchCompositeAlpha,
  getUniverseBoards,
  runCrossSectionEvaluation,
  compareStocks,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  runWatchlistNewsBacktest,
  chatWithAgentStream,
  listDocuments,
  getCostReport,
  resetCostReport,
  stopAutonomous,
  getAutonomousStatus,
  getPaperPortfolio,
  placePaperOrder,
  settlePaperDay,
  getPaperStats,
  getFactorExperiments,
  getResearchDigests,
  runResearchDigestNow,
  getQuantHealth,
  getIntlFundamentals,
  getIntlKlines,
  runValuationModelApi,
  fetchHistoryList,
  fetchHistoryDetail,
  deleteHistoryItem,
  monitorWatchlist,
  fetchWatchlistAlerts,
  normalizeApiError,
  type ChatStreamEvent,
} from '../client.js';

// axios 实例换成可控桩；isCancel 复刻真实判据（__CANCEL__ 标记），
// 让"取消"路径走与生产一致的判定，而不是另写一套。
const axiosInst = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    create: () => axiosInst,
    isCancel: (v: unknown) => !!(v && (v as { __CANCEL__?: boolean }).__CANCEL__),
  },
}));

/** axios 的取消错误 */
function cancelled(message = 'canceled') {
  return { __CANCEL__: true, name: 'CanceledError', message };
}

/** 有响应体的服务端错误：data 为空时 normalizeApiError 落到各接口自己的兜底文案 */
function httpError(status: number, data: Record<string, unknown> = {}) {
  return { response: { status, data } };
}

function networkError() {
  return { code: 'ERR_NETWORK', message: 'Network Error' };
}

beforeEach(() => {
  axiosInst.get.mockReset();
  axiosInst.post.mockReset();
  axiosInst.delete.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('normalizeApiError —— 既有单测未覆盖的分支', () => {
  it('服务端只给 message 字段时也能透出', () => {
    expect(normalizeApiError(httpError(400, { message: '参数缺失' })).message).toBe('参数缺失');
  });

  it('error / message 都为空串时不算"有服务端文案"，按状态码兜底', () => {
    // 空串是 falsy，若写成 !== undefined 判断会把空提示渲染成空白
    expect(normalizeApiError(httpError(429, { error: '' })).message).toBe(
      '请求过于频繁，请稍后再试',
    );
  });

  it('传入 null / undefined / 非对象时不抛 TypeError（调用方 catch 里安全）', () => {
    expect(normalizeApiError(null).message).toContain('localhost:3001');
    expect(normalizeApiError(undefined, '兜底').message).toContain('localhost:3001');
    expect(normalizeApiError('boom').message).toContain('localhost:3001');
  });

  it('不传 fallback 时默认文案为"请求失败"', () => {
    expect(normalizeApiError(httpError(418)).message).toBe('请求失败');
  });

  it('服务端文案优先于状态码文案（5xx 也透出上游细节）', () => {
    expect(normalizeApiError(httpError(503, { error: '行情源限流' })).message).toBe('行情源限流');
  });
});

// === 全部 REST 封装：成功透传 + 失败兜底两条路径 ===

type ApiCase = {
  name: string;
  call: () => Promise<unknown>;
  method: 'get' | 'post' | 'delete';
  url: string;
  response: unknown;
  expected: unknown;
  fallback: string;
};

const CASES: ApiCase[] = [
  {
    name: 'getStockList',
    call: () => getStockList(),
    method: 'get',
    url: '/stocks',
    response: [{ code: '600519', name: '贵州茅台' }],
    expected: [{ code: '600519', name: '贵州茅台' }],
    fallback: '获取股票列表失败',
  },
  {
    name: 'searchStocks',
    call: () => searchStocks('茅台'),
    method: 'get',
    url: '/stocks/search',
    response: [{ code: '600519', name: '贵州茅台' }],
    expected: [{ code: '600519', name: '贵州茅台' }],
    fallback: '搜索失败',
  },
  {
    name: 'runQuantAnalysis',
    call: () => runQuantAnalysis({ strategy: { name: '双均线' } }),
    method: 'post',
    url: '/quant/analyze',
    response: { backtest: { totalReturn: 3 } },
    expected: { backtest: { totalReturn: 3 } },
    fallback: '量化分析失败',
  },
  {
    name: 'runBatchCompositeAlpha',
    call: () => runBatchCompositeAlpha({ stockCodes: ['600519'] }),
    method: 'post',
    url: '/quant/factor/composite/batch',
    response: { results: [] },
    expected: { results: [] },
    fallback: '批量组合 alpha 测算失败',
  },
  {
    name: 'runCrossSectionEvaluation',
    call: () => runCrossSectionEvaluation({ codes: ['600519'] }),
    method: 'post',
    url: '/quant/factor/cross-section',
    response: { stocksIncluded: ['600519'] },
    expected: { stocksIncluded: ['600519'] },
    fallback: '截面因子评估失败',
  },
  {
    name: 'compareStocks',
    call: () => compareStocks(['600519', '000001']),
    method: 'post',
    url: '/compare',
    response: { stocks: [{ stockCode: '600519' }], failures: [{ code: '000001', error: '超时' }] },
    expected: { stocks: [{ stockCode: '600519' }], failures: [{ code: '000001', error: '超时' }] },
    fallback: '对比分析失败',
  },
  {
    name: 'getWatchlist',
    call: () => getWatchlist(),
    method: 'get',
    url: '/watchlist',
    response: { codes: ['600519'] },
    expected: { codes: ['600519'] },
    fallback: '获取自选股失败',
  },
  {
    name: 'addToWatchlist',
    call: () => addToWatchlist('600519'),
    method: 'post',
    url: '/watchlist',
    response: { codes: ['600519'] },
    expected: { codes: ['600519'] },
    fallback: '添加自选股失败',
  },
  {
    name: 'removeFromWatchlist',
    call: () => removeFromWatchlist('600519'),
    method: 'delete',
    url: '/watchlist/600519',
    response: { codes: [] },
    expected: { codes: [] },
    fallback: '移除自选股失败',
  },
  {
    name: 'runWatchlistNewsBacktest',
    call: () => runWatchlistNewsBacktest(),
    method: 'post',
    url: '/watchlist/news-backtest',
    response: { generatedAt: '2026-01-01T00:00:00.000Z', items: [] },
    expected: { generatedAt: '2026-01-01T00:00:00.000Z', items: [] },
    fallback: '自选股批量回测失败',
  },
  {
    name: 'listDocuments',
    call: () => listDocuments(),
    method: 'get',
    url: '/documents',
    response: { count: 0, docs: [] },
    expected: { count: 0, docs: [] },
    fallback: '读取资料库失败',
  },
  {
    name: 'getCostReport',
    call: () => getCostReport(),
    method: 'get',
    url: '/cost',
    response: { totalCost: 0, callCount: 0, byModel: {} },
    expected: { totalCost: 0, callCount: 0, byModel: {} },
    fallback: '获取成本报告失败',
  },
  {
    name: 'resetCostReport',
    call: () => resetCostReport(),
    method: 'post',
    url: '/cost/reset',
    response: { ok: true },
    expected: { ok: true },
    fallback: '重置成本失败',
  },
  {
    name: 'stopAutonomous',
    call: () => stopAutonomous(),
    method: 'post',
    url: '/autonomous/stop',
    response: { stopped: true, lastAlerts: [] },
    expected: { stopped: true, lastAlerts: [] },
    fallback: '停止自动监控失败',
  },
  {
    name: 'getAutonomousStatus',
    call: () => getAutonomousStatus(),
    method: 'get',
    url: '/autonomous/status',
    response: { running: false },
    expected: { running: false },
    fallback: '获取监控状态失败',
  },
  {
    name: 'getPaperPortfolio',
    call: () => getPaperPortfolio(),
    method: 'get',
    url: '/paper/portfolio',
    response: { cash: 100000, positions: [] },
    expected: { cash: 100000, positions: [] },
    fallback: '读取模拟盘账户失败',
  },
  {
    name: 'placePaperOrder',
    call: () => placePaperOrder({ code: '600519', side: 'buy', shares: 100, price: 1600 }),
    method: 'post',
    url: '/paper/order',
    response: { order: { id: 'o1' } },
    expected: { order: { id: 'o1' } },
    fallback: '模拟下单失败',
  },
  {
    name: 'settlePaperDay',
    call: () => settlePaperDay({ date: '2026-01-05', closePrices: { '600519': 1650 } }),
    method: 'post',
    url: '/paper/settle',
    response: { date: '2026-01-05', cash: 90000, history: [] },
    expected: { date: '2026-01-05', cash: 90000, history: [] },
    fallback: '日终结算失败',
  },
  {
    name: 'getPaperStats',
    call: () => getPaperStats(),
    method: 'get',
    url: '/paper/stats',
    response: { totalReturn: 1.2 },
    expected: { totalReturn: 1.2 },
    fallback: '读取模拟盘统计失败',
  },
  {
    name: 'getFactorExperiments',
    call: () => getFactorExperiments(),
    method: 'get',
    url: '/quant/factor/experiments',
    response: { items: [], summary: { total: 0 } },
    expected: { items: [], summary: { total: 0 } },
    fallback: '实验台账读取失败',
  },
  {
    name: 'getResearchDigests',
    call: () => getResearchDigests(),
    method: 'get',
    url: '/quant/digests',
    response: { items: [] },
    expected: { items: [] },
    fallback: '研究简报读取失败',
  },
  {
    name: 'runResearchDigestNow',
    call: () => runResearchDigestNow(),
    method: 'post',
    url: '/quant/digests/run',
    response: { id: 'g1', notes: [] },
    expected: { id: 'g1', notes: [] },
    fallback: '研究简报生成失败',
  },
  {
    name: 'getQuantHealth',
    call: () => getQuantHealth(),
    method: 'get',
    url: '/quant/health',
    response: { ok: true, checks: [], degraded: [], checkedAt: '2026-01-01T00:00:00.000Z' },
    expected: { ok: true, checks: [], degraded: [], checkedAt: '2026-01-01T00:00:00.000Z' },
    fallback: '上游预检失败',
  },
  {
    name: 'getIntlFundamentals',
    call: () => getIntlFundamentals('AAPL', 'us'),
    method: 'get',
    url: '/intl/fundamentals',
    response: { code: 'AAPL', metrics: [] },
    expected: { code: 'AAPL', metrics: [] },
    fallback: '港美股数据获取失败',
  },
  {
    name: 'getIntlKlines',
    call: () => getIntlKlines({ code: 'AAPL' }),
    method: 'get',
    url: '/intl/klines',
    response: { code: 'AAPL', market: 'us', count: 1, klines: [] },
    expected: { code: 'AAPL', market: 'us', count: 1, klines: [] },
    fallback: '港美股 K 线获取失败',
  },
  {
    name: 'runValuationModelApi',
    call: () => runValuationModelApi({ code: '600519' }),
    method: 'post',
    url: '/quant/valuation/model',
    response: { model: 'two_stage_eps_dcf', code: '600519', fairValue: 1800 },
    expected: { model: 'two_stage_eps_dcf', code: '600519', fairValue: 1800 },
    fallback: '估值建模失败',
  },
  {
    name: 'fetchHistoryList',
    call: () => fetchHistoryList(),
    method: 'get',
    url: '/history',
    response: { items: [{ id: 'h1', stockCode: '600519' }] },
    expected: [{ id: 'h1', stockCode: '600519' }],
    fallback: '历史记录读取失败',
  },
  {
    name: 'fetchHistoryDetail',
    call: () => fetchHistoryDetail('h1'),
    method: 'get',
    url: '/history/h1',
    response: { id: 'h1', stockCode: '600519' },
    expected: { id: 'h1', stockCode: '600519' },
    fallback: '历史记录读取失败',
  },
  {
    name: 'deleteHistoryItem',
    call: () => deleteHistoryItem('h1'),
    method: 'delete',
    url: '/history/h1',
    response: undefined,
    expected: undefined,
    fallback: '历史记录删除失败',
  },
  {
    name: 'monitorWatchlist',
    call: () => monitorWatchlist(),
    method: 'post',
    url: '/watchlist/monitor',
    response: { generatedAt: '2026-01-01T00:00:00.000Z', alerts: [] },
    expected: { generatedAt: '2026-01-01T00:00:00.000Z', alerts: [] },
    fallback: '自选股监控失败',
  },
  {
    name: 'fetchWatchlistAlerts',
    call: () => fetchWatchlistAlerts(),
    method: 'get',
    url: '/watchlist/alerts',
    response: { generatedAt: null, alerts: [] },
    expected: { generatedAt: null, alerts: [] },
    fallback: '最近监控记录读取失败',
  },
];

describe('REST 封装 —— 成功时命中正确的端点并原样透传响应体', () => {
  it.each(CASES)('$name → $method $url', async (c) => {
    axiosInst[c.method].mockResolvedValue({ data: c.response });
    await expect(c.call()).resolves.toEqual(c.expected);
    expect(axiosInst[c.method]).toHaveBeenCalledTimes(1);
    expect(axiosInst[c.method].mock.calls[0][0]).toBe(c.url);
  });
});

describe('REST 封装 —— 失败时给出该接口专属的兜底文案（而不是笼统的"请求失败"）', () => {
  it.each(CASES)('$name 抛"$fallback"', async (c) => {
    axiosInst[c.method].mockRejectedValue(httpError(400));
    await expect(c.call()).rejects.toThrow(c.fallback);
  });
});

describe('REST 封装 —— 后端未启动时统一给出启动指引', () => {
  it('所有接口都不把 "Network Error" 原样抛给用户', async () => {
    axiosInst.get.mockRejectedValue(networkError());
    axiosInst.post.mockRejectedValue(networkError());
    axiosInst.delete.mockRejectedValue(networkError());
    for (const c of CASES) {
      await expect(c.call()).rejects.toThrow('无法连接后端服务（localhost:3001）');
    }
  });
});

describe('REST 封装 —— 取消时抛专用类型（调用方据此静默收尾，而非当失败渲染）', () => {
  const cancellable: [string, () => Promise<unknown>][] = [
    ['runQuantAnalysis', () => runQuantAnalysis({ strategy: {} })],
    ['runBatchCompositeAlpha', () => runBatchCompositeAlpha({ stockCodes: [] })],
    ['runCrossSectionEvaluation', () => runCrossSectionEvaluation({})],
    ['compareStocks', () => compareStocks(['600519'])],
    ['runWatchlistNewsBacktest', () => runWatchlistNewsBacktest()],
    ['monitorWatchlist', () => monitorWatchlist()],
  ];

  it.each(cancellable)('%s 抛 AnalysisCancelledError', async (_name, call) => {
    axiosInst.post.mockRejectedValue(cancelled());
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalysisCancelledError);
    expect((err as Error).name).toBe('AnalysisCancelledError');
  });

  it.each(cancellable)('%s 的非取消失败仍是普通 Error（不误判为取消）', async (_name, call) => {
    axiosInst.post.mockRejectedValue(httpError(400, { error: '服务端拒绝' }));
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AnalysisCancelledError);
    expect((err as Error).message).toBe('服务端拒绝');
  });

  it('AnalysisCancelledError 默认文案为"分析已取消"，可自定义', () => {
    expect(new AnalysisCancelledError().message).toBe('分析已取消');
    expect(new AnalysisCancelledError('截面评估已取消').message).toBe('截面评估已取消');
  });
});

describe('REST 封装 —— 请求契约（超时量级 / 参数 / signal 透传）', () => {
  it('按任务耗时量级给足超时（分析 60s、批量与对比 180s、大面板 600s）', async () => {
    axiosInst.post.mockResolvedValue({ data: {} });
    await analyzeStock('600519');
    await runQuantAnalysis({ strategy: {} });
    await runBatchCompositeAlpha({ stockCodes: [] });
    await runCrossSectionEvaluation({});
    await compareStocks(['600519']);
    const timeouts = axiosInst.post.mock.calls.map(
      (c) => (c[2] as { timeout?: number } | undefined)?.timeout,
    );
    // runQuantAnalysis 不单独设超时 → 继承实例默认 120s（见 create({ timeout: 120000 })）
    expect(timeouts).toEqual([60000, undefined, 180000, 600000, 180000]);
  });

  it('查询参数原样透传（搜索关键词 / 港美股代码与市场）', async () => {
    axiosInst.get.mockResolvedValue({ data: {} });
    await searchStocks('600519');
    expect(axiosInst.get.mock.calls[0][1]).toMatchObject({ params: { keyword: '600519' } });

    await getIntlFundamentals('AAPL', 'us');
    expect(axiosInst.get.mock.calls[1][1]).toMatchObject({
      params: { code: 'AAPL', market: 'us' },
    });
  });

  it('外部 AbortSignal 透传给 axios（长请求可被调用方中断）', async () => {
    axiosInst.post.mockResolvedValue({ data: {} });
    axiosInst.get.mockResolvedValue({ data: {} });
    const ac = new AbortController();
    await searchStocks('茅台', ac.signal);
    await compareStocks(['600519'], ac.signal);
    expect(axiosInst.get.mock.calls[0][1]).toMatchObject({ signal: ac.signal });
    expect(axiosInst.post.mock.calls[0][2]).toMatchObject({ signal: ac.signal });
  });

  it('runWatchlistNewsBacktest 不传 codes 时回退为空数组（后端按自选股全量跑）', async () => {
    axiosInst.post.mockResolvedValue({ data: {} });
    await runWatchlistNewsBacktest();
    expect(axiosInst.post.mock.calls[0][1]).toEqual({ codes: [] });
    await runWatchlistNewsBacktest(['600519']);
    expect(axiosInst.post.mock.calls[1][1]).toEqual({ codes: ['600519'] });
  });

  it('getFactorExperiments 不传参时以空对象作为 params', async () => {
    axiosInst.get.mockResolvedValue({ data: {} });
    await getFactorExperiments();
    expect(axiosInst.get.mock.calls[0][1]).toMatchObject({ params: {} });
    await getFactorExperiments({ kept: true, limit: 20 });
    expect(axiosInst.get.mock.calls[1][1]).toMatchObject({ params: { kept: true, limit: 20 } });
  });
});

describe('analyzeStock —— 单飞取消：新请求必须中断上一次', () => {
  it('取消产生的失败被翻成普通 Error（axios CanceledError 不外泄）', async () => {
    axiosInst.post.mockRejectedValue(cancelled());
    await expect(analyzeStock('600519')).rejects.toThrow('请求已取消');
  });

  it('连续调用时上一只的 signal 被 abort，当前这只保持未中断', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    axiosInst.post.mockImplementation(
      (_url: string, _body: unknown, cfg: { signal?: AbortSignal }) => {
        signals.push(cfg.signal);
        return new Promise(() => {});
      },
    );
    void analyzeStock('600519').catch(() => {});
    void analyzeStock('000001').catch(() => {});
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});

describe('analyzeStockStream —— 既有单测未覆盖的 URL 形态', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    url: string;
    closed = false;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
      FakeEventSource.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('resume: true 时带 &resume=1（服务端据此从断点续跑），默认不带', () => {
    analyzeStockStream('600519', () => {}, { resume: true });
    expect(FakeEventSource.instances[0].url).toBe('/api/analyze/stream?stockCode=600519&resume=1');

    analyzeStockStream('600519', () => {});
    expect(FakeEventSource.instances[1].url).toBe('/api/analyze/stream?stockCode=600519');
  });

  it('股票代码被 URL 编码（特殊字符不会破坏 query）', () => {
    analyzeStockStream('600519&x=1', () => {});
    expect(FakeEventSource.instances[0].url).toContain('stockCode=600519%26x%3D1');
  });
});

describe('getUniverseBoards —— in-flight 去重 + 5 分钟缓存（该端点有 30 req/min 限流）', () => {
  const boardsResponse = { data: { boards: [{ code: 'BK1036', name: '半导体' }] } };
  let clock = Date.parse('2026-03-02T01:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    clock += 10 * 60_000; // 每例向前走 10 分钟，确保不受上一例缓存影响
    vi.setSystemTime(new Date(clock));
  });

  it('同一时刻的并发调用共享一个 in-flight 请求', async () => {
    axiosInst.get.mockResolvedValue(boardsResponse);
    const [a, b, c] = await Promise.all([
      getUniverseBoards(),
      getUniverseBoards(),
      getUniverseBoards(),
    ]);
    expect(axiosInst.get).toHaveBeenCalledTimes(1);
    expect(a).toEqual(boardsResponse.data);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('TTL 内命中缓存不再请求，超过 5 分钟后重新请求', async () => {
    axiosInst.get.mockResolvedValue(boardsResponse);
    await getUniverseBoards();
    await getUniverseBoards();
    expect(axiosInst.get).toHaveBeenCalledTimes(1);

    clock += 4 * 60_000; // 4 分钟后仍在 TTL 内
    vi.setSystemTime(new Date(clock));
    await getUniverseBoards();
    expect(axiosInst.get).toHaveBeenCalledTimes(1);

    clock += 90_000; // 累计 5.5 分钟，已过期
    vi.setSystemTime(new Date(clock));
    await getUniverseBoards();
    expect(axiosInst.get).toHaveBeenCalledTimes(2);
  });

  it('失败不缓存：一次上游抖动不会让板块下拉在整个会话内永久不可用', async () => {
    axiosInst.get.mockRejectedValueOnce(httpError(400));
    await expect(getUniverseBoards()).rejects.toThrow('行业板块列表获取失败');

    axiosInst.get.mockResolvedValueOnce(boardsResponse);
    await expect(getUniverseBoards()).resolves.toEqual(boardsResponse.data);
    expect(axiosInst.get).toHaveBeenCalledTimes(2);
  });

  it('失败同样被翻成中文提示（网络不可达时给启动指引）', async () => {
    axiosInst.get.mockRejectedValueOnce(networkError());
    await expect(getUniverseBoards()).rejects.toThrow('无法连接后端服务（localhost:3001）');
  });
});

// === 流式对话：EventSource 用可控桩替换，手动触发 onmessage / onerror ===

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  emitRaw(data: string) {
    this.onmessage?.({ data });
  }
  fail() {
    this.onerror?.();
  }
}

describe('chatWithAgentStream —— 事件式 SSE 对话', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('sessionId 参与会话记忆：不传则不带该参数', () => {
    chatWithAgentStream('茅台怎么样', () => {});
    expect(FakeEventSource.instances[0].url).toContain('/api/chat/stream?');
    expect(FakeEventSource.instances[0].url).toContain(encodeURIComponent('茅台怎么样'));
    expect(FakeEventSource.instances[0].url).not.toContain('sessionId');

    chatWithAgentStream('继续', () => {}, { sessionId: 's-1' });
    expect(FakeEventSource.instances[1].url).toContain('sessionId=s-1');
  });

  it('进度事件逐个回调，done 事件回调后关闭连接', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('hi', (e) => events.push(e));
    const es = FakeEventSource.instances[0];
    es.emit({ phase: 'planning', message: '规划中' });
    es.emit({ phase: 'tool_calling', message: '调用工具', tools: ['quote'] });
    es.emit({ phase: 'done', message: '完成', response: { answer: '好', degraded: false } });
    expect(events.map((e) => e.phase)).toEqual(['planning', 'tool_calling', 'done']);
    expect(es.closed).toBe(true);
  });

  it('done 之后到来的事件被忽略（settled 后不重复回调）', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('hi', (e) => events.push(e));
    const es = FakeEventSource.instances[0];
    es.emit({ phase: 'done', message: '完成', response: { answer: '好', degraded: false } });
    es.emit({ phase: 'error', message: '迟到的错误' });
    es.fail();
    expect(events).toHaveLength(1);
  });

  it('服务端推 error 阶段时直接收尾', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('hi', (e) => events.push(e));
    FakeEventSource.instances[0].emit({ phase: 'error', message: '模型不可用' });
    expect(events).toEqual([{ phase: 'error', message: '模型不可用' }]);
  });

  it('单条事件 JSON 坏掉不影响后续事件（不让一次脏包毁掉整轮对话）', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('hi', (e) => events.push(e));
    const es = FakeEventSource.instances[0];
    es.emitRaw('{ 这不是 JSON');
    es.emit({ phase: 'retrieving', message: '检索中' });
    expect(events).toEqual([{ phase: 'retrieving', message: '检索中' }]);
  });

  it('连接中断 → 明确告知"对话未完成，请重试"', () => {
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('hi', (e) => events.push(e));
    FakeEventSource.instances[0].fail();
    expect(events).toEqual([{ phase: 'error', message: '连接中断，对话未完成，请重试' }]);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('首包看门狗：20 秒无任何事件即判定服务不可用（不静默挂起）', async () => {
    vi.useFakeTimers();
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('hi', (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(19_000);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('error');
    expect((events[0] as { message: string }).message).toContain('20 秒内未收到任何进度');
  });

  it('收到首包后看门狗解除（长回答不会被误判为断开）', async () => {
    vi.useFakeTimers();
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('hi', (e) => events.push(e));
    FakeEventSource.instances[0].emit({ phase: 'planning', message: '规划中' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('planning');
  });

  it('cancel() 关闭连接且不再回调（用户重问时静默收尾）', async () => {
    vi.useFakeTimers();
    const events: ChatStreamEvent[] = [];
    const { cancel } = chatWithAgentStream('hi', (e) => events.push(e));
    cancel();
    const es = FakeEventSource.instances[0];
    expect(es.closed).toBe(true);
    es.emit({ phase: 'planning', message: '迟到的进度' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toHaveLength(0);
  });
});

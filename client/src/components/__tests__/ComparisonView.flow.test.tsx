// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ComparisonView from '../ComparisonView';

/**
 * 股票对比「主流程」行为测试（补充册）：选择标的 → 提交 → 加载/计时 → 成功渲染对比表 →
 * 清空重选 → 整批失败 → 取消（静默收尾）。
 *
 * 既有的 `ComparisonView.partialSuccess.test.tsx`（部分成功/全部失败）保持原样未动；
 * 本文件补的是它没覆盖的交互路径，并且**不 mock StockSearchInput**——用真实搜索组件，
 * 因此工厂里必须导出它 import 的 searchStocks（漏一个就报 "No export is defined on the mock"）。
 *
 * 路径核对（本文件位于 client/src/components/__tests__/）：
 *   ../ComparisonView   → client/src/components/ComparisonView.tsx
 *   ../../api/client    → client/src/api/client.ts（compareStocks / AnalysisCancelledError / searchStocks）
 */

const api = vi.hoisted(() => {
  class AnalysisCancelledError extends Error {
    constructor(message = '分析已取消') {
      super(message);
      this.name = 'AnalysisCancelledError';
    }
  }
  return {
    compareStocks: vi.fn(),
    searchStocks: vi.fn(),
    AnalysisCancelledError,
  };
});

vi.mock('../../api/client', () => ({
  compareStocks: api.compareStocks,
  searchStocks: api.searchStocks,
  AnalysisCancelledError: api.AnalysisCancelledError,
}));

/** 一列完整的成功数据（对比表会读评分/财务/估值/专家观点，缺字段会显示「—」） */
function stock(code: string, name: string, over: Record<string, unknown> = {}) {
  return {
    stock_code: code,
    stock_name: name,
    industry: '白酒',
    core_summary: `${name}的核心摘要`,
    total_score: 85,
    rating: '优先跟踪',
    finance_metrics: {
      years: ['2023', '2024', '2025'],
      revenue: [100, 120, 140],
      netProfit: [30, 36, 42],
      grossMargin: [90, 91, 92],
      netMargin: [28, 29, 30],
      roe: [25, 26, 27],
    },
    valuation: { currentPrice: 1680.5, pe: 30.25, pb: 8.125, ps: 10, marketCap: 21000 },
    expert_opinions: [
      { expert: '专家甲', overallSentiment: 'bullish', confidence: 0.8 },
      { expert: '专家乙', overallSentiment: 'bullish', confidence: 0.6 },
    ],
    strengths: ['品牌力强', '现金流充沛', '分红稳定', '第四条不该出现'],
    risk_list: ['需求走弱', '估值偏高'],
    ...over,
  };
}

const MAOTAI = stock('600519', '贵州茅台');
const WULIANGYE = stock('000858', '五粮液', {
  total_score: 60,
  rating: '中性观察',
  core_summary: '五粮液的核心摘要',
  finance_metrics: {
    years: ['2023', '2024', '2025'],
    revenue: [80, 90, 100],
    netProfit: [20, 22, 24],
    grossMargin: [70, 72, 75],
    netMargin: [15, 18, 20],
    roe: [10, 12, 15.5],
  },
  valuation: { currentPrice: 128.3, pe: 12.4, pb: 3.05, ps: 4, marketCap: 9000 },
  expert_opinions: [{ expert: '专家丙', overallSentiment: 'bearish', confidence: 0.7 }],
  strengths: ['渠道改革'],
  risk_list: ['库存高企'],
});

/** 缺失财务/估值/观点的一列：用于验证「—」与「不参与最优最差比较」 */
const SPARSE = stock('000858', '五粮液', {
  total_score: 0,
  rating: '',
  core_summary: '',
  finance_metrics: undefined,
  valuation: undefined,
  expert_opinions: [],
  strengths: undefined,
  risk_list: undefined,
});

/** 永不 settle 的桩：用于观察加载态 */
function pending<T = unknown>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** 收到 abort 时以 AnalysisCancelledError 拒绝（与真实 client 的取消语义一致） */
function rejectOnAbort() {
  return (_codes: string[], signal?: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () =>
        reject(new api.AnalysisCancelledError('对比分析已取消')),
      );
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

function searchInput(): HTMLElement {
  return screen.getByLabelText('对比股票搜索');
}

/** 输入 6 位代码后回车：真实 StockSearchInput 的直加路径（离线也可用） */
function addByCode(code: string) {
  fireEvent.change(searchInput(), { target: { value: code } });
  fireEvent.keyDown(searchInput(), { key: 'Enter' });
}

function addTwo() {
  addByCode('600519');
  addByCode('000858');
}

function startButton(name: string | RegExp = /开始对比分析/) {
  return screen.getByRole('button', { name });
}

/** 某指标行 [指标名, 第一列, 第二列…] */
function rowCells(label: string): HTMLElement[] {
  const row = screen.getByRole('cell', { name: label }).closest('tr') as HTMLElement;
  return within(row).getAllByRole('cell');
}

beforeEach(() => {
  vi.resetAllMocks();
  api.searchStocks.mockResolvedValue([]);
  api.compareStocks.mockResolvedValue({ stocks: [MAOTAI, WULIANGYE] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ComparisonView 选择标的', () => {
  it('初始态：说明文案 + 三个空占位，按钮禁用提示「请至少添加 2 只股票」', () => {
    render(<ComparisonView />);

    expect(screen.getByText('股票对比')).toBeInTheDocument();
    expect(
      screen.getByText('添加 2–3 只股票，一键生成财务、估值、趋势的多维度横向对比报告'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '请至少添加 2 只股票' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '＋ 添加第 1 只' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '＋ 添加第 2 只' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '＋ 添加第 3 只' })).toBeInTheDocument();
  });

  it('点击空占位：把光标直接送进搜索框（不用用户自己再点一次）', () => {
    render(<ComparisonView />);

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加第 2 只' }));

    expect(searchInput()).toHaveFocus();
  });

  it('输入 6 位代码即加入：标签出现序号与代码，按钮文案随数量变化', () => {
    render(<ComparisonView />);

    addByCode('600519');
    expect(screen.getAllByText('600519').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('1')).toBeInTheDocument();
    // 不足 2 只：按钮仍是提示文案且不可点
    expect(screen.getByRole('button', { name: '请至少添加 2 只股票' })).toBeDisabled();
    // 空位按剩余数量重新编号：第 1 只的位置没了，还剩第 2、3 只
    expect(screen.getByRole('button', { name: '＋ 添加第 2 只' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '＋ 添加第 3 只' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '＋ 添加第 1 只' })).toBeNull();

    addByCode('000858');
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始对比分析（2/3）' })).toBeEnabled();
  });

  it('按名称搜索：从下拉选中后标签显示股票名称（真实防抖检索路径）', async () => {
    api.searchStocks.mockResolvedValue([{ code: '600519', name: '贵州茅台' }]);
    render(<ComparisonView />);

    fireEvent.change(searchInput(), { target: { value: '茅台' } });
    const option = await screen.findByRole('option', { name: /600519/ }, { timeout: 2000 });
    fireEvent.mouseDown(option);

    expect(await screen.findByText('贵州茅台')).toBeInTheDocument();
    expect(api.searchStocks).toHaveBeenCalledWith('茅台');
    // 选中后输入框清空，不会残留上一轮查询
    expect(searchInput()).toHaveValue('');
  });

  it('重复添加同一只：提示「该股票已添加」，数量不变', () => {
    render(<ComparisonView />);

    addByCode('600519');
    addByCode('600519');

    expect(screen.getByText('该股票已添加')).toBeInTheDocument();
    // 数量没变：仍只有 1 只，按钮还是「不足 2 只」的提示
    expect(screen.getByRole('button', { name: '请至少添加 2 只股票' })).toBeDisabled();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('最多 3 只：搜索框与空占位禁用，第 4 只不会被加入', () => {
    render(<ComparisonView />);
    addByCode('600519');
    addByCode('000858');
    addByCode('601398');

    expect(screen.getByRole('button', { name: '开始对比分析（3/3）' })).toBeEnabled();
    expect(searchInput()).toBeDisabled();
    expect(screen.queryByRole('button', { name: /添加第/ })).toBeNull();

    // 第 4 只：即便硬塞一次回车/输入，也不会多出一列
    fireEvent.change(searchInput(), { target: { value: '600036' } });
    fireEvent.keyDown(searchInput(), { key: 'Enter' });
    expect(screen.getByRole('button', { name: '开始对比分析（3/3）' })).toBeInTheDocument();
    expect(screen.queryByText('4')).toBeNull();
  });

  it('标签「×」可移除单只：数量与按钮文案同步回退', () => {
    render(<ComparisonView />);
    addByCode('600519');
    addByCode('000858');
    addByCode('601398');

    fireEvent.click(screen.getAllByRole('button', { name: '×' })[2]);

    expect(screen.queryByText('601398')).toBeNull();
    expect(screen.getByRole('button', { name: '开始对比分析（2/3）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '＋ 添加第 3 只' })).toBeInTheDocument();
  });
});

describe('ComparisonView 提交与加载', () => {
  it('点击对比：按钮变「分析中...」并禁用，出现「取消对比」与耗时提示', () => {
    api.compareStocks.mockReturnValue(pending());
    render(<ComparisonView />);
    addTwo();

    fireEvent.click(startButton('开始对比分析（2/3）'));

    expect(screen.getByRole('button', { name: /分析中\.\.\./ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消对比' })).toBeInTheDocument();
    expect(
      screen.getByText('正在逐只分析财务、估值与专家观点…（已耗时 0 秒）'),
    ).toBeInTheDocument();
    expect(api.compareStocks).toHaveBeenCalledWith(['600519', '000858'], expect.anything());
  });

  it('对比期间每秒刷新已耗时秒数（只有静态「分析中」无法判断是否卡住）', async () => {
    const d = deferred<unknown>();
    api.compareStocks.mockReturnValue(d.promise);
    render(<ComparisonView />);
    addTwo();
    vi.useFakeTimers();

    fireEvent.click(startButton('开始对比分析（2/3）'));
    expect(screen.getByText(/已耗时 0 秒/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/已耗时 3 秒/)).toBeInTheDocument();

    // 分析结束：计时停止，加载态与取消按钮一并收起
    vi.useRealTimers();
    d.resolve({ stocks: [MAOTAI, WULIANGYE] });
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消对比' })).toBeNull());
    expect(screen.queryByText(/已耗时/)).toBeNull();
  });

  it('对比途中卸载组件：中止在途请求，不留下悬挂连接', () => {
    api.compareStocks.mockImplementation(rejectOnAbort());
    const { unmount } = render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    const signal = api.compareStocks.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });
});

describe('ComparisonView 成功渲染对比表', () => {
  it('两只都成功：表头/指标格式化/最优最差着色/情绪标签/摘要卡', async () => {
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    expect(await screen.findByText('股票对比分析')).toBeInTheDocument();
    // 表头：名称 + 代码各一份；摘要卡里也各有一份名称
    expect(screen.getAllByText('贵州茅台')).toHaveLength(2);
    expect(screen.getAllByText('五粮液')).toHaveLength(2);
    expect(screen.getByText('600519')).toBeInTheDocument();

    // 综合评分：高分标红（cell-best），低分标绿（cell-worst）
    const score = rowCells('综合评分');
    expect(score[1]).toHaveTextContent('85/100');
    expect(score[1]).toHaveClass('cell-best');
    expect(score[2]).toHaveTextContent('60/100');
    expect(score[2]).toHaveClass('cell-worst');

    // 文本类指标不着色
    expect(rowCells('评级')[1]).toHaveTextContent('优先跟踪');
    expect(rowCells('评级')[1]).not.toHaveClass('cell-best');
    // 行业相同 → 谁都不是最优/最差
    expect(rowCells('行业')[1]).not.toHaveClass('cell-best');
    expect(rowCells('行业')[2]).not.toHaveClass('cell-best');

    // 价格/估值：越低越好 → 便宜的一列 cell-best
    const price = rowCells('当前价格');
    expect(price[1]).toHaveTextContent('¥1680.50');
    expect(price[1]).toHaveClass('cell-worst');
    expect(price[2]).toHaveTextContent('¥128.30');
    expect(price[2]).toHaveClass('cell-best');
    expect(rowCells('PE（市盈率）')[1]).toHaveTextContent('30.25');
    expect(rowCells('PB（市净率）')[1]).toHaveTextContent('8.13');
    // 市值 ≥1 万亿换算成「万亿」，否则「亿」
    expect(rowCells('市值（亿）')[1]).toHaveTextContent('2.10万亿');
    expect(rowCells('市值（亿）')[2]).toHaveTextContent('9000亿');

    // 财务比率取最近一年
    expect(rowCells('ROE（%）')[1]).toHaveTextContent('27.00%');
    expect(rowCells('ROE（%）')[2]).toHaveTextContent('15.50%');
    expect(rowCells('毛利率（%）')[1]).toHaveTextContent('92.00%');
    expect(rowCells('净利率（%）')[2]).toHaveTextContent('20.00%');

    // 专家情绪：多数决 → 中文标签 + 语义色
    const sentiment = rowCells('专家情绪');
    expect(within(sentiment[1]).getByText('偏多')).toHaveClass('sentiment-bullish');
    expect(within(sentiment[2]).getByText('偏空')).toHaveClass('sentiment-bearish');

    // 摘要卡：得分 + 优势/风险各最多 3 条
    const card = screen.getByText('85分').closest('.comparison-summary-card') as HTMLElement;
    expect(within(card).getByText('贵州茅台的核心摘要')).toBeInTheDocument();
    expect(within(card).getAllByRole('listitem')).toHaveLength(5); // 3 优势 + 2 风险
    expect(screen.queryByText('第四条不该出现')).toBeNull();
  });

  it('专家观点多空持平：显示「中性」，不硬偏向任何一边', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [
        stock('600519', '贵州茅台', {
          expert_opinions: [
            { expert: '甲', overallSentiment: 'bullish', confidence: 0.6 },
            { expert: '乙', overallSentiment: 'bearish', confidence: 0.6 },
          ],
        }),
        WULIANGYE,
      ],
    });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('股票对比分析');

    expect(within(rowCells('专家情绪')[1]).getByText('中性')).toHaveClass('sentiment-neutral');
  });

  it('上游给的是脏数据（非数字）：格式化成「—」，不让 NaN 出现在表里', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [
        stock('600519', '贵州茅台', {
          valuation: { currentPrice: 'N/A', pe: '--', pb: 'N/A', ps: 0, marketCap: 'N/A' },
        }),
        WULIANGYE,
      ],
    });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('股票对比分析');

    for (const label of ['当前价格', 'PE（市盈率）', 'PB（市净率）', '市值（亿）']) {
      expect(rowCells(label)[1]).toHaveTextContent('—');
    }
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('缺失财务/估值/观点：显示「—」且不参与最优/最差，合法 0 分照常显示', async () => {
    api.compareStocks.mockResolvedValue({ stocks: [MAOTAI, SPARSE] });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    await screen.findByText('股票对比分析');

    const score = rowCells('综合评分');
    expect(score[1]).toHaveTextContent('85/100');
    expect(score[1]).toHaveClass('cell-best');
    // 0 分是合法数值，照常显示，但不会被误标成「最差」（0 不参与比较）
    expect(score[2]).toHaveTextContent('0/100');
    expect(score[2]).not.toHaveClass('cell-worst');

    for (const label of ['当前价格', 'PE（市盈率）', 'PB（市净率）', '市值（亿）']) {
      expect(rowCells(label)[2]).toHaveTextContent('—');
      expect(rowCells(label)[2]).not.toHaveClass('cell-best');
    }
    for (const label of ['ROE（%）', '毛利率（%）', '净利率（%）', '专家情绪']) {
      expect(rowCells(label)[2]).toHaveTextContent('—');
    }
    // 缺失列只有「—」，没有 NaN / undefined
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });

  it('服务端多返回了未请求的代码：补在末尾，不丢数据', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [MAOTAI, WULIANGYE, stock('601398', '工商银行')],
    });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    await screen.findByText('股票对比分析');
    expect(screen.getAllByRole('columnheader')).toHaveLength(4); // 指标名 + 3 列
    // 多出来的那只进表头与摘要卡各一次，没有被丢掉
    expect(screen.getAllByText('工商银行')).toHaveLength(2);
    expect(screen.getByText('601398')).toBeInTheDocument();
  });

  it('「重新对比」：清空已选标的与结果，回到选择页', async () => {
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('股票对比分析');

    fireEvent.click(screen.getByRole('button', { name: '重新对比' }));

    expect(screen.getByText('股票对比')).toBeInTheDocument();
    expect(screen.queryByText('股票对比分析')).toBeNull();
    expect(screen.queryByText('600519')).toBeNull();
    expect(screen.getByRole('button', { name: '请至少添加 2 只股票' })).toBeDisabled();
  });
});

describe('ComparisonView 失败与取消', () => {
  it('整批失败：逐列标注原因，摘要卡说明未纳入本次对比', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [],
      failures: [
        { code: '600519', error: '停牌无行情数据' },
        { code: '000858', error: '上游数据源超时' },
      ],
    });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    await waitFor(() => expect(screen.getAllByText('分析失败')).toHaveLength(2));
    expect(screen.getByText('停牌无行情数据')).toBeInTheDocument();
    expect(screen.getByText('上游数据源超时')).toBeInTheDocument();
    // 整体提示（不是默默失败）
    expect(screen.getAllByText(/部分股票分析失败/).length).toBeGreaterThan(0);
    // 两张失败摘要卡都说明「未纳入对比、可用上方重试」
    expect(
      screen.getAllByText(/该股未纳入本次对比，可用上方「重试这一只」单独重跑。/),
    ).toHaveLength(2);
    // 失败列不参与最优/最差，单元格是「—」
    expect(rowCells('综合评分')[1]).toHaveTextContent('—');
  });

  it('提交被拒（网络中断）：停在选择页给中文横幅，未渲染任何表格', async () => {
    api.compareStocks.mockRejectedValueOnce(new Error('无法连接后端服务（localhost:3001）'));
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    const banner = await screen.findByText('无法连接后端服务（localhost:3001）');
    expect(banner).toHaveClass('comparison-error');
    expect(screen.getByText('股票对比')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(startButton('开始对比分析（2/3）')).toBeEnabled();
  });

  it('失败后再次提交成功：错误横幅被清掉', async () => {
    api.compareStocks
      .mockRejectedValueOnce(new Error('对比分析失败：上游超时'))
      .mockResolvedValueOnce({ stocks: [MAOTAI, WULIANGYE] });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('对比分析失败：上游超时');

    fireEvent.click(startButton('开始对比分析（2/3）'));

    expect(await screen.findByText('股票对比分析')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.comparison-error')).toBeNull());
  });

  it('服务端返回空结果（既无 stocks 也无 failures）：提示「对比分析失败」而不是空白页', async () => {
    api.compareStocks.mockResolvedValue({});
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    expect(await screen.findByText('对比分析失败')).toBeInTheDocument();
    expect(screen.getByText('股票对比')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('后端抛出非 Error 的拒绝：回落到「对比分析失败」兜底文案', async () => {
    api.compareStocks.mockRejectedValue('boom');
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    expect(await screen.findByText('对比分析失败')).toBeInTheDocument();
  });

  it('取消对比：静默收尾——只收起加载态，绝不渲染失败横幅', async () => {
    api.compareStocks.mockImplementation(rejectOnAbort());
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));

    const signal = api.compareStocks.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '取消对比' }));

    // 在途请求被真正中止（不是只把界面藏起来）
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消对比' })).toBeNull());
    // AnalysisCancelledError 走静默分支：没有失败横幅、也没有错误文案
    expect(document.querySelector('.comparison-error')).toBeNull();
    expect(screen.queryByText(/取消/)).toBeNull();
    // 已选标的保留，用户可以直接再来一次
    expect(startButton('开始对比分析（2/3）')).toBeEnabled();
    expect(searchInput()).toBeEnabled();
  });

  it('取消后可以再次发起对比并正常拿到结果', async () => {
    api.compareStocks
      .mockImplementationOnce(rejectOnAbort())
      .mockResolvedValueOnce({ stocks: [MAOTAI, WULIANGYE] });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    fireEvent.click(screen.getByRole('button', { name: '取消对比' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消对比' })).toBeNull());

    fireEvent.click(startButton('开始对比分析（2/3）'));

    expect(await screen.findByText('股票对比分析')).toBeInTheDocument();
    expect(screen.queryByText(/分析失败/)).toBeNull();
  });
});

describe('ComparisonView 单只重试', () => {
  function partial() {
    return {
      stocks: [MAOTAI],
      failures: [{ code: '000858', error: '上游数据超时' }],
    };
  }

  it('重试成功：失败列就地替换为成功列，整体提示同步清除', async () => {
    api.compareStocks
      .mockResolvedValueOnce(partial())
      .mockResolvedValueOnce({ stocks: [stock('000858', '五粮液')] });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('分析失败');

    fireEvent.click(screen.getByRole('button', { name: '重试这一只' }));

    await waitFor(() => expect(screen.queryByText('分析失败')).toBeNull());
    // 表头与摘要卡各一处，列已就地变成成功列
    expect(screen.getAllByText('五粮液')).toHaveLength(2);
    expect(document.querySelector('.comparison-error')).toBeNull();
    // 接口要求一次 2-3 只：重试时带上同批一只已成功的股票凑数，并接上与主路径一致的 AbortSignal
    const retryArgs = api.compareStocks.mock.calls.at(-1) as unknown[];
    expect(retryArgs[0]).toEqual(['000858', '600519']);
    expect(retryArgs[1]).toBeInstanceOf(AbortSignal);
  });

  it('重试仍失败：列保留失败并换成新原因，重试期间按钮禁用且文案变「重试中...」', async () => {
    const d = deferred<unknown>();
    api.compareStocks.mockResolvedValueOnce(partial()).mockReturnValueOnce(d.promise);
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('分析失败');

    fireEvent.click(screen.getByRole('button', { name: '重试这一只' }));

    expect(await screen.findByRole('button', { name: '重试中...' })).toBeDisabled();

    d.resolve({ stocks: [], failures: [{ code: '000858', error: '仍无行情数据' }] });

    expect(await screen.findByText('「000858」重试失败：仍无行情数据')).toBeInTheDocument();
    expect(screen.getByText('分析失败')).toBeInTheDocument();
    expect(screen.getByText('仍无行情数据')).toBeInTheDocument();
  });

  it('重试请求本身失败：给出失败原因，失败列原地保留', async () => {
    api.compareStocks
      .mockResolvedValueOnce(partial())
      .mockRejectedValueOnce(new Error('重试请求超时，请稍后再试'));
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('分析失败');

    fireEvent.click(screen.getByRole('button', { name: '重试这一只' }));

    expect(await screen.findByText('重试请求超时，请稍后再试')).toBeInTheDocument();
    expect(screen.getByText('分析失败')).toBeInTheDocument();
    expect(screen.getByText('上游数据超时')).toBeInTheDocument();
  });

  it('重试途中被取消（AnalysisCancelledError）：同样静默收尾，不新增错误提示', async () => {
    api.compareStocks
      .mockResolvedValueOnce(partial())
      .mockRejectedValueOnce(new api.AnalysisCancelledError('对比分析已取消'));
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('分析失败');

    fireEvent.click(screen.getByRole('button', { name: '重试这一只' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: '重试中...' })).toBeNull());
    // 取消不算失败：不写错误横幅，失败列保持原样
    expect(document.querySelector('.comparison-error')).toBeNull();
    expect(screen.queryByText(/对比分析已取消/)).toBeNull();
    expect(screen.getByText('上游数据超时')).toBeInTheDocument();
  });

  it('两列全失败时「重试这一只」不可用：按钮禁用 + 就地写明原因，不留点了没反应的死按钮', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [],
      failures: [
        { code: '600519', error: '停牌无行情数据' },
        { code: '000858', error: '上游数据源超时' },
      ],
    });
    render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await waitFor(() => expect(screen.getAllByText('分析失败')).toHaveLength(2));

    const callsBefore = api.compareStocks.mock.calls.length;
    const retries = screen.getAllByRole('button', { name: '重试这一只' });
    expect(retries).toHaveLength(2);
    // 没有可凑数的成功伙伴 → 禁用而不是"可点但静默 return"
    for (const btn of retries) {
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', expect.stringContaining('需至少一只成功结果才能重试'));
    }
    // 原因就地写明（不只藏在 title 里），用户知道为什么点不了
    expect(screen.getAllByText(/需至少一只成功结果才能重试/).length).toBeGreaterThanOrEqual(2);

    // 禁用态下即便硬点也不会有请求、也不该悄悄什么都不做
    fireEvent.click(retries[0]);
    await act(async () => {});
    expect(api.compareStocks.mock.calls.length).toBe(callsBefore);
  });

  it('单只重试带 AbortSignal：重试途中卸载会中止这个分钟级请求', async () => {
    api.compareStocks
      .mockResolvedValueOnce(partial())
      .mockImplementationOnce(rejectOnAbort() as never);
    const { unmount } = render(<ComparisonView />);
    addTwo();
    fireEvent.click(startButton('开始对比分析（2/3）'));
    await screen.findByText('分析失败');

    fireEvent.click(screen.getByRole('button', { name: '重试这一只' }));
    await waitFor(() => expect(api.compareStocks).toHaveBeenCalledTimes(2));

    const retrySignal = api.compareStocks.mock.calls[1][1] as AbortSignal;
    // 主对比路径有 abortRef，重试此前漏传 → 分钟级请求无法取消、卸载也不中止
    expect(retrySignal).toBeDefined();
    expect(retrySignal.aborted).toBe(false);

    unmount();

    expect(retrySignal.aborted).toBe(true);
  });
});

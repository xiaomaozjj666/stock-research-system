// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import StockSelector from '../StockSelector';

const apiMocks = vi.hoisted(() => ({ searchStocks: vi.fn(), getStockList: vi.fn() }));
vi.mock('../../api/client', () => ({
  searchStocks: apiMocks.searchStocks,
  getStockList: apiMocks.getStockList,
}));

const MT = { code: '600519', name: '贵州茅台' };
const PAYH = { code: '000001', name: '平安银行' };
const HISTORY_KEY = 'stock_search_history';

const input = () => screen.getByRole('combobox');
const options = () => screen.queryAllByRole('option');
const analyzeBtn = () => screen.getByRole('button', { name: /开始分析|分析中/ });

/** 输入并等待防抖检索真正发出 */
async function typeAndWait(value: string) {
  fireEvent.change(input(), { target: { value } });
  await waitFor(() => expect(apiMocks.searchStocks).toHaveBeenCalled(), { timeout: 2000 });
}

beforeEach(() => {
  apiMocks.searchStocks.mockReset();
  apiMocks.getStockList.mockReset();
  apiMocks.searchStocks.mockResolvedValue([MT]);
  apiMocks.getStockList.mockResolvedValue([MT, PAYH]);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StockSelector —— 热门股票加载', () => {
  it('挂载后展示热门股票（最多 10 个）', async () => {
    apiMocks.getStockList.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({ code: `60000${i}`, name: `票${i}` })),
    );
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /票\d/ })).toHaveLength(10));
  });

  it('股票列表为空时回退到默认标的（下拉不至于空着）', async () => {
    apiMocks.getStockList.mockResolvedValue([]);
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    expect(await screen.findByRole('button', { name: '贵州茅台' })).toBeInTheDocument();
  });

  it('股票列表接口失败时同样回退，不显示错误', async () => {
    apiMocks.getStockList.mockRejectedValue(new Error('down'));
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    expect(await screen.findByRole('button', { name: '贵州茅台' })).toBeInTheDocument();
    expect(screen.queryByText(/失败/)).toBeNull();
  });

  it('点击热门股票标签即选中（写入输入框与可分析代码）', async () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '平安银行' }));
    expect(input()).toHaveValue('平安银行');
    expect(input()).toHaveAttribute('data-stock-code', '000001');
    expect(analyzeBtn()).toBeEnabled();
  });
});

describe('StockSelector —— 搜索历史', () => {
  it('历史从 localStorage 读取，聚焦空输入框时展示', () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([{ code: '600519', name: '贵州茅台', timestamp: 1 }]),
    );
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    expect(screen.getByText('搜索历史')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /贵州茅台/ })).toBeInTheDocument();
  });

  it('localStorage 内容损坏时按空历史处理，不抛异常', () => {
    localStorage.setItem(HISTORY_KEY, '{ 这不是 JSON');
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    expect(screen.queryByText('搜索历史')).toBeNull();
    expect(input()).toBeInTheDocument();
  });

  it('选中股票后写入历史（最新在前，重复项去重）', async () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '贵州茅台' }));
    let stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as { code: string }[];
    expect(stored.map((h) => h.code)).toEqual(['600519']);

    fireEvent.click(screen.getByRole('button', { name: '平安银行' }));
    fireEvent.click(screen.getByRole('button', { name: '贵州茅台' }));
    stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as { code: string }[];
    expect(stored.map((h) => h.code)).toEqual(['600519', '000001']);
  });

  it('历史最多保留 20 条（超出的旧记录被丢弃）', async () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({ code: `00000${i}`, name: `旧${i}`, timestamp: i })),
      ),
    );
    apiMocks.getStockList.mockResolvedValue([{ code: '999999', name: '新标的' }]);
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '新标的' }));
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown[];
    expect(stored).toHaveLength(20);
    expect(stored[0]).toMatchObject({ code: '999999' });
  });

  it('删除单条历史只移除该项（不影响其它记录）', () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([
        { code: '600519', name: '贵州茅台', timestamp: 2 },
        { code: '000001', name: '平安银行', timestamp: 1 },
      ]),
    );
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    fireEvent.click(screen.getAllByTitle('删除')[0]);
    expect(screen.queryByRole('option', { name: /贵州茅台/ })).toBeNull();
    expect(screen.getByRole('option', { name: /平安银行/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')).toHaveLength(1);
  });

  it('清空全部后下拉关闭且 localStorage 被清掉', () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([{ code: '600519', name: '贵州茅台', timestamp: 1 }]),
    );
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    fireEvent.click(screen.getByRole('button', { name: '清空全部' }));
    expect(screen.queryByText('搜索历史')).toBeNull();
    expect(localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('点击历史项即选中该标的', () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([{ code: '000001', name: '平安银行', timestamp: 1 }]),
    );
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    fireEvent.click(screen.getByRole('option', { name: /平安银行/ }));
    expect(input()).toHaveAttribute('data-stock-code', '000001');
    expect(screen.queryByText('搜索历史')).toBeNull();
  });
});

describe('StockSelector —— 检索与候选', () => {
  it('输入代码后检索并在下拉展示候选', async () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await typeAndWait('600519');
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(screen.getByRole('option', { name: /600519/ })).toBeInTheDocument();
  });

  it('检索中先给出加载提示（不显示空白下拉）', async () => {
    apiMocks.searchStocks.mockReturnValue(new Promise(() => {}));
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.change(input(), { target: { value: '茅台' } });
    expect(await screen.findByText('正在检索「茅台」…')).toBeInTheDocument();
  });

  it('点击候选即选中，并清空下拉与高亮', async () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await typeAndWait('茅台');
    const option = await screen.findByRole('option');
    fireEvent.click(option);
    expect(input()).toHaveValue('贵州茅台');
    expect(input()).toHaveAttribute('data-stock-code', '600519');
    expect(options()).toHaveLength(0);
  });

  it('名称搜不到时给出可行动的三种建议（含改用 6 位代码）', async () => {
    apiMocks.searchStocks.mockResolvedValue([]);
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await typeAndWait('查无此股');
    expect(await screen.findByText('未找到「查无此股」')).toBeInTheDocument();
    expect(screen.getByText(/6 位股票代码/)).toBeInTheDocument();
  });

  it('检索失败但输入是 6 位代码：回退为按代码直选（离线可用）', async () => {
    apiMocks.searchStocks.mockRejectedValue(new Error('down'));
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await typeAndWait('600519');
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.click(options()[0]);
    expect(input()).toHaveAttribute('data-stock-code', '600519');
  });

  it('检索失败且输入不是代码：不给出假候选，只显示空态', async () => {
    apiMocks.searchStocks.mockRejectedValue(new Error('down'));
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await typeAndWait('贵州茅台');
    expect(await screen.findByText('未找到「贵州茅台」')).toBeInTheDocument();
    expect(options()).toHaveLength(0);
  });

  it('清空输入后收起候选、切回搜索历史，并清掉已选代码', async () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '贵州茅台' }));
    expect(analyzeBtn()).toBeEnabled();

    fireEvent.change(input(), { target: { value: '' } });
    // 候选下拉收起，改为展示搜索历史（刚选过的标的已入历史）
    expect(document.querySelector('.stock-search-item')).toBeNull();
    expect(screen.getByText('搜索历史')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /贵州茅台/ })).toBeInTheDocument();
    expect(input()).toHaveAttribute('data-stock-code', '');
    expect(analyzeBtn()).toBeDisabled();
  });

  it('点击组件外部收起下拉与历史', () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([{ code: '600519', name: '贵州茅台', timestamp: 1 }]),
    );
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    expect(screen.getByText('搜索历史')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('StockSelector —— 键盘操作', () => {
  beforeEach(() => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([
        { code: '600519', name: '贵州茅台', timestamp: 2 },
        { code: '000001', name: '平安银行', timestamp: 1 },
      ]),
    );
  });

  it('历史视图下上下键在历史项之间循环高亮', () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Escape 收起下拉与历史', () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('回车选中高亮的历史项', () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input()).toHaveAttribute('data-stock-code', '600519');
  });

  it('直接输入 6 位代码后回车即选中（优先用带名称的检索结果）', async () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await typeAndWait('600519');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input()).toHaveAttribute('data-stock-code', '600519');
    expect(input()).toHaveValue('贵州茅台');
  });

  it('Ctrl+Enter 不在这里顺手选中（留给全局"直接分析"快捷键）', async () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await typeAndWait('600519');
    fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true });
    expect(input()).toHaveAttribute('data-stock-code', '600519'); // 仍是键入代码，而非选中结果
    expect(input()).toHaveValue('600519');
  });

  it('无高亮且输入非代码时，回车选中第一个检索结果', async () => {
    apiMocks.searchStocks.mockResolvedValue([MT, PAYH]);
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await typeAndWait('银行');
    await waitFor(() => expect(options()).toHaveLength(2));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input()).toHaveAttribute('data-stock-code', '600519');
  });
});

describe('StockSelector —— 开始分析', () => {
  it('未选标的时按钮禁用并说明原因', async () => {
    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    await screen.findByRole('button', { name: '贵州茅台' });
    expect(analyzeBtn()).toBeDisabled();
    expect(analyzeBtn()).toHaveAttribute('title', '请先选择或输入 6 位股票代码');
  });

  it('直接输入 6 位代码即可分析（无需点下拉）', async () => {
    const onAnalyze = vi.fn();
    render(<StockSelector onAnalyze={onAnalyze} loading={false} />);
    fireEvent.change(input(), { target: { value: '600519' } });
    expect(analyzeBtn()).toBeEnabled();
    fireEvent.click(analyzeBtn());
    expect(onAnalyze).toHaveBeenCalledWith('600519');
  });

  it('分析中禁用按钮并显示进度文案，重复点击不再触发', async () => {
    const onAnalyze = vi.fn();
    render(<StockSelector onAnalyze={onAnalyze} loading />);
    fireEvent.click(analyzeBtn());
    expect(onAnalyze).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '开始分析' })).toBeNull();
  });

  it('选中的名称含空白时按 trim 判定，不误判为可分析', async () => {
    const onAnalyze = vi.fn();
    render(<StockSelector onAnalyze={onAnalyze} loading={false} />);
    fireEvent.change(input(), { target: { value: '   ' } });
    expect(analyzeBtn()).toBeDisabled();
  });
});

describe('StockSelector —— 请求竞态', () => {
  it('先发的慢请求不会覆盖后发的快请求结果（序号守卫）', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    apiMocks.searchStocks
      .mockReturnValueOnce(
        new Promise((res) => {
          resolveFirst = res;
        }),
      )
      .mockResolvedValueOnce([PAYH]);

    render(<StockSelector onAnalyze={vi.fn()} loading={false} />);
    fireEvent.change(input(), { target: { value: '茅台' } });
    await waitFor(() => expect(apiMocks.searchStocks).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.change(input(), { target: { value: '平安' } });
    await waitFor(() => expect(apiMocks.searchStocks).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /平安银行/ })).toBeInTheDocument(),
    );

    await act(async () => {
      resolveFirst([MT]);
    });
    expect(screen.queryByRole('option', { name: /贵州茅台/ })).toBeNull();
  });
});

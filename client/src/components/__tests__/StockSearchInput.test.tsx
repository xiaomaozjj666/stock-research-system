// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import StockSearchInput from '../StockSearchInput';

const apiMocks = vi.hoisted(() => ({ searchStocks: vi.fn() }));
vi.mock('../../api/client', () => ({ searchStocks: apiMocks.searchStocks }));

const MT = { code: '600519', name: '贵州茅台' };
const PAYH = { code: '000001', name: '平安银行' };

/** 输入并等待防抖（250ms）真正发出请求 */
async function typeAndSearch(value: string) {
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value } });
  await waitFor(() => expect(apiMocks.searchStocks).toHaveBeenCalled(), { timeout: 2000 });
  return input;
}

function options() {
  return screen.queryAllByRole('option');
}

beforeEach(() => {
  apiMocks.searchStocks.mockReset();
  apiMocks.searchStocks.mockResolvedValue([MT]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StockSearchInput —— 输入与防抖检索', () => {
  it('输入后不立即请求（250ms 防抖），到点才发一次', async () => {
    render(<StockSearchInput onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '茅台' } });
    expect(apiMocks.searchStocks).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMocks.searchStocks).toHaveBeenCalledWith('茅台'), {
      timeout: 2000,
    });
    expect(apiMocks.searchStocks).toHaveBeenCalledTimes(1);
  });

  it('连续输入只按最后一次检索（前一次的定时器被清掉）', async () => {
    render(<StockSearchInput onSelect={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '茅' } });
    fireEvent.change(input, { target: { value: '茅台' } });
    fireEvent.change(input, { target: { value: '贵州茅台' } });
    await waitFor(() => expect(apiMocks.searchStocks).toHaveBeenCalledWith('贵州茅台'), {
      timeout: 2000,
    });
    expect(apiMocks.searchStocks).toHaveBeenCalledTimes(1);
  });

  it('检索过程中提示"正在检索"，而不是看起来毫无反应', async () => {
    apiMocks.searchStocks.mockReturnValue(new Promise(() => {}));
    render(<StockSearchInput onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '茅台' } });
    expect(await screen.findByText('正在检索「茅台」…')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
  });

  it('清空输入即关闭下拉并作废在途请求（旧结果不会迟到弹出）', async () => {
    let resolveSearch: (v: unknown) => void = () => {};
    apiMocks.searchStocks.mockReturnValue(
      new Promise((res) => {
        resolveSearch = res;
      }),
    );
    render(<StockSearchInput onSelect={vi.fn()} />);
    const input = await typeAndSearch('茅台');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByRole('listbox')).toBeNull();

    await act(async () => {
      resolveSearch([MT]);
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('StockSearchInput —— 候选下拉与选中', () => {
  it('候选同时展示代码与名称', async () => {
    apiMocks.searchStocks.mockResolvedValue([MT, PAYH]);
    render(<StockSearchInput onSelect={vi.fn()} />);
    await typeAndSearch('6');
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(screen.getByText('600519')).toBeInTheDocument();
    expect(screen.getByText('贵州茅台')).toBeInTheDocument();
  });

  it('点击候选项后回调选中结果并清空输入框（下拉收起）', async () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    await typeAndSearch('茅台');
    const option = await screen.findByRole('option');
    fireEvent.mouseDown(option);
    expect(onSelect).toHaveBeenCalledWith('600519', '贵州茅台');
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('候选数量受 limit 限制', async () => {
    apiMocks.searchStocks.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ code: `60000${i}`, name: `票${i}` })),
    );
    render(<StockSearchInput onSelect={vi.fn()} limit={3} />);
    await typeAndSearch('票');
    await waitFor(() => expect(options()).toHaveLength(3));
  });

  it('搜索无结果时提示确认名称或改用 6 位代码', async () => {
    apiMocks.searchStocks.mockResolvedValue([]);
    render(<StockSearchInput onSelect={vi.fn()} />);
    await typeAndSearch('不存在的公司');
    expect(
      await screen.findByText('未找到「不存在的公司」对应的股票，请确认名称或改用 6 位代码'),
    ).toBeInTheDocument();
  });

  it('服务端返回非数组时按"无结果"处理，不抛异常', async () => {
    apiMocks.searchStocks.mockResolvedValue(null);
    render(<StockSearchInput onSelect={vi.fn()} />);
    await typeAndSearch('茅台');
    expect(await screen.findByText(/未找到「茅台」对应的股票/)).toBeInTheDocument();
  });
});

describe('StockSearchInput —— 搜索不可用时的降级（离线也能用）', () => {
  it('名称检索失败：提示改用 6 位代码，且提示不会被下拉隐藏', async () => {
    apiMocks.searchStocks.mockRejectedValue(new Error('down'));
    render(<StockSearchInput onSelect={vi.fn()} />);
    await typeAndSearch('茅台');
    expect(await screen.findByText('搜索服务暂不可用，请改用 6 位股票代码')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('6 位代码检索失败：不打扰用户（不弹提示），回车仍可直接添加', async () => {
    apiMocks.searchStocks.mockRejectedValue(new Error('down'));
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = await typeAndSearch('600519');
    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false'),
    );
    expect(screen.queryByText(/搜索服务暂不可用/)).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('600519', '');
  });

  it('allowDirectCode: false 时 6 位代码不直加（用于必须校验名称的场景）', async () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} allowDirectCode={false} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '600519' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('StockSearchInput —— 键盘操作', () => {
  it('上下键循环高亮，并同步 aria-selected', async () => {
    apiMocks.searchStocks.mockResolvedValue([MT, PAYH]);
    render(<StockSearchInput onSelect={vi.fn()} />);
    const input = await typeAndSearch('6');
    await waitFor(() => expect(options()).toHaveLength(2));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // 回卷到第一项
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // 从第一项上跳到末项
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('回车提交高亮项', async () => {
    apiMocks.searchStocks.mockResolvedValue([MT, PAYH]);
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = await typeAndSearch('6');
    await waitFor(() => expect(options()).toHaveLength(2));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('600519', '贵州茅台');
  });

  it('Escape 关闭下拉但不丢输入内容', async () => {
    render(<StockSearchInput onSelect={vi.fn()} />);
    const input = await typeAndSearch('茅台');
    await screen.findByRole('option');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('茅台');
  });

  it('唯一命中时回车直接选中（不用先点下拉）', async () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = await typeAndSearch('茅台');
    await screen.findByRole('option');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('600519', '贵州茅台');
  });

  it('多命中时回车不臆测第一支，而是要求在下拉中选择', async () => {
    apiMocks.searchStocks.mockResolvedValue([MT, PAYH]);
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = await typeAndSearch('银行');
    await waitFor(() => expect(options()).toHaveLength(2));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(await screen.findByText('「银行」匹配到多支股票，请在下拉中选择')).toBeInTheDocument();
  });

  it('无候选但输入是 6 位代码时，回车直加（离线可用）', async () => {
    apiMocks.searchStocks.mockResolvedValue([]);
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = await typeAndSearch('600519');
    await screen.findByText(/未找到「600519」对应的股票/);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('600519', '');
  });

  it('输入 6 位代码后在防抖窗口内回车：迟到的检索不会把下拉弹回来', async () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '600519' } });
    // 250ms 防抖还没到点就回车提交
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('600519', '');

    await new Promise((r) => setTimeout(r, 350)); // 越过防抖窗口
    expect(apiMocks.searchStocks).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('输入 6 位代码后在防抖窗口内失焦：同样撤销在途检索', async () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '600519' } });
    fireEvent.blur(input);
    expect(onSelect).toHaveBeenCalledWith('600519', '');

    await new Promise((r) => setTimeout(r, 350));
    expect(apiMocks.searchStocks).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('名称查询：回车触发一次检索，唯一命中即选中', async () => {
    apiMocks.searchStocks.mockResolvedValue([MT]);
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '贵州茅台' } });
    // 防抖尚未触发，此时回车走"名称查询"分支
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('600519', '贵州茅台'));
  });

  it('名称查询无命中：提示未找到', async () => {
    apiMocks.searchStocks.mockResolvedValue([]);
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '查无此股' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText(/未找到「查无此股」对应的股票/)).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('名称查询多命中：提示在下拉中选择，不选中', async () => {
    apiMocks.searchStocks.mockResolvedValue([MT, PAYH]);
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '银行' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('「银行」匹配到多支股票，请在下拉中选择')).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('名称查询失败：提示改用 6 位代码', async () => {
    apiMocks.searchStocks.mockRejectedValue(new Error('down'));
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '贵州茅台' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('搜索服务暂不可用，请改用 6 位股票代码')).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('StockSearchInput —— 失焦自动提交（避免"显示已选、状态为空"）', () => {
  it('输入完整 6 位代码后失焦即提交', async () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '600519' } });
    fireEvent.blur(input);
    expect(onSelect).toHaveBeenCalledWith('600519', '');
  });

  it('唯一命中时失焦提交带名称', async () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = await typeAndSearch('茅台');
    await screen.findByRole('option');
    fireEvent.blur(input);
    expect(onSelect).toHaveBeenCalledWith('600519', '贵州茅台');
  });

  it('多命中时失焦不臆测（保持"请在下拉中选择"）', async () => {
    apiMocks.searchStocks.mockResolvedValue([MT, PAYH]);
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = await typeAndSearch('银行');
    await waitFor(() => expect(options()).toHaveLength(2));
    fireEvent.blur(input);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('空输入失焦不提交', () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={vi.fn()} />);
    fireEvent.blur(screen.getByRole('combobox'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('纯空白输入失焦不提交（trim 后为空）', () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('StockSearchInput —— 外点击 / 操作按钮 / 无障碍', () => {
  it('点击组件外部关闭下拉', async () => {
    render(<StockSearchInput onSelect={vi.fn()} />);
    await typeAndSearch('茅台');
    await screen.findByRole('option');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('传 actionLabel 时渲染操作按钮，点击等价于回车', async () => {
    const onSelect = vi.fn();
    render(<StockSearchInput onSelect={onSelect} actionLabel="添加" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '600519' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(onSelect).toHaveBeenCalledWith('600519', '');
  });

  it('不传 actionLabel 时不渲染按钮（由页面自行触发）', () => {
    render(<StockSearchInput onSelect={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('disabled 时输入框与按钮都不可用', () => {
    render(<StockSearchInput onSelect={vi.fn()} actionLabel="添加" disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
  });

  it('无障碍属性齐全：combobox + aria-controls 指向 listbox', async () => {
    render(<StockSearchInput onSelect={vi.fn()} ariaLabel="代码或名称" />);
    const input = screen.getByRole('combobox', { name: '代码或名称' });
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await typeAndSearch('茅台');
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toHaveAttribute('id', input.getAttribute('aria-controls'));
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import StrategyInput from '../StrategyInput';
import type { StrategyConfig } from '../types';

/**
 * 策略配置表单：断言都落在用户看得见的东西上——中文标签、输入框里的值、
 * 按钮可点性、搜索联动后显示的「当前标的」、以及真正交出去的配置对象。
 * 标的输入框用的是真实 StockSearchInput（只 mock 它依赖的 searchStocks），
 * 这样"选完标的却没进配置"这类脱节才测得出来。
 */

// StrategyInput 自己不碰网络，但它渲染的 StockSearchInput 会 import searchStocks；
// 不 mock 就会在 jsdom 里真发 axios 请求（mock 工厂必须导出该符号，否则渲染即报错）。
const apiMocks = vi.hoisted(() => ({ searchStocks: vi.fn() }));
vi.mock('../../../api/client', () => ({ searchStocks: apiMocks.searchStocks }));

const submitButton = () => screen.getByRole('button', { name: '开始研究' });
const searchBox = () => screen.getByRole('combobox', { name: '量化标的搜索' });
const strategySelect = () => screen.getByLabelText('策略类型');

function renderInput(loading = false) {
  const onSubmit = vi.fn();
  render(<StrategyInput onSubmit={onSubmit} loading={loading} />);
  return { onSubmit };
}

/** 点搜索下拉里的第一个候选：页面上的 <select> 也含 role=option 的子项，必须限定在 listbox 内 */
async function pickFirstSuggestion() {
  // 下拉先出现「正在检索…」，候选要等这次查询回来才渲染
  const listbox = await screen.findByRole('listbox', {}, { timeout: 2000 });
  fireEvent.mouseDown(await within(listbox).findByRole('option', {}, { timeout: 2000 }));
}

/** 取出这次提交的配置（顺带断言只提交了一次） */
function submitted(onSubmit: ReturnType<typeof vi.fn>): StrategyConfig {
  expect(onSubmit).toHaveBeenCalledTimes(1);
  return onSubmit.mock.calls[0][0] as StrategyConfig;
}

beforeEach(() => {
  apiMocks.searchStocks.mockReset();
  apiMocks.searchStocks.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StrategyInput —— 初始形态', () => {
  it('默认渲染：均线交叉、预填标的 600519、近两年区间与默认参数', () => {
    renderInput();

    expect(strategySelect()).toHaveValue('ma_cross');
    expect(
      Array.from((strategySelect() as HTMLSelectElement).options).map((o) => o.textContent),
    ).toEqual(['均线交叉', '动量', '均值回归']);

    // 标的预填 600519，并给出可搜索的输入框（含无障碍名称与占位提示）
    expect(screen.getByText('当前标的：600519')).toBeInTheDocument();
    expect(searchBox()).toHaveAttribute('placeholder', '输入股票代码或名称，如 600519 / 贵州茅台');

    // 默认区间：结束 = 今天（本地时区），开始 = 两年前
    const localDate = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    expect(screen.getByLabelText('结束日期')).toHaveValue(localDate(new Date()));
    expect(screen.getByLabelText('开始日期')).toHaveValue(localDate(twoYearsAgo));

    // 均线交叉的两个参数 + 资金/成本默认值
    expect(screen.getByLabelText('短期均线天数')).toHaveValue(5);
    expect(screen.getByLabelText('长期均线天数')).toHaveValue(20);
    expect(screen.getByLabelText('初始资金（元）')).toHaveValue(1000000);
    expect(screen.getByLabelText('成本模型')).toHaveValue('default');
    expect(screen.getByLabelText('佣金率（买入费率）')).toHaveValue(0.0003);

    expect(submitButton()).toBeEnabled();
  });

  it('loading 时按钮显示「研究中...」且不可点', () => {
    const { onSubmit } = renderInput(true);

    const btn = screen.getByRole('button', { name: '研究中...' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('StrategyInput —— 提交配置', () => {
  it('默认配置提交：中文策略名、预填标的、默认参数与自定义费率', () => {
    const { onSubmit } = renderInput();
    fireEvent.click(submitButton());

    const payload = submitted(onSubmit);
    // 提交的就是屏幕上显示的那份配置（日期取输入框当前值，不另算一套）
    expect(payload).toEqual({
      name: '均线交叉策略',
      type: 'ma_cross',
      stockCode: '600519',
      params: { shortPeriod: 5, longPeriod: 20 },
      startDate: (screen.getByLabelText('开始日期') as HTMLInputElement).value,
      endDate: (screen.getByLabelText('结束日期') as HTMLInputElement).value,
      initialCapital: 1000000,
      commission: 0.0003,
    });
    // 自定义费率模式不带 costModel（可选字段是整个 key 省略，而不是 undefined 占位）
    expect(payload).not.toHaveProperty('costModel');
  });

  it('切到 A 股真实费率：佣金率输入禁用，提交带 costModel 且不带 commission', () => {
    const { onSubmit } = renderInput();
    expect(screen.getByLabelText('佣金率（买入费率）')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('成本模型'), { target: { value: 'a_share' } });
    // 费率由模型决定，佣金率字段不可编辑
    expect(screen.getByLabelText('佣金率（买入费率）')).toBeDisabled();

    fireEvent.click(submitButton());
    const payload = submitted(onSubmit);
    expect(payload.costModel).toBe('a_share');
    expect(payload).not.toHaveProperty('commission');
  });

  it('切换策略类型：参数控件换成该策略的默认值（旧参数不残留）', () => {
    renderInput();
    fireEvent.change(screen.getByLabelText('短期均线天数'), { target: { value: '10' } });
    expect(screen.getByLabelText('短期均线天数')).toHaveValue(10);

    fireEvent.change(strategySelect(), { target: { value: 'momentum' } });
    expect(screen.queryByLabelText('短期均线天数')).toBeNull();
    expect(screen.getByLabelText('回看天数')).toHaveValue(20);
    expect(screen.getByLabelText('买入阈值 (%)')).toHaveValue(5);
    expect(screen.getByLabelText('卖出阈值 (%)')).toHaveValue(-3);

    fireEvent.change(strategySelect(), { target: { value: 'mean_reversion' } });
    expect(screen.getByLabelText('均线天数')).toHaveValue(20);
    expect(screen.getByLabelText('偏离买入阈值 (%)')).toHaveValue(-3);
    expect(screen.getByLabelText('偏离卖出阈值 (%)')).toHaveValue(3);

    // 切回均线交叉：参数回到默认值，而不是保留刚才改过的 10
    fireEvent.change(strategySelect(), { target: { value: 'ma_cross' } });
    expect(screen.getByLabelText('短期均线天数')).toHaveValue(5);
    expect(screen.getByLabelText('长期均线天数')).toHaveValue(20);
  });

  it('策略名由中文标签拼「策略」，三项都不出现重复后缀', () => {
    const { onSubmit } = renderInput();
    fireEvent.change(strategySelect(), { target: { value: 'momentum' } });
    fireEvent.click(submitButton());

    const payload = submitted(onSubmit);
    expect(payload.type).toBe('momentum');
    expect(payload.params).toEqual({ lookback: 20, buyThreshold: 5, sellThreshold: -3 });
    expect(payload.name).toBe('动量策略');
  });

  it('参数编辑进入提交配置；清空输入被忽略，不会把参数写成 0', () => {
    const { onSubmit } = renderInput();
    const shortInput = screen.getByLabelText('短期均线天数');

    fireEvent.change(shortInput, { target: { value: '8' } });
    expect(shortInput).toHaveValue(8);
    // parseFloat('') = NaN → 忽略该次输入，控件回落显示上一个有效值（不会变成 0）
    fireEvent.change(shortInput, { target: { value: '' } });
    expect(shortInput).toHaveValue(8);

    fireEvent.click(submitButton());
    expect(submitted(onSubmit).params).toEqual({ shortPeriod: 8, longPeriod: 20 });
  });

  it('初始资金与佣金率可编辑并进入提交配置；清空资金回落 0 而不是留空', () => {
    const { onSubmit } = renderInput();

    fireEvent.change(screen.getByLabelText('初始资金（元）'), { target: { value: '250000' } });
    fireEvent.change(screen.getByLabelText('佣金率（买入费率）'), { target: { value: '0.0005' } });
    fireEvent.click(submitButton());
    expect(submitted(onSubmit)).toEqual(
      expect.objectContaining({ initialCapital: 250000, commission: 0.0005 }),
    );

    fireEvent.change(screen.getByLabelText('初始资金（元）'), { target: { value: '' } });
    expect(screen.getByLabelText('初始资金（元）')).toHaveValue(0);

    // 清空佣金率同样回落 0（parseFloat('') 为 NaN → || 0）
    fireEvent.change(screen.getByLabelText('佣金率（买入费率）'), { target: { value: '' } });
    expect(screen.getByLabelText('佣金率（买入费率）')).toHaveValue(0);
  });

  it('结束日期早于开始日期时按钮禁用，改回合法区间后恢复可提交', () => {
    const { onSubmit } = renderInput();

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2025-06-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2024-06-01' } });
    expect(submitButton()).toBeDisabled();
    fireEvent.click(submitButton());
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-06-01' } });
    expect(submitButton()).toBeEnabled();
    fireEvent.click(submitButton());
    expect(submitted(onSubmit)).toEqual(
      expect.objectContaining({ startDate: '2025-06-01', endDate: '2026-06-01' }),
    );
  });
});

describe('StrategyInput —— 标的搜索联动', () => {
  it('从搜索结果选中名称后显示「当前标的：代码 名称」，并随提交下发', async () => {
    apiMocks.searchStocks.mockResolvedValue([{ code: '000001', name: '平安银行' }]);
    const { onSubmit } = renderInput();

    fireEvent.change(searchBox(), { target: { value: '平安银行' } });
    await pickFirstSuggestion();

    expect(screen.getByText('当前标的：000001 平安银行')).toBeInTheDocument();
    fireEvent.click(submitButton());
    expect(submitted(onSubmit).stockCode).toBe('000001');
  });

  it('搜索无结果时仍可手工输入 6 位代码：失焦即选中，只显示代码', async () => {
    apiMocks.searchStocks.mockResolvedValue([]);
    const { onSubmit } = renderInput();

    const box = searchBox();
    fireEvent.change(box, { target: { value: '999999' } });
    await waitFor(() => expect(apiMocks.searchStocks).toHaveBeenCalledWith('999999'), {
      timeout: 2000,
    });
    expect(await screen.findByText(/未找到「999999」对应的股票/)).toBeInTheDocument();

    fireEvent.blur(box);
    expect(screen.getByText('当前标的：999999')).toBeInTheDocument();
    fireEvent.click(submitButton());
    expect(submitted(onSubmit).stockCode).toBe('999999');
  });

  it('搜索命中但代码为空（脏数据）时按钮禁用、不显示当前标的，也提交不出去', async () => {
    apiMocks.searchStocks.mockResolvedValue([{ code: '', name: '脏数据' }]);
    const { onSubmit } = renderInput();

    fireEvent.change(searchBox(), { target: { value: '脏数据' } });
    await pickFirstSuggestion();

    expect(screen.queryByText(/当前标的/)).toBeNull();
    expect(submitButton()).toBeDisabled();
    fireEvent.click(submitButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

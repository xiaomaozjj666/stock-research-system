// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * 对比分析「部分成功」的渲染回归。
 * 背景：POST /api/compare 曾用 Promise.all——3 只股票跑 1~3 分钟后一只失败即整批作废，
 * 另外两只已完成的结果被丢弃。服务端已改为 allSettled + failures 清单，
 * 本文件锁定前端对应行为：成功列照常渲染、失败列标注原因并可单只重试。
 */

const api = vi.hoisted(() => ({ compareStocks: vi.fn() }));

vi.mock('../../api/client', () => ({
  compareStocks: api.compareStocks,
  AnalysisCancelledError: class AnalysisCancelledError extends Error {
    constructor(message = '已取消') {
      super(message);
      this.name = 'AnalysisCancelledError';
    }
  },
}));

// 搜索选择器会做防抖搜索，这里直接暴露「选中一只」的入口
vi.mock('../StockSearchInput', () => ({
  default: ({
    onSelect,
    actionLabel,
  }: {
    onSelect: (c: string, n: string) => void;
    actionLabel: string;
  }) =>
    React.createElement(
      'div',
      null,
      React.createElement('button', { onClick: () => onSelect('600519', '贵州茅台') }, '选茅台'),
      React.createElement('button', { onClick: () => onSelect('000858', '五粮液') }, '选五粮液'),
      React.createElement('span', null, actionLabel),
    ),
}));

const { default: ComparisonView } = await import('../ComparisonView');

/** 成功列数据取全（对比表会读财务/估值/评分，缺字段会渲染失败被 ErrorBoundary 兜底） */
function stock(code: string, name: string) {
  return {
    stock_code: code,
    stock_name: name,
    industry: '白酒',
    core_summary: '摘要',
    total_score: 80,
    rating: '优先跟踪',
    finance_metrics: {
      years: ['2023', '2024', '2025'],
      revenue: [100, 120, 140],
      netProfit: [30, 36, 42],
      grossMargin: [90, 91, 92],
      netMargin: [30, 30, 30],
      roe: [25, 26, 27],
    },
    valuation: { pe: 30, pb: 8, marketCap: 20000, historicalPE: [], peerComparison: [] },
    score_detail: {
      profit_quality: 80,
      growth: 70,
      valuation: 60,
      industry_boom: 90,
      risk_deduction: 50,
    },
  };
}

/** 选中两只并开始对比 */
function startCompare() {
  fireEvent.click(screen.getByText('选茅台'));
  fireEvent.click(screen.getByText('选五粮液'));
  fireEvent.click(screen.getByText(/开始对比分析/));
}

describe('ComparisonView 部分成功', () => {
  beforeEach(() => {
    api.compareStocks.mockReset();
  });

  it('一只成功一只失败：成功列保留，失败列标注原因并可单只重试', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [stock('600519', '贵州茅台')],
      failures: [{ code: '000858', error: '行情或财务数据不可用（可能已停牌或数据源异常）' }],
    });

    render(<ComparisonView />);
    startCompare();

    // 先确认打桩生效，否则后面的 DOM 断言会给出误导性的失败信息
    await waitFor(() => expect(api.compareStocks).toHaveBeenCalled());

    await waitFor(() => expect(screen.getByText('分析失败')).toBeInTheDocument());
    // 失败原因会同时出现在顶部提示条与失败列，故用 getAllByText
    expect(screen.getAllByText(/数据不可用/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '重试这一只' })).toBeInTheDocument();
    expect(screen.getAllByText(/贵州茅台/).length).toBeGreaterThan(0);
  });

  it('部分失败同时给出整体提示（不让用户以为全部成功）', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [stock('600519', '贵州茅台')],
      failures: [{ code: '000858', error: '该股分析未完成，请稍后重试' }],
    });

    render(<ComparisonView />);
    startCompare();

    // 单只失败时 describeFailures 直接给该只原因（不加"部分股票分析失败"前缀），
    // 但仍必须在页面上可见——否则用户会以为全部成功
    await waitFor(() =>
      expect(screen.getAllByText(/该股分析未完成，请稍后重试/).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(/五粮液/).length).toBeGreaterThan(0);
  });

  it('全部成功时不渲染任何失败标记（与旧契约一致）', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [stock('600519', '贵州茅台'), stock('000858', '五粮液')],
    });

    render(<ComparisonView />);
    startCompare();

    await waitFor(() => expect(api.compareStocks).toHaveBeenCalled());
    expect(screen.queryByText('分析失败')).toBeNull();
    expect(screen.queryByText(/部分股票分析失败/)).toBeNull();
  });

  it('全部失败时逐列给出原因与单只重试，而不是空表格或整页报错', async () => {
    api.compareStocks.mockResolvedValue({
      stocks: [],
      failures: [
        { code: '600519', error: '行情或财务数据不可用（可能已停牌或数据源异常）' },
        { code: '000858', error: '该股分析未完成，请稍后重试' },
      ],
    });

    render(<ComparisonView />);
    startCompare();

    // 两只都失败：各自成列（可见原因），并各自提供单只重试入口——比"整页只有一条报错"更有用
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '重试这一只' })).toHaveLength(2),
    );
    expect(screen.getAllByText('分析失败')).toHaveLength(2);
    expect(screen.getAllByText(/数据不可用/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/请稍后重试/).length).toBeGreaterThan(0);
    // 但两只都没成功 → 没有可凑数的伙伴，重试按钮禁用并写明原因（不是死按钮）
    for (const btn of screen.getAllByRole('button', { name: '重试这一只' })) {
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', expect.stringContaining('需至少一只成功结果才能重试'));
    }
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from './App';

// mock SSE 流式分析 API（不发起真实网络请求）
const apiMock = vi.hoisted(() => ({ analyzeStockStream: vi.fn() }));
vi.mock('./api/client', () => ({ analyzeStockStream: apiMock.analyzeStockStream }));

// mock UI 基础设施 hooks / 组件
vi.mock('./components/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('./hooks/useCountUp', () => ({ useCountUp: (v: number) => v }));

// mock 股票选择器：简化交互（输入代码 + 触发 onAnalyze）
vi.mock('./components/StockSelector', () => ({
  default: ({ onAnalyze }: { onAnalyze: (code: string) => void }) =>
    React.createElement(
      'div',
      null,
      React.createElement('input', { 'aria-label': '股票代码' }),
      React.createElement('button', { onClick: () => onAnalyze('600519') }, '分析'),
    ),
}));

// 图表区懒加载：mock 掉，避免依赖真实 echarts
vi.mock('./components/ChartsSection', () => ({
  default: () => React.createElement('div', { className: 'charts-mock' }, '图表'),
}));

// 财务/估值等区块内部可能直接用 EChart，mock 按需 echarts init
const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('./lib/echarts', () => ({ default: { init: echartsMock.init } }));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function makeResult() {
  return {
    stock_pool: [
      {
        stock_code: '600519',
        stock_name: '贵州茅台',
        industry: '白酒',
        core_summary: '核心摘要',
        total_score: 85,
        rating: '买入',
        score_detail: {
          profit_quality: 80,
          growth: 70,
          valuation: 60,
          industry_boom: 90,
          risk_deduction: 50,
        },
        strengths: ['品牌壁垒'],
        risk_list: ['估值偏高'],
        controversy_points: [
          {
            topic: '争议',
            bullishView: '多',
            bearishView: '空',
            arbitration: '仲裁',
            confidence: 50,
          },
        ],
        finance_metrics: {
          years: ['2024'],
          revenue: [1],
          netProfit: [1],
          grossMargin: [10],
          netMargin: [5],
          roe: [8],
          operatingCashFlow: [1],
          eps: [1],
        },
        valuation: {
          currentPrice: 1700,
          pe: 30,
          pb: 8,
          ps: 10,
          marketCap: 20000,
          historicalPE: [],
          peerComparison: [],
        },
        valuation_level: '合理',
        expert_opinions: [
          {
            expert: '资金筹码分析师',
            arguments: [{ text: '资金流入', confidence: 80, type: 'support' as const }],
            overallSentiment: 'bullish' as const,
            confidence: 80,
            keyPoints: ['筹码集中'],
          },
        ],
        reflection_notes: ['自省校验通过'],
        follow_up_indicators: ['跟踪指标'],
        scenarios: [],
        strategyList: [],
      },
    ],
    research_confidence: '高',
    limitation_explain: '历史回测不代表未来收益',
    data_sources: [],
  };
}

describe('App', () => {
  beforeEach(() => {
    const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    echartsMock.init.mockClear();
    echartsMock.init.mockReturnValue(chart);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    apiMock.analyzeStockStream.mockReset();
  });

  it('初始渲染：显示全部 7 个标签页', () => {
    render(<App />);
    for (const label of [
      '深度研究',
      '量化研究',
      '对比分析',
      '自选股',
      '模拟盘',
      '研究助手',
      '历史',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('分析成功：报告区渲染股票名称、综合评分与评级', async () => {
    apiMock.analyzeStockStream.mockReturnValue({
      done: Promise.resolve(makeResult()),
      cancel: vi.fn(),
    });
    render(<App />);
    fireEvent.change(screen.getByLabelText('股票代码'), { target: { value: '600519' } });
    fireEvent.click(screen.getByText('分析'));
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeInTheDocument());
    expect(screen.getAllByText('综合评分').length).toBeGreaterThan(0); // 侧边导航 + 评分卡
    expect(screen.getAllByText('买入').length).toBeGreaterThan(0); // 评级标签 + 评分卡
  });

  it('分析失败：显示错误横幅与重试按钮', async () => {
    apiMock.analyzeStockStream.mockReturnValue({
      done: Promise.reject(new Error('网络错误')),
      cancel: vi.fn(),
    });
    render(<App />);
    fireEvent.change(screen.getByLabelText('股票代码'), { target: { value: '600519' } });
    fireEvent.click(screen.getByText('分析'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/网络错误/)).toBeInTheDocument();
    expect(screen.getByText(/重试/)).toBeInTheDocument();
  });
});

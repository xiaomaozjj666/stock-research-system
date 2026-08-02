// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import StrategyListSection from '../StrategyListSection';

const base = [
  {
    strategyType: '均线交叉',
    sharpeRatio: 1.2,
    maxDrawdown: -5,
    winRate: 60,
    totalReturn: 10,
    applicableMarket: '趋势行情',
    fatalWeakness: '震荡假信号',
    backtestWarning: '风险提示',
  },
];

describe('StrategyListSection', () => {
  it('空数据渲染「暂无策略数据」', () => {
    const { getByText } = render(<StrategyListSection data={[]} />);
    expect(getByText('暂无策略数据')).toBeInTheDocument();
  });

  it('渲染策略卡片（无新闻叠加层）', () => {
    const { getByText, queryByText } = render(<StrategyListSection data={base} />);
    expect(getByText('均线交叉')).toBeInTheDocument();
    expect(getByText('+10.0%')).toBeInTheDocument();
    // 无新闻时不渲染新闻叠加块
    expect(queryByText(/含最新消息/)).toBeNull();
  });

  it('含新闻叠加层显示姿态与收益', () => {
    const data = [
      {
        ...base[0],
        newsAware: {
          totalReturn: 12,
          sharpeRatio: 1.3,
          maxDrawdown: -4,
          winRate: 62,
          posture: 0.7,
        },
      },
    ];
    const { getByText } = render(<StrategyListSection data={data} />);
    expect(getByText(/含最新消息（姿态 70%）/)).toBeInTheDocument();
  });
});

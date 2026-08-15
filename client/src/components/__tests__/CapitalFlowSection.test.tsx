// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import CapitalFlowSection from '../CapitalFlowSection';

const flowData = {
  expert: '资金筹码分析师',
  overallSentiment: 'bullish' as const,
  confidence: 85,
  arguments: [
    {
      text: '主力资金连续净流入',
      confidence: 90,
      type: 'support' as const,
      evidenceType: 'fact' as const,
    },
    {
      text: '北向资金减持',
      confidence: 60,
      type: 'oppose' as const,
      evidenceType: 'inference' as const,
    },
  ],
  keyPoints: ['筹码集中度提升', '换手率健康'],
};

describe('CapitalFlowSection', () => {
  it('无数据时渲染 null（不输出任何 DOM）', () => {
    const { container } = render(<CapitalFlowSection data={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('渲染标题、看多标签与置信度', () => {
    const { getByText } = render(<CapitalFlowSection data={flowData} />);
    expect(getByText('资金筹码分析')).toBeInTheDocument();
    expect(getByText('看多')).toBeInTheDocument();
    expect(getByText('置信度 85%')).toBeInTheDocument();
  });

  it('渲染论证条目、证据标签（事实/推演）与关键要点', () => {
    const { getByText } = render(<CapitalFlowSection data={flowData} />);
    expect(getByText('主力资金连续净流入')).toBeInTheDocument();
    expect(getByText('[事实]')).toBeInTheDocument();
    expect(getByText('[推演]')).toBeInTheDocument();
    expect(getByText('关键要点：')).toBeInTheDocument();
    expect(getByText('筹码集中度提升')).toBeInTheDocument();
  });

  it('看空 sentiment 显示「看空」标签', () => {
    const { getByText } = render(
      <CapitalFlowSection data={{ ...flowData, overallSentiment: 'bearish' as const }} />,
    );
    expect(getByText('看空')).toBeInTheDocument();
  });
});

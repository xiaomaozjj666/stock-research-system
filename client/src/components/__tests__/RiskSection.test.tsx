// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import RiskSection from '../RiskSection';

describe('RiskSection', () => {
  it('空数据渲染 null（不输出 DOM）', () => {
    const { container } = render(<RiskSection data={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('非空渲染风险清单项', () => {
    const { getByText, container } = render(<RiskSection data={['流动性风险', '政策风险']} />);
    expect(getByText('风险清单')).toBeInTheDocument();
    expect(container.querySelectorAll('.risk-item')).toHaveLength(2);
  });

  it('默认参数为空数组时渲染 null', () => {
    const { container } = render(<RiskSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('渲染风险归因：因子暴露条 + 风险分解', () => {
    const attribution = {
      exposures: {
        size: 1.2,
        value: -0.8,
        momentum: 0,
        profitability: 1.5,
        leverage: 0.6,
      },
      decomposition: {
        systematicVol: 30,
        specificVol: 20,
        totalVol: 36,
        explainedRatio: 0.69,
      },
    };
    const { getByText, container } = render(<RiskSection data={[]} attribution={attribution} />);
    expect(getByText('风险归因（风格因子暴露）')).toBeInTheDocument();
    for (const label of ['规模', '价值', '动量', '盈利', '杠杆']) {
      expect(getByText(label)).toBeInTheDocument();
    }
    expect(getByText('+1.20')).toBeInTheDocument();
    expect(getByText('-0.80')).toBeInTheDocument();
    expect(getByText('+0.00')).toBeInTheDocument(); // 0 也带 + 前缀（v>=0 分支）
    expect(getByText(/系统风险 30%/)).toBeInTheDocument();
    expect(getByText(/特异风险 20%/)).toBeInTheDocument();
    expect(getByText(/总波动 36%/)).toBeInTheDocument();
    expect(getByText(/因子解释占比 69%/)).toBeInTheDocument();
    expect(container.querySelectorAll('.risk-factor-fill.positive').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.risk-factor-fill.negative').length).toBeGreaterThan(0);
  });
});

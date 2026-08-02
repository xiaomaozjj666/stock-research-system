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
    const { getByText, container } = render(
      <RiskSection data={['流动性风险', '政策风险']} />,
    );
    expect(getByText('风险清单')).toBeInTheDocument();
    expect(container.querySelectorAll('.risk-item')).toHaveLength(2);
  });

  it('默认参数为空数组时渲染 null', () => {
    const { container } = render(<RiskSection />);
    expect(container).toBeEmptyDOMElement();
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ScoreRadar from '../ScoreRadar';

afterEach(cleanup);

/** 取评分多边形（最后一个 polygon：前面是 4 圈网格）的顶点数 */
function scorePolygonPoints(container: HTMLElement): string[] {
  const polygons = container.querySelectorAll('polygon');
  const score = polygons[polygons.length - 1];
  return score.getAttribute('points')?.trim().split(/\s+/) ?? [];
}

describe('ScoreRadar', () => {
  it('渲染为带可访问名称的图片角色，摘要包含五个维度', () => {
    const { getByRole } = render(
      <ScoreRadar
        scores={{
          profit_quality: 18,
          growth: 15,
          valuation: 12,
          industry_boom: 9,
          risk_deduction: 6,
        }}
      />,
    );
    const svg = getByRole('img');
    expect(svg).toHaveAttribute('aria-label');
    const label = svg.getAttribute('aria-label') ?? '';
    for (const dim of ['盈利质量', '成长性', '估值性价比', '行业景气度', '风险水平']) {
      expect(label).toContain(dim);
    }
    expect(label).toContain('18/20');
  });

  it('评分多边形固定五个顶点', () => {
    const { container } = render(
      <ScoreRadar
        scores={{
          profit_quality: 10,
          growth: 10,
          valuation: 10,
          industry_boom: 10,
          risk_deduction: 10,
        }}
      />,
    );
    expect(scorePolygonPoints(container)).toHaveLength(5);
  });

  it('越界/非数值夹紧到 [0, 20]', () => {
    const { container, getByText } = render(
      <ScoreRadar
        scores={{
          profit_quality: 99,
          growth: -5,
          valuation: Number.NaN,
          industry_boom: Number.POSITIVE_INFINITY,
          risk_deduction: 12,
        }}
      />,
    );
    // 顶点数值标签：99→20、-5→0、NaN/Infinity→0、12 保留
    expect(getByText('20')).toBeInTheDocument();
    expect(getByText('12')).toBeInTheDocument();
    expect(container.querySelectorAll('text')).toHaveLength(10); // 5 轴标签 + 5 顶点数值
  });

  it('缺少评分数据时按全 0 渲染而不抛错', () => {
    const { getByRole, container } = render(<ScoreRadar scores={undefined} />);
    expect(getByRole('img').getAttribute('aria-label')).toContain('0/20');
    expect(scorePolygonPoints(container)).toHaveLength(5);
  });
});

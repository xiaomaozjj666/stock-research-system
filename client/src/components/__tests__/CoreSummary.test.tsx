// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import CoreSummary from '../CoreSummary';

describe('CoreSummary', () => {
  it('无数据时回退默认文案', () => {
    const { getByText } = render(<CoreSummary data={{}} />);
    expect(getByText('暂无核心摘要')).toBeInTheDocument();
  });

  it('渲染核心摘要、利多与利空列表', () => {
    const { getByText, getAllByRole } = render(
      <CoreSummary
        data={{
          core_summary: '公司质地优良',
          strengths: ['高分红', '低估值'],
          risk_list: ['行业下行'],
        }}
      />,
    );
    expect(getByText('公司质地优良')).toBeInTheDocument();
    expect(getByText('高分红')).toBeInTheDocument();
    expect(getByText('行业下行')).toBeInTheDocument();
    // 利多 2 + 利空 1 = 3 个列表项
    expect(getAllByRole('listitem')).toHaveLength(3);
  });

  it('缺少利多/利空数组时不报错', () => {
    const { getByText } = render(<CoreSummary data={{ core_summary: '只看摘要' }} />);
    expect(getByText('只看摘要')).toBeInTheDocument();
  });
});

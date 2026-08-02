// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import NewsSentimentCard from '../NewsSentimentCard';
import type { NewsSignal } from '../../types';

function makeSignal(over: Partial<NewsSignal>): NewsSignal {
  return {
    polarity: 0.4,
    sentimentZ: 0.5,
    bullishRatio: 0.8,
    newsCount: 3,
    freshness: 0.9,
    weightedImpact: 0.36,
    hasNews: true,
    items: [
      { id: '1', title: '超预期增长', publishedAt: '2026-08-01T00:00:00Z', source: '测试', polarity: 0.5 },
      { id: '2', title: '平淡公告', publishedAt: '2026-07-30T00:00:00Z', source: '测试', polarity: 0 },
    ],
    ...over,
  };
}

describe('NewsSentimentCard', () => {
  it('无新闻时渲染 null（不输出任何 DOM）', () => {
    const { container } = render(<NewsSentimentCard data={makeSignal({ hasNews: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('偏多极性：渲染标题、徽章与极性数值', () => {
    const { getByText } = render(<NewsSentimentCard data={makeSignal({ polarity: 0.4 })} />);
    expect(getByText('📰 最新消息情绪')).toBeInTheDocument();
    expect(getByText('偏多')).toBeInTheDocument();
    expect(getByText('0.40')).toBeInTheDocument();
  });

  it('中性极性显示「中性」徽章', () => {
    const { getByText } = render(<NewsSentimentCard data={makeSignal({ polarity: 0 })} />);
    expect(getByText('中性')).toBeInTheDocument();
  });

  it('仅展示最新 6 条新闻', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      title: `新闻${i}`,
      publishedAt: '2026-08-01T00:00:00Z',
      source: '测试',
    }));
    const { getAllByRole } = render(<NewsSentimentCard data={makeSignal({ items })} />);
    expect(getAllByRole('listitem')).toHaveLength(6);
  });
});

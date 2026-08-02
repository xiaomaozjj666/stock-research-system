import type { NewsSignal } from '../types';

interface Props {
  data: NewsSignal;
}

function pct(v: number): string {
  return (v * 100).toFixed(0) + '%';
}

function polarityLabel(p: number): { text: string; cls: string } {
  if (p > 0.15) return { text: '偏多', cls: 'bull' };
  if (p < -0.15) return { text: '偏空', cls: 'bear' };
  return { text: '中性', cls: 'neutral' };
}

export default function NewsSentimentCard({ data }: Props) {
  if (!data.hasNews) return null;
  const label = polarityLabel(data.polarity);

  // 仅展示最新 6 条
  const topItems = data.items.slice(0, 6);

  return (
    <div className="news-sentiment-card">
      <div className="news-sentiment-head">
        <h3 className="news-sentiment-title">📰 最新消息情绪</h3>
        <span className={`news-badge news-badge--${label.cls}`}>{label.text}</span>
      </div>

      <div className="news-metrics">
        <div className="news-metric">
          <div className={`news-metric-value ${label.cls}`}>{data.polarity.toFixed(2)}</div>
          <div className="news-metric-label">加权极性</div>
        </div>
        <div className="news-metric">
          <div className="news-metric-value">{pct(data.bullishRatio)}</div>
          <div className="news-metric-label">看多占比</div>
        </div>
        <div className="news-metric">
          <div className="news-metric-value">{pct(data.freshness)}</div>
          <div className="news-metric-label">新鲜度</div>
        </div>
        <div className="news-metric">
          <div className="news-metric-value">{data.newsCount}</div>
          <div className="news-metric-label">新闻条数</div>
        </div>
      </div>

      <ul className="news-list">
        {topItems.map((it) => {
          const itLabel = polarityLabel(it.polarity ?? 0);
          return (
            <li key={it.id} className="news-item">
              <span className={`news-dot news-dot--${itLabel.cls}`} />
              <div className="news-item-body">
                <div className="news-item-title">{it.title}</div>
                <div className="news-item-meta">
                  <span>{it.source ?? '未知来源'}</span>
                  <span>{it.publishedAt?.slice(0, 10)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="news-footnote">
        情绪信号已纳入情景推演与量化策略回测（新闻姿态仓位）。历史回测不代表未来，新闻冲击可能已被市场部分定价。
      </p>
    </div>
  );
}

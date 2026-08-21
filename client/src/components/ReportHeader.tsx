interface StockData {
  stock_code: string;
  stock_name: string;
  industry: string;
  total_score: number;
  rating: string;
  valuation?: {
    currentPrice?: number;
    marketCap?: number;
  };
  /** 与上次分析的对比（记忆反思闭环） */
  vs_previous?: {
    previous_date: string;
    previous_rating: string;
    previous_score: number;
    score_delta: number;
    rating_changed: boolean;
  };
}

interface ReportHeaderProps {
  data: StockData;
  research_confidence?: string;
  /** 完整分析结果（导出 Markdown 用） */
  result?: unknown;
  onExport?: () => void;
}

function getRatingClass(rating: string) {
  if (rating.includes('优先')) return 'priority';
  if (rating.includes('持续')) return 'watch';
  if (rating.includes('谨慎')) return 'caution';
  if (rating.includes('规避')) return 'avoid';
  return 'watch';
}

function formatMarketCap(cap?: number) {
  if (!cap) return '—';
  if (cap >= 10000) return (cap / 10000).toFixed(1) + ' 万亿';
  return cap.toFixed(0) + ' 亿';
}

/** 较上次分析的评分变化标签（记忆反思闭环展示） */
function VsPreviousTag({
  prev,
  currentRating,
}: {
  prev: NonNullable<StockData['vs_previous']>;
  currentRating: string;
}) {
  const delta = prev.score_delta;
  const up = delta > 0;
  const down = delta < 0;
  const cls = up ? 'vs-previous-up' : down ? 'vs-previous-down' : 'vs-previous-flat';
  const arrow = up ? '▲' : down ? '▼' : '＝';
  return (
    <div
      className={`vs-previous-tag ${cls}`}
      title={`上次分析：${prev.previous_date} · ${prev.previous_rating} · ${prev.previous_score} 分`}
    >
      {arrow} 较上次分析 {up ? '+' : ''}
      {Math.round(delta * 100) / 100} 分
      {prev.rating_changed && (
        <span className="vs-previous-rating">
          · 评级 {prev.previous_rating} → {currentRating}
        </span>
      )}
    </div>
  );
}

export default function ReportHeader({ data, research_confidence, onExport }: ReportHeaderProps) {
  return (
    <div className="card report-header">
      <div className="report-header-top">
        <div>
          <div>
            <span className="stock-name">{data.stock_name}</span>
            <span className="stock-code">{data.stock_code}</span>
            <span className="stock-industry">{data.industry}</span>
          </div>
          <div className="header-meta">
            {data.valuation?.currentPrice && (
              <div className="header-meta-item">
                当前价格：<span>¥{data.valuation.currentPrice.toFixed(2)}</span>
              </div>
            )}
            {data.valuation?.marketCap && (
              <div className="header-meta-item">
                市值：<span>{formatMarketCap(data.valuation.marketCap)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="score-block">
          <div className="score-number">{data.total_score}</div>
          <div className={`rating-tag ${getRatingClass(data.rating)}`}>{data.rating}</div>
          {data.vs_previous && (
            <VsPreviousTag prev={data.vs_previous} currentRating={data.rating} />
          )}
          {research_confidence && (
            <div className="confidence-tag">研究置信度：{research_confidence}</div>
          )}
        </div>
        {onExport && (
          <button
            className="btn-ghost report-export-btn"
            onClick={onExport}
            title="导出为 Markdown"
          >
            导出报告
          </button>
        )}
      </div>
    </div>
  );
}

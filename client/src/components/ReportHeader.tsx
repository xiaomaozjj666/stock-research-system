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

export default function ReportHeader({
  data,
  research_confidence,
  onExport,
}: ReportHeaderProps) {
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
          {research_confidence && (
            <div className="confidence-tag">研究置信度：{research_confidence}</div>
          )}
        </div>
        {onExport && (
          <button className="btn-ghost report-export-btn" onClick={onExport} title="导出为 Markdown">
            导出报告
          </button>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { compareStocks } from '../api/client';
import StockSearchInput from '../components/StockSearchInput';
import { ErrorBoundary } from './ErrorBoundary';

interface StockData {
  stock_code: string;
  stock_name: string;
  industry: string;
  core_summary: string;
  total_score: number;
  rating: string;
  finance_metrics: {
    years: string[];
    revenue: number[];
    netProfit: number[];
    grossMargin: number[];
    netMargin: number[];
    roe: number[];
  };
  valuation: {
    currentPrice: number;
    pe: number;
    pb: number;
    ps: number;
    marketCap: number;
  };
  expert_opinions: {
    expert: string;
    overallSentiment: 'bullish' | 'neutral' | 'bearish';
    confidence: number;
  }[];
  strengths: string[];
  risk_list: string[];
}

type FormatType = 'score' | 'price' | 'pe' | 'pb' | 'cap' | 'percent' | 'text' | 'sentiment';

interface RowConfig {
  label: string;
  accessor: (s: StockData) => number | string;
  format: FormatType;
  higherIsBetter?: boolean;
}

const COMPARISON_ROWS: RowConfig[] = [
  { label: '综合评分', accessor: (s) => s.total_score, format: 'score', higherIsBetter: true },
  { label: '评级', accessor: (s) => s.rating, format: 'text' },
  { label: '行业', accessor: (s) => s.industry, format: 'text' },
  {
    label: '当前价格',
    accessor: (s) => s.valuation?.currentPrice ?? 0,
    format: 'price',
    higherIsBetter: false,
  },
  {
    label: 'PE（市盈率）',
    accessor: (s) => s.valuation?.pe ?? 0,
    format: 'pe',
    higherIsBetter: false,
  },
  {
    label: 'PB（市净率）',
    accessor: (s) => s.valuation?.pb ?? 0,
    format: 'pb',
    higherIsBetter: false,
  },
  {
    label: '市值（亿）',
    accessor: (s) => s.valuation?.marketCap ?? 0,
    format: 'cap',
    higherIsBetter: false,
  },
  {
    label: 'ROE（%）',
    accessor: (s) => {
      const roe = s.finance_metrics?.roe;
      return roe && roe.length > 0 ? roe[roe.length - 1] : 0;
    },
    format: 'percent',
    higherIsBetter: true,
  },
  {
    label: '毛利率（%）',
    accessor: (s) => {
      const gm = s.finance_metrics?.grossMargin;
      return gm && gm.length > 0 ? gm[gm.length - 1] : 0;
    },
    format: 'percent',
    higherIsBetter: true,
  },
  {
    label: '净利率（%）',
    accessor: (s) => {
      const nm = s.finance_metrics?.netMargin;
      return nm && nm.length > 0 ? nm[nm.length - 1] : 0;
    },
    format: 'percent',
    higherIsBetter: true,
  },
  {
    label: '专家情绪',
    accessor: (s) => {
      const opinions = s.expert_opinions ?? [];
      if (opinions.length === 0) return 'neutral';
      const bullishCount = opinions.filter((o) => o.overallSentiment === 'bullish').length;
      const bearishCount = opinions.filter((o) => o.overallSentiment === 'bearish').length;
      if (bullishCount > bearishCount) return 'bullish';
      if (bearishCount > bullishCount) return 'bearish';
      return 'neutral';
    },
    format: 'sentiment',
    higherIsBetter: true,
  },
];

function formatValue(v: number | string, format: FormatType): string {
  if (format === 'text') return String(v);
  if (format === 'sentiment') {
    const map: Record<string, string> = { bullish: '偏多', neutral: '中性', bearish: '偏空' };
    return map[v as string] ?? '中性';
  }
  const num = Number(v);
  if (isNaN(num)) return '—';
  switch (format) {
    case 'price':
      return `¥${num.toFixed(2)}`;
    case 'pe':
    case 'pb':
      return num.toFixed(2);
    case 'cap':
      return num >= 10000 ? `${(num / 10000).toFixed(2)}万亿` : `${num.toFixed(0)}亿`;
    case 'percent':
      return `${num.toFixed(2)}%`;
    case 'score':
      return `${num.toFixed(0)}/100`;
    default:
      return String(num);
  }
}

function ComparisonRow({
  label,
  values,
  format,
  higherIsBetter,
}: {
  label: string;
  values: (number | string)[];
  format: FormatType;
  higherIsBetter?: boolean;
}) {
  const numericValues = values.map((v) => (typeof v === 'number' ? v : 0));
  const positiveValues = numericValues.filter((v) => v > 0);
  const maxVal = positiveValues.length > 0 ? Math.max(...positiveValues) : 0;
  const minVal = positiveValues.length > 0 ? Math.min(...positiveValues) : 0;

  const getCellClass = (v: number | string) => {
    if (format === 'text' || format === 'sentiment') return '';
    const num = typeof v === 'number' ? v : 0;
    if (num <= 0) return '';
    if (higherIsBetter) {
      if (num === maxVal) return 'cell-best';
      if (num === minVal && maxVal !== minVal) return 'cell-worst';
    } else {
      if (num === minVal) return 'cell-best';
      if (num === maxVal && maxVal !== minVal) return 'cell-worst';
    }
    return '';
  };

  return (
    <tr>
      <td className="cmp-label">{label}</td>
      {values.map((v, i) => (
        <td key={i} className={`cmp-cell ${getCellClass(v)}`}>
          {format === 'sentiment' ? (
            <span className={`sentiment-tag sentiment-${v}`}>{formatValue(v, format)}</span>
          ) : (
            formatValue(v, format)
          )}
        </td>
      ))}
    </tr>
  );
}

export function ComparisonView() {
  const [stocks, setStocks] = useState<string[]>([]);
  const [stockNames, setStockNames] = useState<Record<string, string>>({});
  const [results, setResults] = useState<StockData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addStock = (code: string, name?: string) => {
    const c = code.trim();
    if (!c) return;
    if (stocks.includes(c)) {
      setError('该股票已添加');
      return;
    }
    if (stocks.length >= 3) return;
    setStocks((prev) => [...prev, c]);
    setStockNames((prev) => ({ ...prev, [c]: name || prev[c] || c }));
    setError('');
  };

  const removeStock = (code: string) => {
    setStocks((prev) => prev.filter((s) => s !== code));
  };

  const startCompare = async () => {
    if (stocks.length < 2) return;
    setLoading(true);
    setError('');
    try {
      const data = await compareStocks(stocks);
      setResults(data.stocks);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '对比分析失败');
    }
    setLoading(false);
  };

  const reset = () => {
    setResults(null);
    setStocks([]);
    setStockNames({});
    setError('');
  };

  if (results) {
    return (
      <ErrorBoundary>
        <div className="comparison-view">
          <div className="comparison-header">
            <h2 className="comparison-title">股票对比分析</h2>
            <button className="btn-back" onClick={reset}>
              重新对比
            </button>
          </div>

          <div className="comparison-table-wrap">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>对比指标</th>
                  {results.map((s) => (
                    <th key={s.stock_code} className="cmp-stock-header">
                      <div className="cmp-stock-name">{s.stock_name}</div>
                      <div className="cmp-stock-code">{s.stock_code}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((row) => (
                  <ComparisonRow
                    key={row.label}
                    label={row.label}
                    values={results.map(row.accessor)}
                    format={row.format}
                    higherIsBetter={row.higherIsBetter}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="comparison-summaries">
            {results.map((s) => (
              <div key={s.stock_code} className="comparison-summary-card">
                <div className="comparison-summary-header">
                  <span className="comparison-summary-name">{s.stock_name}</span>
                  <span className="comparison-summary-score">{s.total_score}分</span>
                </div>
                <p className="comparison-summary-text">{s.core_summary}</p>
                <div className="comparison-summary-meta">
                  <div className="comparison-summary-strengths">
                    <span className="meta-label">核心优势</span>
                    <ul>
                      {(s.strengths ?? []).slice(0, 3).map((st, i) => (
                        <li key={i}>{st}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="comparison-summary-risks">
                    <span className="meta-label">主要风险</span>
                    <ul>
                      {(s.risk_list ?? []).slice(0, 3).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <div className="comparison-setup">
      <h2 className="comparison-setup-title">股票对比</h2>
      <p className="comparison-setup-desc">
        添加 2–3 只股票，一键生成财务、估值、趋势的多维度横向对比报告
      </p>

      <div className="comparison-input-row">
        <StockSearchInput
          onSelect={(code, name) => addStock(code, name)}
          actionLabel="＋ 添加"
          disabled={stocks.length >= 3}
          placeholder="输入股票代码或名称，如 600519 / 贵州茅台"
          ariaLabel="对比股票搜索"
        />
      </div>

      <div className="comparison-tags">
        {stocks.map((code, idx) => (
          <span key={code} className="comparison-tag">
            <span className="tag-index">{idx + 1}</span>
            <span className="tag-name">{stockNames[code] || code}</span>
            <span className="tag-code">{code}</span>
            <button className="tag-remove" onClick={() => removeStock(code)}>
              ×
            </button>
          </span>
        ))}
        {Array.from({ length: 3 - stocks.length }).map((_, i) => (
          <span key={`empty-${i}`} className="comparison-tag comparison-tag-empty">
            ＋ 添加第 {stocks.length + i + 1} 只
          </span>
        ))}
      </div>

      {error && <div className="comparison-error">{error}</div>}

      <button
        className="btn-compare"
        onClick={startCompare}
        disabled={stocks.length < 2 || loading}
      >
        {loading ? (
          <span className="btn-compare-loading">
            <span className="loading-dot" />
            分析中...
          </span>
        ) : stocks.length < 2 ? (
          '请至少添加 2 只股票'
        ) : (
          `开始对比分析（${stocks.length}/3）`
        )}
      </button>
    </div>
  );
}

export default ComparisonView;

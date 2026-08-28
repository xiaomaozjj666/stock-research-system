import { memo } from 'react';
interface ValuationData {
  currentPrice?: number;
  pe?: number;
  pb?: number;
  ps?: number;
  marketCap?: number;
  historicalPE?: { year: string; pe: number }[];
  peerComparison?: {
    name: string;
    code: string;
    pe: number;
    pb: number;
    roe: number;
    marketCap: number;
  }[];
}

interface ValuationSectionProps {
  data: ValuationData;
  valuation_level?: string;
  stockName?: string;
}

function getValLevelClass(level?: string) {
  if (!level) return 'fair';
  if (level.includes('低估')) return 'undervalued';
  if (level.includes('高估')) return 'overvalued';
  return 'fair';
}

function formatCap(cap?: number) {
  if (!cap) return '—';
  if (cap >= 10000) return (cap / 10000).toFixed(1) + '万亿';
  return cap.toFixed(0) + '亿';
}

function ValuationSection({ data, valuation_level, stockName }: ValuationSectionProps) {
  const levelClass = getValLevelClass(valuation_level);

  return (
    <div className="card">
      <div
        className="section-title"
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}
      >
        估值分析
        {valuation_level && (
          <span className={`val-level-tag ${levelClass}`} style={{ marginLeft: 'auto' }}>
            {valuation_level}
          </span>
        )}
      </div>

      <div className="val-cards">
        <div className="val-card">
          <div className="val-card-label">PE (TTM)</div>
          <div className="val-card-value">{data.pe?.toFixed(1) || '—'}</div>
        </div>
        <div className="val-card">
          <div className="val-card-label">PB</div>
          <div className="val-card-value">{data.pb?.toFixed(2) || '—'}</div>
        </div>
        <div className="val-card">
          <div className="val-card-label">PS</div>
          <div className="val-card-value">{data.ps?.toFixed(2) || '—'}</div>
        </div>
        <div className="val-card">
          <div className="val-card-label">总市值</div>
          <div className="val-card-value">{formatCap(data.marketCap)}</div>
        </div>
      </div>

      {data.peerComparison && data.peerComparison.length > 0 && (
        <>
          <h4 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 10 }}>
            同业估值对比
          </h4>
          <table className="peer-table">
            <thead>
              <tr>
                <th>公司</th>
                <th>PE</th>
                <th>PB</th>
                <th>ROE</th>
                <th>市值(亿)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="highlight">
                <td>{stockName || '标的'}</td>
                <td>{data.pe?.toFixed(1) || '—'}</td>
                <td>{data.pb?.toFixed(2) || '—'}</td>
                <td>—</td>
                <td>{formatCap(data.marketCap)}</td>
              </tr>
              {data.peerComparison.map((p) => (
                <tr key={p.code}>
                  <td>{p.name}</td>
                  <td>{p.pe?.toFixed(1) || '—'}</td>
                  <td>{p.pb?.toFixed(2) || '—'}</td>
                  <td>{p.roe && p.roe > 0 ? p.roe.toFixed(1) + '%' : '—'}</td>
                  <td>{formatCap(p.marketCap)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// App 的滚动/悬停等本地状态变化频率高，memo 避免纯数据展示区块随之全量重渲染
export default memo(ValuationSection);

import { memo } from 'react';
interface FinanceMetrics {
  years?: string[];
  revenue?: number[];
  netProfit?: number[];
  grossMargin?: number[];
  netMargin?: number[];
  roe?: number[];
  operatingCashFlow?: number[];
  eps?: number[];
}

interface FinancialSectionProps {
  data: FinanceMetrics;
}

function fmt(val: number | undefined, type: 'money' | 'pct' | 'plain'): string {
  if (val === undefined || val === null) return '—';
  if (type === 'pct') return val.toFixed(1) + '%';
  if (type === 'money') return val.toFixed(1);
  return val.toFixed(2);
}

function yoyColor(val: number | undefined): string {
  if (val === undefined) return '';
  return val > 0 ? 'val-positive' : val < 0 ? 'val-negative' : 'val-neutral';
}

function yoyArrow(val: number | undefined): string {
  if (val === undefined) return '';
  return val > 0 ? ' ↑' : val < 0 ? ' ↓' : '';
}

function FinancialSection({ data }: FinancialSectionProps) {
  const years = data.years || [];
  if (years.length === 0) return null;

  const rows: {
    label: string;
    values: (number | undefined)[];
    type: 'money' | 'pct' | 'plain';
    unit: string;
  }[] = [
    { label: '营业收入(亿)', values: data.revenue || [], type: 'money', unit: '亿' },
    { label: '净利润(亿)', values: data.netProfit || [], type: 'money', unit: '亿' },
    { label: '毛利率', values: data.grossMargin || [], type: 'pct', unit: '%' },
    { label: '净利率', values: data.netMargin || [], type: 'pct', unit: '%' },
    { label: 'ROE', values: data.roe || [], type: 'pct', unit: '%' },
    { label: '经营现金流(亿)', values: data.operatingCashFlow || [], type: 'money', unit: '亿' },
    { label: 'EPS(元)', values: data.eps || [], type: 'plain', unit: '元' },
  ];

  return (
    <div className="card">
      <div className="section-title">财务深度分析</div>
      <div className="finance-table-wrap">
        <table className="finance-table">
          <thead>
            <tr>
              <th>指标</th>
              {years.map((y) => (
                <th key={y}>{y}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                {row.values.map((v, i) => {
                  const prev = i > 0 ? row.values[i - 1] : undefined;
                  const rawChange =
                    prev && prev !== 0 && v !== undefined
                      ? ((v - prev) / Math.abs(prev)) * 100
                      : undefined;
                  // 中间年份缺数据时避免 NaN 渲染成 NaN%
                  const change = Number.isFinite(rawChange) ? rawChange : undefined;
                  return (
                    <td key={i} className={yoyColor(change)}>
                      {fmt(v, row.type)}
                      {i > 0 && change !== undefined && (
                        <span style={{ fontSize: 11, marginLeft: 4 }}>
                          {yoyArrow(change)}
                          {Math.abs(change).toFixed(1)}%
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// App 的滚动/悬停等本地状态变化频率高，memo 避免纯数据展示区块随之全量重渲染
export default memo(FinancialSection);

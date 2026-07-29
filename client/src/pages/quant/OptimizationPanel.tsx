import type { OptimizationReport } from './types';

interface Props {
  data: OptimizationReport;
}

function impactCls(impact: 'high' | 'medium' | 'low'): string {
  if (impact === 'high') return 'chip chip-negative';
  if (impact === 'medium') return 'chip chip-neutral';
  return 'chip chip-positive';
}

function impactLabel(impact: 'high' | 'medium' | 'low'): string {
  if (impact === 'high') return '高影响';
  if (impact === 'medium') return '中影响';
  return '低影响';
}

export default function OptimizationPanel({ data }: Props) {
  const sortedSuggestions = [...data.suggestions].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.impact] - order[b.impact];
  });

  return (
    <div className="card quant-panel">
      <h3 className="quant-panel-title">策略优化建议</h3>

      <div className="quant-opt-score">
        <span className="quant-opt-score-val">{data.performanceScore}</span>
        <span className="quant-opt-score-max">/100</span>
        <span className="quant-opt-score-label">性能评分</span>
      </div>

      {sortedSuggestions.length > 0 && (
        <div className="quant-opt-section">
          <h4 className="quant-subtitle">优化建议</h4>
          <div className="quant-opt-suggestions">
            {sortedSuggestions.map((s, i) => (
              <div key={i} className="quant-opt-suggestion-card">
                <div className="quant-opt-suggestion-head">
                  <span className="quant-opt-suggestion-cat">{s.category}</span>
                  <span className={impactCls(s.impact)}>{impactLabel(s.impact)}</span>
                </div>
                <div className="quant-opt-suggestion-title">{s.title}</div>
                <div className="quant-opt-suggestion-detail">{s.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.parameterSensitivity.length > 0 && (
        <div className="quant-opt-section">
          <h4 className="quant-subtitle">参数敏感性</h4>
          <div className="quant-sensitivity-table-wrap">
            <table className="quant-sensitivity-table">
              <thead>
                <tr>
                  <th>参数</th>
                  <th>当前值</th>
                  <th>建议范围</th>
                  <th>最优值</th>
                  <th>敏感度</th>
                </tr>
              </thead>
              <tbody>
                {data.parameterSensitivity.map((p, i) => (
                  <tr key={i}>
                    <td>{p.param}</td>
                    <td className="quant-mono">{p.currentValue}</td>
                    <td className="quant-mono">{p.suggestedRange.min} ~ {p.suggestedRange.max}</td>
                    <td className="quant-mono quant-accent-text">{p.suggestedRange.optimal}</td>
                    <td>{p.sensitivity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="quant-opt-section">
        <h4 className="quant-subtitle">风险指标</h4>
        <div className="quant-risk-metrics">
          <div className="quant-risk-metric">
            <div className="quant-risk-metric-val">{(data.riskMetrics.var95 * 100).toFixed(2)}%</div>
            <div className="quant-risk-metric-label">VaR (95%)</div>
          </div>
          <div className="quant-risk-metric">
            <div className="quant-risk-metric-val">{data.riskMetrics.maxConsecutiveLoss}</div>
            <div className="quant-risk-metric-label">最大连亏次数</div>
          </div>
          <div className="quant-risk-metric">
            <div className="quant-risk-metric-val">{data.riskMetrics.avgHoldingDays}天</div>
            <div className="quant-risk-metric-label">平均持仓天数</div>
          </div>
        </div>
      </div>

      {data.iterationDirections.length > 0 && (
        <div className="quant-opt-section">
          <h4 className="quant-subtitle">迭代方向</h4>
          <ul className="quant-iteration-list">
            {data.iterationDirections.map((d, i) => (
              <li key={i} className="quant-iteration-item">
                <span className="quant-iteration-dot" />
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

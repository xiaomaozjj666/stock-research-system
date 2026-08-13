interface CoreSummaryProps {
  data: {
    core_summary?: string;
    strengths?: string[];
    risk_list?: string[];
  };
}

export default function CoreSummary({ data }: CoreSummaryProps) {
  const strengths = data.strengths || [];
  const risks = data.risk_list || [];

  return (
    <div className="core-summary-v2">
      {/* Summary paragraph - full width, prominent */}
      <div className="summary-block">
        <div className="summary-text">{data.core_summary || '暂无核心摘要'}</div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--border-default)' }} />

      {/* Strengths & Risks - 2 column grid */}
      <div className="factors-grid">
        <div className="factor-col">
          <div className="factor-header factor-header--bull">
            <span className="factor-icon factor-icon--bull">↑</span>
            利多因素
            <span className="factor-count">{strengths.length}</span>
          </div>
          <ul className="factor-list">
            {strengths.map((s, i) => (
              <li key={i} className="factor-item factor-item--bull">
                {s}
              </li>
            ))}
          </ul>
        </div>
        <div className="factor-col">
          <div className="factor-header factor-header--bear">
            <span className="factor-icon factor-icon--bear">↓</span>
            利空因素
            <span className="factor-count">{risks.length}</span>
          </div>
          <ul className="factor-list">
            {risks.map((r, i) => (
              <li key={i} className="factor-item factor-item--bear">
                {r}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

interface CoreSummaryProps {
  data: {
    core_summary?: string;
    strengths?: string[];
    risk_list?: string[];
  };
}

export default function CoreSummary({ data }: CoreSummaryProps) {
  const { core_summary, strengths = [], risk_list = [] } = data;

  return (
    <div className="card">
      <div className="section-title">核心摘要</div>
      <div className="core-summary-grid">
        <div className="strengths-col">
          <h4>利多因素</h4>
          <div className="tag-list">
            {strengths.map((s, i) => (
              <div key={i} className="tag-bull">{s}</div>
            ))}
          </div>
        </div>
        <div className="core-conclusion">
          {core_summary || '暂无核心摘要'}
        </div>
        <div className="risks-col">
          <h4>利空因素</h4>
          <div className="tag-list">
            {risk_list.slice(0, 5).map((r, i) => (
              <div key={i} className="tag-bear">{r}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

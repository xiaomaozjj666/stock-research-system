interface ControversyPoint {
  topic: string;
  bullishView: string;
  bearishView: string;
  arbitration: string;
  confidence: number;
}

interface ControversySectionProps {
  data: ControversyPoint[];
}

export default function ControversySection({ data = [] }: ControversySectionProps) {
  if (data.length === 0) return null;

  return (
    <div className="card">
      <div className="section-title">争议点说明</div>
      {data.map((c, i) => (
        <div className="controversy-card" key={i}>
          <div className="controversy-topic">{c.topic}</div>
          <div className="controversy-views">
            <div className="view-bull">
              <div className="view-label">看多观点</div>
              {c.bullishView}
            </div>
            <div className="view-bear">
              <div className="view-label">看空观点</div>
              {c.bearishView}
            </div>
          </div>
          <div className="controversy-arbitration">
            <strong>仲裁结论：</strong>{c.arbitration}
          </div>
          <span className="confidence-badge">置信度 {c.confidence}%</span>
        </div>
      ))}
    </div>
  );
}

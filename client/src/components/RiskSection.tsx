interface RiskSectionProps {
  data: string[];
}

export default function RiskSection({ data = [] }: RiskSectionProps) {
  if (data.length === 0) return null;

  return (
    <div className="card">
      <div className="section-title">风险清单</div>
      <div className="risk-list">
        {data.map((risk, i) => (
          <div className="risk-item" key={i}>
            <span>{risk}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

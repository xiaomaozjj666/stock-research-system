interface FollowUpSectionProps {
  data: string[];
}

export default function FollowUpSection({ data = [] }: FollowUpSectionProps) {
  if (data.length === 0) return null;

  return (
    <div className="card">
      <div className="section-title">后续跟踪指标</div>
      <div className="followup-list">
        {data.map((item, i) => (
          <div className="followup-item" key={i}>
            <span className="followup-dot" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

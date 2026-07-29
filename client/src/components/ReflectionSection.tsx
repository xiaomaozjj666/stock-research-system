interface ReflectionSectionProps {
  data: string[];
}

export default function ReflectionSection({ data = [] }: ReflectionSectionProps) {
  if (data.length === 0) return null;

  return (
    <div className="card">
      <div className="section-title">自省校验说明</div>
      <div className="reflection-list">
        {data.map((note, i) => (
          <div className="reflection-item" key={i}>
            <span>{note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ScoreDetail {
  profit_quality: number;
  growth: number;
  valuation: number;
  industry_boom: number;
  risk_deduction: number;
}

interface ScoringTableProps {
  data: {
    score_detail?: ScoreDetail;
    total_score?: number;
    rating?: string;
  };
}

const dimLabels: { key: keyof ScoreDetail; label: string }[] = [
  { key: 'profit_quality', label: '盈利质量' },
  { key: 'growth', label: '成长性' },
  { key: 'valuation', label: '估值性价比' },
  { key: 'industry_boom', label: '行业景气度' },
  { key: 'risk_deduction', label: '风险水平' },
];

function getBarColor(score: number) {
  if (score >= 16) return 'green';
  if (score >= 11) return 'blue';
  if (score >= 6) return 'orange';
  return 'red';
}

function getRatingClass(rating?: string) {
  if (!rating) return 'watch';
  if (rating.includes('优先')) return 'priority';
  if (rating.includes('持续')) return 'watch';
  if (rating.includes('谨慎')) return 'caution';
  if (rating.includes('规避')) return 'avoid';
  return 'watch';
}

export default function ScoringTable({ data }: ScoringTableProps) {
  const detail = data.score_detail;
  if (!detail) return null;

  return (
    <div className="card">
      <div className="section-title">五维度量化打分</div>
      {dimLabels.map((d) => {
        const val = detail[d.key];
        return (
          <div className="scoring-row" key={d.key}>
            <div className="scoring-dim">{d.label}</div>
            <div className="scoring-bar-wrap">
              <div
                className={`scoring-bar ${getBarColor(val)}`}
                style={{ width: `${(val / 20) * 100}%` }}
              />
            </div>
            <div className="scoring-val">{val}</div>
          </div>
        );
      })}
      <div className="scoring-total">
        <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>综合评分</span>
        <span className="scoring-total-num">{data.total_score}</span>
        <span className={`rating-tag ${getRatingClass(data.rating)}`}>{data.rating}</span>
      </div>
    </div>
  );
}

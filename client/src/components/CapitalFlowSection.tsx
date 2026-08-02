interface ExpertArgument {
  text: string;
  confidence: number;
  type: 'support' | 'oppose';
  evidenceType?: 'fact' | 'inference' | 'hypothesis';
}

interface ExpertOpinion {
  expert: string;
  arguments: ExpertArgument[];
  overallSentiment: 'bullish' | 'neutral' | 'bearish';
  confidence: number;
  keyPoints: string[];
}

interface Props {
  data: ExpertOpinion | undefined;
}

function sentimentLabel(s: string): string {
  if (s === 'bullish') return '看多';
  if (s === 'bearish') return '看空';
  return '中性';
}

function sentimentClass(s: string): string {
  if (s === 'bullish') return 'bullish';
  if (s === 'bearish') return 'bearish';
  return 'neutral';
}

function evidenceTagLabel(type?: string): string {
  if (type === 'fact') return '[事实]';
  if (type === 'inference') return '[推演]';
  if (type === 'hypothesis') return '[假设]';
  return '';
}

export default function CapitalFlowSection({ data }: Props) {
  if (!data) return null;

  return (
    <div className="card">
      <div className="section-title">资金筹码分析</div>

      <div className="capital-panel">
        <div className="capital-header">
          <span className={`capital-sentiment ${sentimentClass(data.overallSentiment)}`}>
            {sentimentLabel(data.overallSentiment)}
          </span>
          <span className="confidence-badge">置信度 {data.confidence}%</span>
        </div>

        <div className="expert-args">
          {data.arguments.map((arg, j) => (
            <div key={j} className={`arg-item ${arg.type}`}>
              <span>{arg.text}</span>
              {arg.evidenceType && (
                <span className={`evidence-tag ${arg.evidenceType}`}>
                  {evidenceTagLabel(arg.evidenceType)}
                </span>
              )}
              <span className="confidence-badge confidence-badge-spaced">
                {arg.confidence}%
              </span>
            </div>
          ))}
        </div>

        {data.keyPoints && data.keyPoints.length > 0 && (
          <div className="expert-keypoints">
            <strong className="keypoints-label">关键要点：</strong>
            <ul>
              {data.keyPoints.map((kp, j) => (
                <li key={j}>{kp}</li>
              ))}
            </ul>
          </div>
        )}

        {(data as ExpertOpinion & { limitation?: string }).limitation && (
          <div className="capital-limitation">
            {(data as ExpertOpinion & { limitation?: string }).limitation}
          </div>
        )}
      </div>
    </div>
  );
}

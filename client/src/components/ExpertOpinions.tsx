import { useState } from 'react';

interface ExpertArgument {
  text: string;
  confidence: number;
  type: 'support' | 'oppose';
}

interface ExpertOpinion {
  expert: string;
  arguments: ExpertArgument[];
  overallSentiment: 'bullish' | 'neutral' | 'bearish';
  confidence: number;
  keyPoints: string[];
}

interface ExpertOpinionsProps {
  data: ExpertOpinion[];
}

function sentimentLabel(s: string) {
  if (s === 'bullish') return '看多';
  if (s === 'bearish') return '看空';
  return '中性';
}

export default function ExpertOpinions({ data = [] }: ExpertOpinionsProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (data.length === 0) return null;

  return (
    <div className="card">
      <div className="section-title">专家观点</div>
      {data.map((exp, i) => (
        <div className="expert-panel" key={i}>
          <div
            className="expert-header"
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
          >
            <span className="expert-name">{exp.expert}</span>
            <div className="expert-header-right">
              <span className="confidence-badge">{exp.confidence}%</span>
              <span className={`expert-sentiment ${exp.overallSentiment}`}>
                {sentimentLabel(exp.overallSentiment)}
              </span>
              <span className="expert-arrow">{openIndex === i ? '▾' : '▸'}</span>
            </div>
          </div>
          <div
            className="expert-body"
            style={{
              maxHeight: openIndex === i ? 600 : 0,
              opacity: openIndex === i ? 1 : 0,
              padding: openIndex === i ? undefined : '0 16px',
              overflow: 'hidden',
              transition: 'max-height 0.3s ease, opacity 0.25s ease, padding 0.3s ease',
            }}
          >
            <div className="expert-args">
              {exp.arguments.map((arg, j) => (
                <div key={j} className={`arg-item ${arg.type}`}>
                  {arg.text}
                  <span className="confidence-badge" style={{ marginLeft: 8 }}>
                    {arg.confidence}%
                  </span>
                </div>
              ))}
            </div>
            {exp.keyPoints.length > 0 && (
              <div className="expert-keypoints">
                <strong style={{ fontSize: 12, color: 'var(--text-secondary)' }}>关键要点：</strong>
                <ul>
                  {exp.keyPoints.map((kp, j) => (
                    <li key={j}>{kp}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

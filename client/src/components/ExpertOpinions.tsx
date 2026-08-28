import { memo, useState } from 'react';

interface ExpertArgument {
  text: string;
  confidence: number;
  type: 'support' | 'oppose';
  evidenceType?: 'fact' | 'inference' | 'hypothesis';
}

function evidenceTagLabel(type?: string): string {
  if (type === 'fact') return '[事实]';
  if (type === 'inference') return '[推演]';
  if (type === 'hypothesis') return '[假设]';
  return '';
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

function ExpertOpinions({ data = [] }: ExpertOpinionsProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (data.length === 0) return null;

  return (
    <div className="card">
      <div className="section-title">专家观点</div>
      {data.map((exp, i) => (
        <div className="expert-panel" key={i}>
          <div className="expert-header" onClick={() => setOpenIndex(openIndex === i ? null : i)}>
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
            className={`expert-body ${openIndex === i ? 'expert-body-open' : 'expert-body-closed'}`}
          >
            <div className="expert-args">
              {exp.arguments.map((arg, j) => (
                <div key={j} className={`arg-item ${arg.type}`}>
                  {arg.text}
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
            {(exp.keyPoints ?? []).length > 0 && (
              <div className="expert-keypoints">
                <strong className="keypoints-label">关键要点：</strong>
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

// App 的滚动/悬停等本地状态变化频率高，memo 避免纯数据展示区块随之全量重渲染
export default memo(ExpertOpinions);

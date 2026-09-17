import type { DataQualityReport } from './types';

interface Props {
  data: DataQualityReport;
}

function getScoreColor(score: number): string {
  if (score >= 80) return 'var(--color-positive)';
  if (score >= 60) return 'var(--color-warning)';
  return 'var(--color-negative)';
}

export default function DataQualityPanel({ data }: Props) {
  // 钳制到 0~100：越界分数会让 `${score}%` 变成非法 CSS 长度（-5% / NaN%）而被浏览器
  // 整条丢弃，进度条退化成满格，出现"数字写着 -5、条形却是 100%"的自相矛盾展示
  const score = Number.isFinite(data.overallScore)
    ? Math.min(100, Math.max(0, data.overallScore))
    : 0;
  const scoreColor = getScoreColor(score);

  return (
    <div className="card quant-panel">
      <h3 className="quant-panel-title">数据质量报告</h3>

      <div className="quant-quality-header">
        <div className="quant-quality-score" style={{ color: scoreColor }}>
          {score}
          <span className="quant-quality-max">/100</span>
        </div>
        <div className="quant-quality-bar-wrap">
          <div
            className="quant-quality-bar"
            style={{ width: `${score}%`, background: scoreColor }}
          />
        </div>
      </div>

      <div className="quant-quality-meta">
        <span>
          数据范围：{data.dataRange.start} ~ {data.dataRange.end}
        </span>
        <span>交易日：{data.dataRange.tradingDays} 天</span>
        <span>总记录：{data.totalRecords} 条</span>
      </div>

      {data.issues.length > 0 && (
        <div className="quant-issues">
          <h4 className="quant-subtitle">发现问题</h4>
          <ul className="quant-issue-list">
            {data.issues.map((issue, i) => (
              <li key={i} className="quant-issue-item">
                <span className="quant-issue-icon">⚠</span>
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.suggestions.length > 0 && (
        <div className="quant-suggestions">
          <h4 className="quant-subtitle">预处理建议</h4>
          <ul className="quant-suggestion-list">
            {data.suggestions.map((s, i) => (
              <li key={i} className="quant-suggestion-item">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

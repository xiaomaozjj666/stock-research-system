import type { QuantResearchReport } from './types';

interface Props {
  data: QuantResearchReport;
}

function getOverallScore(data: QuantResearchReport): number {
  const backtestScore = Math.min(100, Math.max(0,
    (data.backtest.sharpeRatio >= 1.5 ? 30 : data.backtest.sharpeRatio >= 1 ? 25 : data.backtest.sharpeRatio >= 0.5 ? 15 : 5) +
    (data.backtest.totalReturn >= 0.3 ? 25 : data.backtest.totalReturn >= 0.15 ? 20 : data.backtest.totalReturn >= 0 ? 10 : 0) +
    (data.backtest.maxDrawdown >= -0.1 ? 20 : data.backtest.maxDrawdown >= -0.2 ? 15 : data.backtest.maxDrawdown >= -0.3 ? 8 : 0) +
    (data.backtest.winRate >= 0.6 ? 15 : data.backtest.winRate >= 0.5 ? 10 : 5) +
    (data.dataQuality.overallScore >= 80 ? 10 : data.dataQuality.overallScore >= 60 ? 7 : 3)
  ));
  return backtestScore;
}

function getScoreLabel(score: number): string {
  if (score >= 80) return '优秀';
  if (score >= 60) return '良好';
  if (score >= 40) return '一般';
  return '较差';
}

function getScoreColor(score: number): string {
  if (score >= 80) return 'var(--color-positive)';
  if (score >= 60) return 'var(--accent)';
  if (score >= 40) return 'var(--color-warning)';
  return 'var(--color-negative)';
}

export default function ReportSummary({ data }: Props) {
  const score = getOverallScore(data);
  const scoreColor = getScoreColor(score);

  return (
    <div className="card quant-panel quant-summary-panel">
      <div className="quant-summary-header">
        <div>
          <h3 className="quant-panel-title">{data.strategy.name}</h3>
          <span className="chip chip-neutral">{data.strategy.type === 'ma_cross' ? '均线交叉' : data.strategy.type === 'momentum' ? '动量策略' : '均值回归'}</span>
        </div>
        <div className="quant-summary-score-block" style={{ color: scoreColor }}>
          <div className="quant-summary-score">{score}</div>
          <div className="quant-summary-score-label">{getScoreLabel(score)}</div>
        </div>
      </div>

      {data.summary && (
        <p className="quant-summary-text">{data.summary}</p>
      )}

      <div className="quant-summary-meta">
        {data.confidence && (
          <div className="quant-summary-meta-item">
            <span className="quant-summary-meta-label">置信度</span>
            <span>{data.confidence}</span>
          </div>
        )}
        {data.limitations && (
          <div className="quant-summary-meta-item">
            <span className="quant-summary-meta-label">局限性</span>
            <span>{data.limitations}</span>
          </div>
        )}
      </div>
    </div>
  );
}

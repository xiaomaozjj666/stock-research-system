import type { QuantResearchReport } from './types';
import { scoreCls } from '../../lib/colors';

interface Props {
  data: QuantResearchReport;
}

function getOverallScore(data: QuantResearchReport): number {
  // 注意：后端返回的 totalReturn/maxDrawdown/winRate 都是百分比值（如 15.5 表示 15.5%）
  // maxDrawdown 是正数（如 20 表示 20% 回撤）
  const backtestScore = Math.min(
    100,
    Math.max(
      0,
      (data.backtest.sharpeRatio >= 1.5
        ? 30
        : data.backtest.sharpeRatio >= 1
          ? 25
          : data.backtest.sharpeRatio >= 0.5
            ? 15
            : 5) +
        (data.backtest.totalReturn >= 30
          ? 25
          : data.backtest.totalReturn >= 15
            ? 20
            : data.backtest.totalReturn >= 0
              ? 10
              : 0) +
        (data.backtest.maxDrawdown <= 10
          ? 20
          : data.backtest.maxDrawdown <= 20
            ? 15
            : data.backtest.maxDrawdown <= 30
              ? 8
              : 0) +
        (data.backtest.winRate >= 60 ? 15 : data.backtest.winRate >= 50 ? 10 : 5) +
        (data.dataQuality.overallScore >= 80 ? 10 : data.dataQuality.overallScore >= 60 ? 7 : 3),
    ),
  );
  return backtestScore;
}

function getScoreLabel(score: number): string {
  if (score >= 80) return '优秀';
  if (score >= 60) return '良好';
  if (score >= 40) return '一般';
  return '较差';
}

function getScoreClass(score: number): string {
  // 分数好坏是**状态**判定，不是涨跌方向：这里返回 lib/colors.ts 的状态色类名
  // （80+ 优秀=状态绿 / 60+ 良好=强调蓝 / 40+ 一般=警示琥珀 / 其余较差=危险红）。
  // 此前用 --color-positive（红）表示「优秀」，等于把高分画成涨停，与 .val-positive 冲突。
  return scoreCls(score);
}

export default function ReportSummary({ data }: Props) {
  const score = getOverallScore(data);
  const scoreClsName = getScoreClass(score);

  return (
    <div className="card quant-panel quant-summary-panel">
      <div className="quant-summary-header">
        <div>
          <h3 className="quant-panel-title">{data.strategy.name}</h3>
          <span className="chip chip-neutral">
            {data.strategy.type === 'ma_cross'
              ? '均线交叉'
              : data.strategy.type === 'momentum'
                ? '动量策略'
                : data.strategy.type === 'mean_reversion'
                  ? '均值回归'
                  : '自定义策略'}
          </span>
        </div>
        <div className={`quant-summary-score-block ${scoreClsName}`}>
          <div className="quant-summary-score">{score}</div>
          <div className="quant-summary-score-label">{getScoreLabel(score)}</div>
        </div>
      </div>

      {data.summary && <p className="quant-summary-text">{data.summary}</p>}

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

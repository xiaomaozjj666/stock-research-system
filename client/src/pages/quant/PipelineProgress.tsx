import type { PipelineStage } from './types';

interface Props {
  currentStage: PipelineStage | null;
  completedStages: PipelineStage[];
  stageElapsed: Record<string, number>;
}

const STAGES: { key: PipelineStage; label: string }[] = [
  { key: 'fetch', label: '数据获取' },
  { key: 'quality', label: '数据质量检查' },
  { key: 'backtest', label: '回测执行' },
  { key: 'audit', label: '审计与优化' },
];

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function PipelineProgress({ currentStage, completedStages, stageElapsed }: Props) {
  return (
    <div className="quant-pipeline">
      {STAGES.map(({ key, label }) => {
        const isDone = completedStages.includes(key);
        const isActive = currentStage === key && !isDone;
        const cls = isDone ? 'done' : isActive ? 'active' : '';
        const elapsed = stageElapsed[key];

        return (
          <div key={key} className={`quant-pipeline-step ${cls}`}>
            <div className="quant-pipeline-dot" />
            <span className="quant-pipeline-label">{label}</span>
            {isDone && elapsed != null && (
              <span className="quant-pipeline-time">{formatElapsed(elapsed)}</span>
            )}
            {isActive && (
              <span className="quant-pipeline-time quant-pipeline-running">执行中...</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

import { useState, useEffect } from 'react';
import type { AnalysisStage } from '../api/client';

// 阶段顺序与目标进度映射（与后端 AnalysisStage 对齐）
const STAGE_ORDER: { phase: AnalysisStage['phase']; label: string; progress: number }[] = [
  { phase: 'data', label: '数据获取', progress: 20 },
  { phase: 'experts', label: '专家独立研判', progress: 50 },
  { phase: 'arbitration', label: '辩论仲裁', progress: 70 },
  { phase: 'scoring', label: '量化打分', progress: 85 },
  { phase: 'strategy', label: '策略回测', progress: 95 },
];

interface Props {
  stage?: AnalysisStage | null;
}

export default function LoadingScreen({ stage }: Props) {
  // 根据后端推送的真实阶段确定当前索引与目标进度
  const currentIndex = stage ? STAGE_ORDER.findIndex((s) => s.phase === stage.phase) : -1;
  const activeIndex = currentIndex >= 0 ? currentIndex : 0;
  const targetProgress = currentIndex >= 0 ? STAGE_ORDER[currentIndex].progress : 5;

  const [progress, setProgress] = useState(0);

  // 进度条平滑过渡到目标值
  useEffect(() => {
    let rafId: number;
    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      setProgress((prev) => {
        if (prev >= targetProgress) return prev;
        const increment = (targetProgress - prev) * 0.002 * dt;
        return Math.min(prev + Math.max(increment, 0.05), targetProgress);
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [targetProgress]);

  const displayProgress = Math.min(progress, 99);
  const stageMessage = stage?.message || '正在初始化分析...';

  return (
    <div className="loading-screen">
      <div className="loading-content">
        <div className="loading-spinner" />

        <div className="loading-stages">
          {STAGE_ORDER.map((s, i) => {
            let cls = 'loading-stage-item';
            if (i === activeIndex) cls += ' active';
            if (i < activeIndex) cls += ' done';
            return (
              <div key={s.phase} className={cls}>
                <div className="loading-stage-dot" />
                <div className="loading-stage-text">
                  <span className="loading-stage-label">{s.label}</span>
                  {i === activeIndex && <span className="loading-stage-sub">{stageMessage}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="loading-progress">
          <div className="loading-progress-bar" style={{ width: `${displayProgress}%` }}>
            <div className="loading-progress-shimmer" />
          </div>
        </div>
        <p className="loading-progress-text">{Math.round(displayProgress)}%</p>

        <p className="loading-hint">深度分析预计需要 1-3 分钟，请耐心等待</p>
      </div>
    </div>
  );
}

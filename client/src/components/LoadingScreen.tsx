import { useState, useEffect } from 'react';

const stages = [
  '正在获取财务数据...',
  '基本面财务专家分析中...',
  '估值建模专家评估中...',
  '行业宏观专家研判中...',
  '风险合规专家排查中...',
  '数据仲裁官整合结论...',
  '双层自省校验中...',
  '生成量化评分...',
];

export default function LoadingScreen() {
  const [stageIndex, setStageIndex] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const stageTimer = setInterval(() => {
      setStageIndex((prev) => (prev + 1) % stages.length);
    }, 3000);
    return () => clearInterval(stageTimer);
  }, []);

  useEffect(() => {
    const progressTimer = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 95) return prev;
        return prev + Math.random() * 3 + 0.5;
      });
    }, 500);
    return () => clearInterval(progressTimer);
  }, []);

  return (
    <div className="loading-screen">
      <div className="loading-content">
        <div className="loading-spinner" />
        <p className="loading-stage">{stages[stageIndex]}</p>
        <div className="loading-progress">
          <div
            className="loading-progress-bar"
            style={{ width: `${Math.min(progress, 95)}%` }}
          />
        </div>
        <p className="loading-hint">深度分析预计需要 1-3 分钟，请耐心等待</p>
      </div>
    </div>
  );
}

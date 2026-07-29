import { useState, useRef, useCallback } from 'react';
import StrategyInput from './StrategyInput';
import PipelineProgress from './PipelineProgress';
import BacktestChart from './BacktestChart';
import DataQualityPanel from './DataQualityPanel';
import AuditPanel from './AuditPanel';
import OptimizationPanel from './OptimizationPanel';
import ReportSummary from './ReportSummary';
import { runQuantAnalysis } from '../../api/client';
import type { StrategyConfig, QuantResearchReport, PipelineStage } from './types';

const STAGE_ORDER: PipelineStage[] = ['fetch', 'quality', 'backtest', 'audit'];

export default function QuantPage() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<QuantResearchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<PipelineStage | null>(null);
  const [completedStages, setCompletedStages] = useState<PipelineStage[]>([]);
  const [stageElapsed, setStageElapsed] = useState<Record<string, number>>({});
  const stageStartRef = useRef<number>(0);

  const handleStart = useCallback(async (config: StrategyConfig) => {
    setLoading(true);
    setError(null);
    setReport(null);
    setCurrentStage('fetch');
    setCompletedStages([]);
    setStageElapsed({});
    stageStartRef.current = Date.now();

    // 模拟进度推进（后端是同步返回，所以用轮询式模拟）
    let stageIdx = 0;
    const interval = setInterval(() => {
      if (stageIdx < STAGE_ORDER.length - 1) {
        const doneStage = STAGE_ORDER[stageIdx];
        const elapsed = Date.now() - stageStartRef.current;
        setCompletedStages(prev => [...prev, doneStage]);
        setStageElapsed(prev => ({ ...prev, [doneStage]: elapsed - (prev[doneStage] ?? 0) }));
        stageIdx++;
        setCurrentStage(STAGE_ORDER[stageIdx]);
      }
    }, 800);

    try {
      const result = await runQuantAnalysis(config);
      clearInterval(interval);

      // 标记所有阶段完成
      const allElapsed: Record<string, number> = {};
      const totalMs = Date.now() - stageStartRef.current;
      STAGE_ORDER.forEach((s) => {
        allElapsed[s] = Math.round(totalMs / STAGE_ORDER.length * (0.8 + Math.random() * 0.4));
      });
      setCompletedStages([...STAGE_ORDER]);
      setStageElapsed(allElapsed);
      setCurrentStage(null);
      setReport(result);
    } catch {
      clearInterval(interval);
      setError('量化研究失败，请检查后端服务是否启动');
      setCurrentStage(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="quant-page">
      <aside className="quant-sidebar">
        <h3 className="quant-sidebar-title">策略配置</h3>
        <StrategyInput onSubmit={handleStart} loading={loading} />
      </aside>

      <div className="quant-main">
        {error && <div className="error-banner">{error}</div>}

        {loading && (
          <div className="card quant-panel">
            <h3 className="quant-panel-title">研究进度</h3>
            <PipelineProgress
              currentStage={currentStage}
              completedStages={completedStages}
              stageElapsed={stageElapsed}
            />
          </div>
        )}

        {report && !loading && (
          <>
            <ReportSummary data={report} />
            <BacktestChart data={report.backtest} />
            <DataQualityPanel data={report.dataQuality} />
            <AuditPanel data={report.audit} />
            <OptimizationPanel data={report.optimization} />
          </>
        )}

        {!loading && !report && !error && (
          <div className="quant-empty">
            <div className="quant-empty-icon">📊</div>
            <p className="quant-empty-text">配置左侧策略参数，点击"开始研究"启动量化分析</p>
          </div>
        )}
      </div>
    </div>
  );
}

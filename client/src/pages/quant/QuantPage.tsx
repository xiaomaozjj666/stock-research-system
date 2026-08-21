import { useState, useRef, useCallback, useEffect } from 'react';
import StrategyInput from './StrategyInput';
import PipelineProgress from './PipelineProgress';
import BacktestChart from './BacktestChart';
import DataQualityPanel from './DataQualityPanel';
import AuditPanel from './AuditPanel';
import OptimizationPanel from './OptimizationPanel';
import ReportSummary from './ReportSummary';
import NewsSentimentCard from '../../components/NewsSentimentCard';
import { runQuantAnalysis } from '../../api/client';
import type { StrategyConfig, QuantResearchReport, PipelineStage, NewsItem } from './types';

const STAGE_ORDER: PipelineStage[] = ['fetch', 'quality', 'backtest', 'audit'];

/** 含最新消息回测 vs 不含新闻基准回测 的对比 */
function NewsBacktestCompare({
  aware,
  baseline,
}: {
  aware: QuantResearchReport['backtest'];
  baseline: QuantResearchReport['backtest'];
}) {
  const rows: {
    label: string;
    aware: number;
    base: number;
    betterWhenHigher: boolean;
    fmt: (v: number) => string;
  }[] = [
    {
      label: '总收益率',
      aware: aware.totalReturn,
      base: baseline.totalReturn,
      betterWhenHigher: true,
      fmt: (v) => v.toFixed(2) + '%',
    },
    {
      label: '年化收益',
      aware: aware.annualizedReturn,
      base: baseline.annualizedReturn,
      betterWhenHigher: true,
      fmt: (v) => (v ?? 0).toFixed(2) + '%',
    },
    {
      label: '夏普比率',
      aware: aware.sharpeRatio,
      base: baseline.sharpeRatio,
      betterWhenHigher: true,
      fmt: (v) => v.toFixed(2),
    },
    {
      label: '最大回撤',
      aware: aware.maxDrawdown,
      base: baseline.maxDrawdown,
      betterWhenHigher: false,
      fmt: (v) => v.toFixed(2) + '%',
    },
    {
      label: '胜率',
      aware: aware.winRate,
      base: baseline.winRate,
      betterWhenHigher: true,
      fmt: (v) => v.toFixed(2) + '%',
    },
  ];
  return (
    <div className="card quant-panel news-compare">
      <h3 className="quant-panel-title">含最新消息 vs 不含新闻（回测对比）</h3>
      <table className="news-compare-table">
        <thead>
          <tr>
            <th>指标</th>
            <th>含最新消息</th>
            <th>不含新闻</th>
            <th>变化</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const delta = r.aware - r.base;
            const improved = r.betterWhenHigher ? delta > 0 : delta < 0;
            const deltaCls = Math.abs(delta) < 1e-9 ? '' : improved ? 'positive' : 'negative';
            return (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.fmt(r.aware)}</td>
                <td>{r.fmt(r.base)}</td>
                <td className={deltaCls}>
                  {delta > 0 ? '+' : ''}
                  {r.fmt(delta)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {typeof aware.newsPosture === 'number' && (
        <p className="news-compare-note">
          新闻姿态仓位系数：{(aware.newsPosture * 100).toFixed(0)}
          %（看多新闻满仓、中性半仓、利空不建仓）。
        </p>
      )}
    </div>
  );
}

export default function QuantPage() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<QuantResearchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<PipelineStage | null>(null);
  const [completedStages, setCompletedStages] = useState<PipelineStage[]>([]);
  const [stageElapsed, setStageElapsed] = useState<Record<string, number>>({});
  const [useNews, setUseNews] = useState(false);
  const [newsText, setNewsText] = useState('');
  const stageStartRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

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
    intervalRef.current = setInterval(() => {
      if (stageIdx < STAGE_ORDER.length - 1) {
        const doneStage = STAGE_ORDER[stageIdx];
        const elapsed = Date.now() - stageStartRef.current;
        setCompletedStages((prev) => [...prev, doneStage]);
        setStageElapsed((prev) => ({ ...prev, [doneStage]: elapsed - (prev[doneStage] ?? 0) }));
        stageIdx++;
        setCurrentStage(STAGE_ORDER[stageIdx]);
      }
    }, 800);

    try {
      // 解析用户粘贴的最新消息（每行一条），优先于实时抓取
      const trimmed = newsText.trim();
      const newsItems: NewsItem[] | undefined = trimmed
        ? trimmed
            .split('\n')
            .map((line, i) => ({
              id: `pasted-${i}`,
              title: line.trim(),
              publishedAt: new Date().toISOString(),
            }))
            .filter((n) => n.title.length > 0)
        : undefined;

      const result = await runQuantAnalysis({
        strategy: config,
        useNews: useNews || !newsItems,
        newsItems,
      });
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      // 标记所有阶段完成
      const allElapsed: Record<string, number> = {};
      const totalMs = Date.now() - stageStartRef.current;
      STAGE_ORDER.forEach((s) => {
        allElapsed[s] = Math.round((totalMs / STAGE_ORDER.length) * (0.8 + Math.random() * 0.4));
      });
      setCompletedStages([...STAGE_ORDER]);
      setStageElapsed(allElapsed);
      setCurrentStage(null);
      setReport(result);
    } catch {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
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

        <div className="quant-news-controls">
          <h3 className="quant-sidebar-title">最新消息</h3>
          <label className="quant-checkbox">
            <input
              type="checkbox"
              checked={useNews}
              disabled={loading}
              onChange={(e) => setUseNews(e.target.checked)}
            />
            启用最新消息情绪叠加（实时抓取）
          </label>
          <p className="quant-news-hint">或粘贴最新消息（每行一条，自动情绪打分）：</p>
          <textarea
            className="quant-news-textarea"
            placeholder={'例如：\n公司中标大单，金额超去年营收\n机构下调评级至中性\n新产品量价齐升'}
            value={newsText}
            disabled={loading}
            onChange={(e) => setNewsText(e.target.value)}
            rows={5}
          />
        </div>
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
            {report.newsSentiment?.hasNews && (
              <>
                <NewsSentimentCard data={report.newsSentiment} />
                {report.backtestBaseline && (
                  <NewsBacktestCompare aware={report.backtest} baseline={report.backtestBaseline} />
                )}
              </>
            )}
            <BacktestChart data={report.backtest} />
            <DataQualityPanel data={report.dataQuality} />
            <AuditPanel data={report.audit} />
            <OptimizationPanel data={report.optimization} />
          </>
        )}

        {!loading && !report && !error && (
          <div className="quant-empty">
            <svg
              className="quant-empty-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 20h18" />
              <path d="M6 20v-7" />
              <path d="M11 20V6" />
              <path d="M16 20v-4" />
              <path d="M21 20V10" />
            </svg>
            <p className="quant-empty-text">
              配置左侧策略后点击「开始研究」，将依次完成数据获取、质量校验、回测与审计，输出完整量化报告
            </p>
            <p className="quant-empty-hint">
              支持均线交叉 / 动量 / 均值回归策略，可叠加最新消息情绪与 A 股真实交易费率
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

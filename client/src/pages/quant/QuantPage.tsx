import { useState, useRef, useCallback, useEffect } from 'react';
import StrategyInput from './StrategyInput';
import BacktestChart from './BacktestChart';
import DataQualityPanel from './DataQualityPanel';
import AuditPanel from './AuditPanel';
import OptimizationPanel from './OptimizationPanel';
import ReportSummary from './ReportSummary';
import FactorPanel from './FactorPanel';
import CompositeBatchPanel from './CompositeBatchPanel';
import CrossSectionPanel from './CrossSectionPanel';
import NewsSentimentCard from '../../components/NewsSentimentCard';
import { runQuantAnalysis } from '../../api/client';
import { useToast } from '../../components/Toast';
import type { StrategyConfig, QuantResearchReport, NewsItem } from './types';

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
      {aware.factorAware && (
        <p className="news-compare-note">
          组合 alpha 信号叠加已生效（综合方向 {aware.factorDirection}
          {typeof aware.factorPosture === 'number' &&
            `，姿态仓位系数 ${(aware.factorPosture * 100).toFixed(0)}%`}
          ）。与新闻姿态取较小值缩放仓位，long-only 下看空不建仓。
        </p>
      )}
    </div>
  );
}

export default function QuantPage() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<QuantResearchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useNews, setUseNews] = useState(false);
  const [newsText, setNewsText] = useState('');
  /** 量化页模式：单股完整研究（回测+审计+优化）| 多股组合 alpha 批量测算 | 行业截面因子评估 */
  const [mode, setMode] = useState<'single' | 'batch' | 'cross'>('single');
  /** 研究已耗时（秒）：真实计时，不伪造阶段进度 */
  const [elapsedSec, setElapsedSec] = useState(0);
  const startAtRef = useRef<number>(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTicker = useCallback(() => {
    if (tickerRef.current) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  }, []);

  useEffect(() => stopTicker, [stopTicker]);

  const handleStart = useCallback(
    async (config: StrategyConfig) => {
      setLoading(true);
      setError(null);
      setReport(null);
      setElapsedSec(0);
      startAtRef.current = Date.now();
      stopTicker();
      tickerRef.current = setInterval(() => {
        setElapsedSec(Math.round((Date.now() - startAtRef.current) / 1000));
      }, 1000);

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
        setReport(result);
        showToast(`研究完成，总耗时 ${((Date.now() - startAtRef.current) / 1000).toFixed(0)} 秒`);
      } catch {
        setError('量化研究失败，请检查后端服务是否启动');
      } finally {
        stopTicker();
        setLoading(false);
      }
      // 依赖 newsText/useNews：此前依赖数组为空，闭包永远捕获首次渲染值，
      // 用户粘贴的最新消息与"启用情绪叠加"开关被静默忽略
    },
    [newsText, useNews, showToast, stopTicker],
  );

  return (
    <div className="quant-page">
      <aside className="quant-sidebar">
        <div className="quant-mode-switch" role="group" aria-label="量化模式">
          <button
            type="button"
            className={`quant-mode ${mode === 'single' ? 'active' : ''}`}
            onClick={() => setMode('single')}
          >
            单股研究
          </button>
          <button
            type="button"
            className={`quant-mode ${mode === 'batch' ? 'active' : ''}`}
            onClick={() => setMode('batch')}
          >
            批量测算
          </button>
          <button
            type="button"
            className={`quant-mode ${mode === 'cross' ? 'active' : ''}`}
            onClick={() => setMode('cross')}
          >
            截面因子
          </button>
        </div>

        {mode === 'single' ? (
          <>
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
                placeholder={
                  '例如：\n公司中标大单，金额超去年营收\n机构下调评级至中性\n新产品量价齐升'
                }
                value={newsText}
                disabled={loading}
                onChange={(e) => setNewsText(e.target.value)}
                rows={5}
              />
            </div>
          </>
        ) : (
          <p className="quant-mode-hint">
            {mode === 'batch'
              ? '在右侧输入多只股票代码，逐只计算方向性组合 alpha（时间序列 IC 口径，只算因子预测力与方向信号，不跑回测 / 审计 / 优化）。'
              : '选择行业板块（或手输多只代码）做横截面因子评估：逐日截面 IC + 分层收益 + 样本外复核，检验因子在行业内「谁高谁低」的选股区分力。'}
          </p>
        )}
      </aside>

      <div className="quant-main">
        {/* 三个模式常驻挂载（隐藏而非卸载）：批量测算/截面评估跑了数十秒的结果，
            不该因切去别的模式看一眼而丢失 */}
        <div className="quant-mode-pane" hidden={mode !== 'batch'}>
          <CompositeBatchPanel />
        </div>
        <div className="quant-mode-pane" hidden={mode !== 'cross'}>
          <CrossSectionPanel active={mode === 'cross'} />
        </div>
        <div className="quant-mode-pane" hidden={mode !== 'single'}>
          {error && <div className="error-banner">{error}</div>}

          {loading && (
            <div className="card quant-panel">
              <h3 className="quant-panel-title">研究进行中</h3>
              <p className="quant-elapsed">
                数据获取 → 质量检查 → 回测 → 审计 在一次请求内连续完成，完成后一次性出报告。
              </p>
              <p className="quant-elapsed quant-elapsed-time">
                已耗时 <b>{elapsedSec}</b> 秒（通常 10–40 秒，叠加新闻抓取时更长）
              </p>
            </div>
          )}

          {report && !loading && (
            <>
              <ReportSummary data={report} />
              {report.newsSentiment?.hasNews && (
                <>
                  <NewsSentimentCard data={report.newsSentiment} />
                  {report.backtestBaseline && (
                    <NewsBacktestCompare
                      aware={report.backtest}
                      baseline={report.backtestBaseline}
                    />
                  )}
                </>
              )}
              <BacktestChart data={report.backtest} />
              <DataQualityPanel data={report.dataQuality} />
              <AuditPanel data={report.audit} />
              <OptimizationPanel data={report.optimization} />
              {report.priceVolumeFactors && report.priceVolumeFactors.length > 0 && (
                <FactorPanel
                  data={report.priceVolumeFactors}
                  compositeAlpha={report.compositeAlpha}
                />
              )}
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
    </div>
  );
}

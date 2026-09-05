import { useState, useEffect, useCallback } from 'react';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  runWatchlistNewsBacktest,
  monitorWatchlist,
} from '../../api/client';
import type { WatchlistNewsBacktestReport, WatchlistAlert } from '../../types';
import { normalizeApiError } from '../../api/client';
import NewsPostureHeatBar from '../../components/NewsPostureHeatBar';
import StockSearchInput from '../../components/StockSearchInput';
import { useToast } from '../../components/Toast';

function polarityLabel(p: number): { text: string; cls: string } {
  if (p > 0.15) return { text: '偏多', cls: 'bull' };
  if (p < -0.15) return { text: '偏空', cls: 'bear' };
  return { text: '中性', cls: 'neutral' };
}

/** 预警级别 → 文案与样式（A 股习惯：红=看多、绿=看空） */
const ALERT_LEVEL: Record<WatchlistAlert['level'], { text: string; cls: string }> = {
  'strong-bull': { text: '强烈看多', cls: 'alert-bull' },
  'strong-bear': { text: '强烈看空', cls: 'alert-bear' },
  'high-impact': { text: '高影响新闻', cls: 'alert-impact' },
};

export default function WatchlistPage() {
  const { showToast } = useToast();
  const [codes, setCodes] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loadingList, setLoadingList] = useState(false);
  const [running, setRunning] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [report, setReport] = useState<WatchlistNewsBacktestReport | null>(null);
  const [alerts, setAlerts] = useState<WatchlistAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await getWatchlist();
      setCodes(res.codes ?? []);
    } catch (err) {
      setError(normalizeApiError(err, '获取自选股失败').message);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const handleAdd = useCallback(async (code: string, name: string) => {
    const c = code.trim();
    if (!c) return;
    setError(null);
    try {
      const res = await addToWatchlist(c);
      setCodes(res.codes ?? []);
      setNames((prev) => ({ ...prev, [c]: name || prev[c] || c }));
    } catch (err) {
      setError(normalizeApiError(err, '添加失败').message);
    }
  }, []);

  const handleRemove = useCallback(async (code: string) => {
    setError(null);
    try {
      const res = await removeFromWatchlist(code);
      setCodes(res.codes ?? []);
    } catch (err) {
      setError(normalizeApiError(err, '移除失败').message);
    }
  }, []);

  const handleRun = useCallback(async () => {
    if (codes.length === 0) {
      setError('自选股清单为空，请先添加股票');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await runWatchlistNewsBacktest(codes);
      setReport(res);
    } catch (err) {
      setError(normalizeApiError(err, '批量回测失败').message);
    } finally {
      setRunning(false);
    }
  }, [codes]);

  /** 监控异动：重跑批量新闻回测并检出预警（复用后端 detectAlerts） */
  const handleMonitor = useCallback(async () => {
    if (codes.length === 0) {
      setError('自选股清单为空，请先添加股票');
      return;
    }
    setMonitoring(true);
    setError(null);
    try {
      const res = await monitorWatchlist();
      setAlerts(res.alerts);
      showToast(
        res.alerts.length > 0 ? `发现 ${res.alerts.length} 条异动预警` : '本轮无异动预警',
        res.alerts.length > 0 ? 'info' : 'success',
      );
    } catch (err) {
      setError(normalizeApiError(err, '自选股监控失败').message);
    } finally {
      setMonitoring(false);
    }
  }, [codes, showToast]);

  return (
    <div className="watchlist-page">
      <div className="watchlist-header">
        <h2>自选股 / 持仓监控</h2>
        <p className="watchlist-sub">
          添加关注的股票，一键批量回测最新消息对仓位的影响，并监控异动预警。
        </p>
      </div>

      <div className="watchlist-add">
        <StockSearchInput
          onSelect={(code, name) => handleAdd(code, name)}
          actionLabel="添加"
          disabled={loadingList}
          placeholder="输入股票代码或名称，如 600519 / 贵州茅台"
          ariaLabel="自选股搜索"
        />
        <button
          className="btn-primary watchlist-run"
          onClick={handleRun}
          disabled={running || codes.length === 0}
        >
          {running ? '回测中…' : `批量含最新消息回测（${codes.length}）`}
        </button>
        <button
          className="btn-ghost watchlist-monitor"
          onClick={handleMonitor}
          disabled={monitoring || codes.length === 0}
          title="重跑新闻回测并检出强烈看多/看空/高影响预警"
        >
          {monitoring ? '监控中…' : '监控异动'}
        </button>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner-text">{error}</span>
        </div>
      )}

      <div className="watchlist-list">
        {codes.length === 0 ? (
          <div className="watchlist-empty">
            <p className="watchlist-empty-title">还没有关注的股票</p>
            <p className="watchlist-empty-hint">
              在上方输入股票代码或名称（如 600519 / 贵州茅台）添加，即可批量回测与异动监控。
            </p>
          </div>
        ) : (
          <ul className="watchlist-items">
            {codes.map((code) => (
              <li key={code} className="watchlist-item">
                <span className="watchlist-name">
                  {!names[code] || names[code] === code ? '' : names[code]}
                </span>
                <span className="watchlist-code">{code}</span>
                <button
                  className="watchlist-remove"
                  onClick={() => handleRemove(code)}
                  aria-label={
                    names[code] && names[code] !== code
                      ? `移除 ${names[code]}（${code}）`
                      : `移除 ${code}`
                  }
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {alerts && (
        <div className="watchlist-alerts">
          <div className="section-title">异动预警</div>
          {alerts.length === 0 ? (
            <div className="watchlist-alerts-empty">
              本轮监控未发现异动（阈值：|极性|≥0.5 或影响强度≥0.6）。
            </div>
          ) : (
            <ul className="watchlist-alerts-list">
              {alerts.map((a, i) => {
                const lv = ALERT_LEVEL[a.level];
                return (
                  <li key={`${a.code}-${i}`} className={`watchlist-alert ${lv.cls}`}>
                    <span className="watchlist-alert-level">{lv.text}</span>
                    <span className="watchlist-alert-stock">
                      {a.name ?? ''} <b>{a.code}</b>
                    </span>
                    <span className="watchlist-alert-detail">{a.detail}</span>
                    <span className="watchlist-alert-meta">
                      极性 {a.polarity.toFixed(2)} · 影响 {(a.weightedImpact * 100).toFixed(0)}%
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {report && (
        <div className="watchlist-report">
          <div className="watchlist-report-head">
            <span>
              共 {report.count} 只，命中最新消息 {report.withNewsCount} 只
            </span>
            <span className="watchlist-report-time">
              {new Date(report.generatedAt).toLocaleString('zh-CN')}
            </span>
          </div>
          <NewsPostureHeatBar report={report} />

          <div className="watchlist-table-wrap">
            <table className="watchlist-table">
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>新闻</th>
                  <th>最优策略</th>
                  <th>含消息收益</th>
                  <th>含消息夏普</th>
                  <th>新闻姿态</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((row) => {
                  const news = row.newsSentiment;
                  const lab = news ? polarityLabel(news.polarity) : null;
                  const best = row.bestStrategy;
                  return (
                    <tr key={row.code}>
                      <td className="mono">{row.code}</td>
                      <td>{row.name ?? '—'}</td>
                      <td>
                        {lab ? (
                          <span className={`news-badge news-badge--${lab.cls}`}>
                            {lab.text} {news!.polarity.toFixed(2)}
                          </span>
                        ) : (
                          <span className="muted">无</span>
                        )}
                      </td>
                      <td>{best?.strategyType ?? '—'}</td>
                      <td
                        className={
                          best?.newsAware
                            ? best.newsAware.totalReturn >= 0
                              ? 'val-positive'
                              : 'val-negative'
                            : ''
                        }
                      >
                        {best?.newsAware
                          ? `${best.newsAware.totalReturn >= 0 ? '+' : ''}${best.newsAware.totalReturn.toFixed(1)}%`
                          : '—'}
                      </td>
                      <td>{best?.newsAware ? best.newsAware.sharpeRatio.toFixed(2) : '—'}</td>
                      <td>
                        {best?.newsAware ? `${(best.newsAware.posture * 100).toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.results.some((r) => r.simulatedKline) && (
            <p className="watchlist-note">
              注：部分标的因行情接口不可达，回测使用模拟 K 线，结果仅供参考。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

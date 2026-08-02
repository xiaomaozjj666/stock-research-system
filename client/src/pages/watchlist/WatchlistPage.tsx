import { useState, useEffect, useCallback } from 'react';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  runWatchlistNewsBacktest,
} from '../../api/client';
import type { WatchlistNewsBacktestReport } from '../../types';
import { normalizeApiError } from '../../api/client';
import NewsPostureHeatBar from '../../components/NewsPostureHeatBar';

function polarityLabel(p: number): { text: string; cls: string } {
  if (p > 0.15) return { text: '偏多', cls: 'bull' };
  if (p < -0.15) return { text: '偏空', cls: 'bear' };
  return { text: '中性', cls: 'neutral' };
}

export default function WatchlistPage() {
  const [codes, setCodes] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<WatchlistNewsBacktestReport | null>(null);
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

  const handleAdd = useCallback(async () => {
    const code = input.trim();
    if (!/^\d{6}$/.test(code)) {
      setError('请输入有效的 6 位股票代码');
      return;
    }
    setError(null);
    try {
      const res = await addToWatchlist(code);
      setCodes(res.codes ?? []);
      setInput('');
    } catch (err) {
      setError(normalizeApiError(err, '添加失败').message);
    }
  }, [input]);

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

  return (
    <div className="watchlist-page">
      <div className="watchlist-header">
        <h2>自选股 / 持仓监控</h2>
        <p className="watchlist-sub">
          添加关注的股票，一键对全部自选股批量运行「含最新消息回测」（新闻情绪叠加仓位）。
        </p>
      </div>

      <div className="watchlist-add">
        <input
          className="watchlist-input"
          placeholder="输入 6 位代码，如 600519"
          value={input}
          maxLength={6}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
        />
        <button className="btn-primary" onClick={handleAdd} disabled={loadingList}>
          添加
        </button>
        <button
          className="btn-primary watchlist-run"
          onClick={handleRun}
          disabled={running || codes.length === 0}
        >
          {running ? '回测中…' : `批量含最新消息回测（${codes.length}）`}
        </button>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner-text">{error}</span>
        </div>
      )}

      <div className="watchlist-list">
        {codes.length === 0 ? (
          <div className="watchlist-empty">暂无自选股，先在上方添加。</div>
        ) : (
          <ul className="watchlist-items">
            {codes.map((code) => (
              <li key={code} className="watchlist-item">
                <span className="watchlist-code">{code}</span>
                <button
                  className="watchlist-remove"
                  onClick={() => handleRemove(code)}
                  aria-label={`移除 ${code}`}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

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
                        {best?.newsAware
                          ? `${(best.newsAware.posture * 100).toFixed(0)}%`
                          : '—'}
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

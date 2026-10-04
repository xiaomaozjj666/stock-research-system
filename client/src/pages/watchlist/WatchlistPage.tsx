import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AnalysisCancelledError,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  runWatchlistNewsBacktest,
  monitorWatchlist,
  fetchWatchlistAlerts,
} from '../../api/client';
import type { WatchlistNewsBacktestReport, WatchlistAlert } from '../../types';
import { normalizeApiError } from '../../api/client';
import { signCls } from '../../lib/colors';
import NewsPostureHeatBar from '../../components/NewsPostureHeatBar';
import StockSearchInput from '../../components/StockSearchInput';
import { useToast } from '../../components/Toast';
import { useQuery } from '../../hooks/useQuery';

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

/**
 * 异动条目列表：本次监控结果与「最近一次」落盘快照共用同一套渲染与类名，
 * 避免为回看再造一套样式（同一份数据换个入口展示而已）。
 */
function AlertList({ alerts }: { alerts: WatchlistAlert[] }) {
  return (
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
  );
}

/** 时间戳 → 本地可读文本（快照来自服务端落盘，时间可能已过去数天） */
function formatMonitorTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN');
}

/**
 * 把失败原因写成"说人话 + 给出下一步"的整句。
 * 先经 normalizeApiError 兜底翻译（Network Error / 超时 → 中文），再拼上"哪个动作失败"，
 * 避免用户只看到一句无从下手的英文错误。若原始信息是英文，只放 title 做技术细节。
 */
function describeError(
  err: unknown,
  prefix: string,
  fallback: string,
): { text: string; detail?: string } {
  const raw = err instanceof Error ? err.message.trim() : '';
  const message = /[\u4e00-\u9fa5]/.test(raw) ? raw : normalizeApiError(err, fallback).message;
  return { text: `${prefix}${message}`, detail: raw && raw !== message ? raw : undefined };
}

/**
 * 带元信息的错误：出错的操作决定重试按钮的行为。
 * retryable=false 的操作（添加/移除）缺少原始入参，无法安全重放，故不给重试按钮，
 * 错误保留到下一次成功操作为止。
 */
type WatchlistError = {
  text: string;
  detail?: string;
  action: WatchlistErrorAction;
  retryable: boolean;
};
type WatchlistErrorAction = 'load' | 'run' | 'monitor' | 'add' | 'remove' | 'empty';

export default function WatchlistPage() {
  const { showToast } = useToast();
  const [names, setNames] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [report, setReport] = useState<WatchlistNewsBacktestReport | null>(null);
  /** 列表真实内容是否已被可靠取回：添加/移除/回测/监控等动作失败时，
      不能因此把已有的股票列表一并藏起来 */
  const [listKnown, setListKnown] = useState(false);
  const [error, setError] = useState<WatchlistError | null>(null);
  /** 在途批量回测/监控请求的中止器：两者都是分钟级，用户应能中途撤回 */
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 清单读取交给 useQuery：挂载即拉、乱序防护与卸载中止由 hook 统一兜住。
   * 添加/移除后用 setData 就地同步服务端返回的新清单（与 hook 同一份状态，
   * 不再另开一个 codes state，避免两份列表各说各话）。
   */
  const handleListSettled = useCallback((err: unknown) => {
    if (err) {
      // 失败必须留痕：此前只 setError 而 codes 仍是空数组，页面会渲染成"还没有关注的股票"
      setError({
        ...describeError(err, '自选股加载失败：', '请确认后端服务已启动后重试'),
        action: 'load',
        retryable: true,
      });
      return;
    }
    // 只有本轮成功才清错：重试进行中旧横幅要留着（用户需要看到上次失败尚未解决），
    // 而"清单出来了 + 横幅还挂着"的中间帧由 onSettled 与数据同批更新来避免
    setError(null);
    setListKnown(true);
  }, []);

  const listQuery = useQuery(() => getWatchlist(), [], { onSettled: handleListSettled });
  const {
    data: listData,
    loading: loadingList,
    reload: reloadList,
    setData: setListData,
  } = listQuery;
  /**
   * codes 必须 memo：data 未就绪时 `?? []` 每帧都是新数组，
   * 依赖 codes 的 useCallback 会因此每帧重建（回调身份不稳 = 子组件白渲染）。
   */
  const codes = useMemo(() => listData?.codes ?? [], [listData]);

  // 卸载时中止在途请求，避免向已卸载组件 setState
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const loadList = useCallback(() => {
    reloadList();
  }, [reloadList]);

  /**
   * 挂载时读回「最近一次监控」：这是复访的理由——不点任何按钮也能看到上次的异动。
   * 同样是"挂载即拉一次"模式，故一并交给 useQuery：它顺带补上了原实现缺失的
   * 卸载中止（原先只有 alive 标志位，不中断在途请求）。
   */
  const alertsQuery = useQuery(() => fetchWatchlistAlerts(), []);
  const {
    data: alertsData,
    error: alertsError,
    setData: setAlertsData,
    clearError: clearAlertsError,
  } = alertsQuery;
  const snapshot = alertsData ?? null;
  // 快照读失败的原因：与「从未监控过」区分开，否则会误导用户以为预警是空的
  const snapshotError = alertsError
    ? describeError(alertsError, '最近监控记录读取失败：', '请稍后重试').text
    : null;

  const handleAdd = useCallback(
    async (code: string, name: string) => {
      const c = code.trim();
      if (!c) return;
      try {
        const res = await addToWatchlist(c);
        setListData({ codes: res.codes ?? [] });
        setNames((prev) => ({ ...prev, [c]: name || prev[c] || c }));
        setListKnown(true);
        setError(null);
      } catch (err) {
        setError({
          ...describeError(err, '添加自选股失败：', '请确认后端服务已启动后重试'),
          action: 'add',
          retryable: false,
        });
      }
    },
    [setListData],
  );

  const handleRemove = useCallback(
    async (code: string) => {
      try {
        const res = await removeFromWatchlist(code);
        setListData({ codes: res.codes ?? [] });
        setError(null);
      } catch (err) {
        setError({
          ...describeError(err, '移除自选股失败：', '请稍后重试'),
          action: 'remove',
          retryable: false,
        });
      }
    },
    [setListData],
  );

  const handleRun = useCallback(async () => {
    if (codes.length === 0) {
      // 空清单不是"请求失败"，单独归类：只提示原因，不劫持列表区的渲染
      setError({ text: '自选股清单为空，请先添加股票', action: 'empty', retryable: false });
      return;
    }
    setRunning(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await runWatchlistNewsBacktest(codes, controller.signal);
      setReport(res);
    } catch (err) {
      if (err instanceof AnalysisCancelledError) {
        showToast('已取消本次回测');
      } else {
        setError({
          ...describeError(err, '批量回测失败：', '请确认后端服务已启动后重试'),
          action: 'run',
          retryable: true,
        });
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }, [codes, showToast]);

  /** 监控异动：重跑批量新闻回测并检出预警（复用后端 detectAlerts） */
  const handleMonitor = useCallback(async () => {
    if (codes.length === 0) {
      // 空清单不是"请求失败"，单独归类：只提示原因，不劫持列表区的渲染
      setError({ text: '自选股清单为空，请先添加股票', action: 'empty', retryable: false });
      return;
    }
    setMonitoring(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await monitorWatchlist(controller.signal);
      // 服务端已把同一份结果落盘：直接用它刷新常驻卡片，本地不再另存一份 alerts
      // （写进 alertsQuery 的 data，并清掉上一轮"快照读取失败"——数据已拿到，旧错不再成立）
      setAlertsData(res);
      clearAlertsError();
      showToast(
        res.alerts.length > 0 ? `发现 ${res.alerts.length} 条异动预警` : '本轮无异动预警',
        res.alerts.length > 0 ? 'info' : 'success',
      );
    } catch (err) {
      if (err instanceof AnalysisCancelledError) {
        showToast('已取消本次监控');
      } else {
        setError({
          ...describeError(err, '自选股监控失败：', '请确认后端服务已启动后重试'),
          action: 'monitor',
          retryable: true,
        });
      }
    } finally {
      abortRef.current = null;
      setMonitoring(false);
    }
  }, [codes, showToast, setAlertsData, clearAlertsError]);

  /** 重试：按错误来源重跑同一个操作（列表加载 / 批量回测 / 监控） */
  const handleRetry = useCallback(() => {
    if (!error) return;
    if (error.action === 'load') loadList();
    else if (error.action === 'run') handleRun();
    else if (error.action === 'monitor') handleMonitor();
  }, [error, loadList, handleRun, handleMonitor]);

  return (
    <div className="watchlist-page">
      <div className="watchlist-header">
        <h2>自选股 / 持仓监控</h2>
        <p className="watchlist-sub">
          添加关注的股票，一键批量回测最新消息对仓位的影响，并监控异动预警。
        </p>
      </div>

      {/* 最近监控常驻卡片：读服务端落盘快照，页面顶部即可回看上次异动（刷新/复访不丢） */}
      <div className="watchlist-alerts">
        <div className="section-title">异动预警</div>
        {snapshot && snapshot.generatedAt ? (
          <>
            <p className="watchlist-alert-meta">
              {`最近监控：${formatMonitorTime(snapshot.generatedAt)}｜${snapshot.alerts.length} 条异动`}
              {` · 覆盖 ${snapshot.monitored} 只`}
            </p>
            {snapshot.alerts.length === 0 ? (
              <div className="watchlist-alerts-empty">
                本轮监控未发现异动（阈值：|极性|≥0.5 或影响强度≥0.6）。
              </div>
            ) : (
              <AlertList alerts={snapshot.alerts} />
            )}
          </>
        ) : (
          <div className="watchlist-alerts-empty">
            {snapshotError ??
              '尚未监控过。点击「监控异动」跑一次，结果会自动留存，刷新后仍可回看。'}
          </div>
        )}
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
        {(running || monitoring) && (
          <button className="btn-ghost watchlist-cancel" onClick={handleCancel}>
            {running ? '取消回测' : '取消监控'}
          </button>
        )}
      </div>

      {/* 错误优先于空态：首次加载就失败时，codes 为空并不代表"没有关注股票" */}
      {error && (
        <div className="error-banner" role="alert">
          <div className="error-banner-body">
            <span className="error-banner-icon" aria-hidden="true">
              !
            </span>
            {/* 原始英文错误只放在 title 里做技术细节，不直接堆给用户 */}
            <span className="error-banner-text" title={error.detail ?? undefined}>
              {error.text}
            </span>
          </div>
          {error.retryable && (
            <button className="error-banner-retry" onClick={handleRetry}>
              重试
            </button>
          )}
        </div>
      )}

      <div className="watchlist-list">
        {/* 空态只允许出现在"清单确实已取回且为空"时：
            初次加载（listKnown=false 且无错误）一律走加载占位，避免首屏闪一句
            「还没有关注的股票」；读取失败时语义由上方错误横幅表达，这里不再兜底文案。 */}
        {!listKnown && !error ? (
          <div className="watchlist-empty">加载中…</div>
        ) : codes.length > 0 ? (
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
        ) : listKnown ? (
          <div className="watchlist-empty">
            <p className="watchlist-empty-title">还没有关注的股票</p>
            <p className="watchlist-empty-hint">
              在上方输入股票代码或名称（如 600519 / 贵州茅台）添加，即可批量回测与异动监控。
            </p>
          </div>
        ) : null}
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
                      <td className={best?.newsAware ? signCls(best.newsAware.totalReturn) : ''}>
                        {best?.newsAware
                          ? `${best.newsAware.totalReturn > 0 ? '+' : ''}${best.newsAware.totalReturn.toFixed(1)}%`
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

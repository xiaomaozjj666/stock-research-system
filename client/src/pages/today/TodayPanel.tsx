import { useCallback, useEffect, useState } from 'react';
import {
  fetchHistoryList,
  fetchWatchlistAlerts,
  getResearchDigests,
  getWatchlist,
  type HistoryListItem,
  type ResearchDigest,
  type WatchlistAlertsSnapshot,
} from '../../api/client';
import { normalizeApiError } from '../../api/client';

/**
 * 「今日」聚合入口。
 * ----------------------------------------------------------------------------
 * 背景：此前系统的日常价值分散在三个页面里，且**没有任何"今天该看什么"的入口**——
 * 异动预警要手动点监控、简报埋在量化页深处、关注股的评分变化要看历史页。
 * 这里把三者聚到一屏：自选股异动（持久化的最近一次监控）、关注股评分变化、
 * 最近一次研究简报。
 *
 * 三个数据源彼此独立：任一失败只影响自己那一块（显示原因 + 该块可重试），
 * 不影响其余两块的展示——聚合页最忌讳"一个接口挂了整页空白"。
 */

interface AlertItem {
  code: string;
  name?: string | null;
  level?: string;
  detail?: string;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间：让"今天有没有新东西"一眼可判断 */
function relativeFrom(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMin = Math.floor((Date.now() - t) / 60_000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  return `${Math.floor(diffHour / 24)} 天前`;
}

export default function TodayPanel() {
  const [alerts, setAlerts] = useState<WatchlistAlertsSnapshot | null>(null);
  const [digests, setDigests] = useState<ResearchDigest[]>([]);
  const [changes, setChanges] = useState<
    { code: string; name: string; delta: number; rating: string; date: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const failedParts: Record<string, boolean> = {};

    // 三块各自独立取数：用 allSettled，避免一个失败拖垮整页
    const [alertsRes, digestsRes, watchlistRes, historyRes] = await Promise.allSettled([
      fetchWatchlistAlerts(),
      getResearchDigests(1),
      getWatchlist(),
      fetchHistoryList(50),
    ]);

    if (alertsRes.status === 'fulfilled') setAlerts(alertsRes.value);
    else {
      setAlerts(null);
      failedParts.alerts = true;
    }

    if (digestsRes.status === 'fulfilled') setDigests(digestsRes.value.items ?? []);
    else {
      setDigests([]);
      failedParts.digest = true;
    }

    if (watchlistRes.status === 'fulfilled' && historyRes.status === 'fulfilled') {
      const codes = new Set(watchlistRes.value.codes ?? []);
      const items: HistoryListItem[] = historyRes.value ?? [];
      const rows: { code: string; name: string; delta: number; rating: string; date: string }[] =
        [];
      for (const item of items) {
        if (!codes.has(item.stockCode)) continue;
        const timeline = item.timeline ?? [];
        if (timeline.length < 2) continue; // 只有一个点算不出变化，不臆造
        const last = timeline[timeline.length - 1];
        const prev = timeline[timeline.length - 2];
        const delta = Math.round((last.score - prev.score) * 100) / 100;
        if (delta === 0 && last.rating === prev.rating) continue; // 无变化不进"今日"
        rows.push({
          code: item.stockCode,
          name: item.stockName || item.stockCode,
          delta,
          rating: last.rating,
          date: last.date,
        });
      }
      rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      setChanges(rows);
    } else {
      setChanges([]);
      failedParts.changes = true;
    }

    setFailed(failedParts);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const alertItems = (alerts?.alerts ?? []) as unknown as AlertItem[];
  const digest = digests[0];

  return (
    <div className="card">
      <div className="section-title">今日</div>
      <p className="history-sub">
        自选股异动、关注股观点变化与最近一次研究简报的汇总。数据来自各自最近一次运行结果，
        不会在这里触发新的抓取。
      </p>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {/* 一、自选股异动（最近一次监控快照，已落盘，刷新后仍在） */}
      <div className="section-title">自选股异动</div>
      {failed.alerts ? (
        <div className="watchlist-alerts-empty">
          异动数据读取失败：{normalizeApiError(null, '请确认后端服务已启动').message}
        </div>
      ) : !alerts || alerts.generatedAt === null ? (
        <div className="watchlist-alerts-empty">
          尚未监控过。到「自选股」页点一次「监控异动」即可留存结果，之后这里会常驻显示。
        </div>
      ) : (
        <>
          <p className="watchlist-alert-meta">
            最近监控：{formatDateTime(alerts.generatedAt)}（{relativeFrom(alerts.generatedAt)}
            ）｜覆盖 {alerts.monitored} 只｜{alertItems.length} 条异动
          </p>
          {alertItems.length === 0 ? (
            <div className="watchlist-alerts-empty">本次监控未发现异动。</div>
          ) : (
            <ul className="watchlist-alerts-list">
              {alertItems.slice(0, 5).map((a, i) => (
                <li key={`${a.code}-${i}`}>
                  <span className="watchlist-alert-stock">
                    {a.name || a.code}（{a.code}）
                  </span>
                  <span className="watchlist-alert-detail">{a.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* 二、关注股观点变化（对比最近两次评分的差，无变化则不列） */}
      <div className="section-title" style={{ marginTop: 20 }}>
        关注股观点变化
      </div>
      {failed.changes ? (
        <div className="watchlist-alerts-empty">观点变化读取失败：请确认后端服务已启动后重试。</div>
      ) : changes.length === 0 ? (
        <div className="watchlist-alerts-empty">
          自选股暂无明显观点变化（同一标的至少要有两次分析才形成对比）。
        </div>
      ) : (
        <ul className="watchlist-alerts-list">
          {changes.slice(0, 8).map((c) => (
            <li key={c.code}>
              <span className="watchlist-alert-stock">
                {c.name}（{c.code}）
              </span>
              <span
                className={c.delta > 0 ? 'val-positive' : c.delta < 0 ? 'val-negative' : ''}
                title={`最近两次评分对比（${c.date}）`}
              >
                {c.delta > 0 ? `▲ +${c.delta}` : c.delta < 0 ? `▼ ${c.delta}` : '— 持平'}
              </span>
              <span className="watchlist-alert-meta">当前评级：{c.rating}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 三、最近一次研究简报 */}
      <div className="section-title" style={{ marginTop: 20 }}>
        最近研究简报
      </div>
      {failed.digest ? (
        <div className="watchlist-alerts-empty">简报读取失败：请确认后端服务已启动后重试。</div>
      ) : !digest ? (
        <div className="watchlist-alerts-empty">
          还没有简报。可在「量化研究」页手动生成一次，或设置 QUANT_DIGEST_INTERVAL_HOURS
          让它按小时自动生成。
        </div>
      ) : (
        <p className="watchlist-alert-meta">
          生成于 {formatDateTime(digest.createdAt)}（{relativeFrom(digest.createdAt)}）｜初筛命中{' '}
          {digest.screener?.hitCount ?? 0} 只
          {digest.screener?.topHits && digest.screener.topHits.length > 0
            ? `｜代表：${digest.screener.topHits
                .slice(0, 3)
                .map((h) => `${h.name}(${h.code})`)
                .join('、')}`
            : ''}
        </p>
      )}
    </div>
  );
}

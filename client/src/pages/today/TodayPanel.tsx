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

/** 统一加载态：请求在途时必须与「确实没有内容」区分开（见下方三块正文的判据顺序） */
function LoadingLine({ label }: { label: string }) {
  return (
    <div className="watchlist-alerts-empty" role="status">
      {label}加载中…
    </div>
  );
}

/** 失败文案：翻译**真实 reason**（500/超时/404 各给各自的原因），不凭空断言「后端没启动」 */
function failureText(reason: unknown, subject: string, fallback: string): string {
  return `${subject}读取失败：${normalizeApiError(reason, fallback).message}`;
}

export default function TodayPanel() {
  const [alerts, setAlerts] = useState<WatchlistAlertsSnapshot | null>(null);
  const [digests, setDigests] = useState<ResearchDigest[]>([]);
  const [changes, setChanges] = useState<
    { code: string; name: string; delta: number; rating: string; date: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  /**
   * 失败块的**真实 reason**（Promise.allSettled 的 rejected 值）。
   * 此前只存布尔、把 reason 丢掉，最后用 `normalizeApiError(null, …)` 造文案——
   * 而 client.ts 对「无 response」恒返回「无法连接后端服务」，于是 500 / 超时 / 404
   * 全都被报成「后端没启动」，把用户引向完全错误的排查方向。
   */
  const [failed, setFailed] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const failedParts: Record<string, unknown> = {};

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
      failedParts.alerts = alertsRes.reason;
    }

    if (digestsRes.status === 'fulfilled') setDigests(digestsRes.value.items ?? []);
    else {
      setDigests([]);
      failedParts.digest = digestsRes.reason;
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
      // 两块任一失败都算「观点变化」这块失败；优先取真正被拒那条的 reason（axios 原始错误原样保留）
      failedParts.changes =
        historyRes.status === 'rejected'
          ? historyRes.reason
          : watchlistRes.status === 'rejected'
            ? watchlistRes.reason
            : undefined;
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
      {/* 判据顺序必须是「加载中 → 失败 → 空」：loading 期间数据尚未到达，
          直接判 `!alerts` 会先渲染「尚未监控过」这个**确定的结论**，用户据此以为今天没事 */}
      {loading ? (
        <LoadingLine label="自选股异动" />
      ) : failed.alerts !== undefined ? (
        <div className="watchlist-alerts-empty">
          {failureText(failed.alerts, '异动数据', '异动数据读取失败，请稍后重试')}
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
      {loading ? (
        <LoadingLine label="关注股观点变化" />
      ) : failed.changes !== undefined ? (
        <div className="watchlist-alerts-empty">
          {failureText(failed.changes, '观点变化', '观点变化读取失败，请稍后重试')}
        </div>
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
      {loading ? (
        <LoadingLine label="最近研究简报" />
      ) : failed.digest !== undefined ? (
        <div className="watchlist-alerts-empty">
          {failureText(failed.digest, '简报', '简报读取失败，请稍后重试')}
        </div>
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

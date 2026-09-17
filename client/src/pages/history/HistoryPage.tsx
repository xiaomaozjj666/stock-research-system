import { useEffect, useState, useCallback, useRef } from 'react';
import {
  fetchHistoryList,
  fetchHistoryDetail,
  deleteHistoryItem,
  normalizeApiError,
} from '../../api/client';
import type { HistoryListItem } from '../../api/client';
import type { AnalysisResult } from '../../types';

interface HistoryPageProps {
  /** 点击"查看"时回调：恢复完整分析结果并切回深度研究页渲染 */
  onOpenHistory: (result: AnalysisResult) => void;
}

/** 评级 → 徽章样式映射（与研究报告评分语义一致） */
const RATING_CLASS: Record<string, string> = {
  优先跟踪: 'history-rating-positive',
  持续观察: 'history-rating-info',
  谨慎观望: 'history-rating-warn',
  建议规避: 'history-rating-negative',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 「较上次」评分变化：取时间线最后两点之差。
 * 返回 null 表示无法比较——旧数据没有时间线，或只有 1 个点（首次分析）。
 * null 必须不渲染任何内容，否则界面上会出现无意义的空括号。
 */
function scoreDelta(it: HistoryListItem): { delta: number; prevDate: string } | null {
  const tl = it.timeline;
  if (!tl || tl.length < 2) return null;
  const prev = tl[tl.length - 2];
  const cur = tl[tl.length - 1];
  if (!Number.isFinite(prev?.score) || !Number.isFinite(cur?.score)) return null;
  return { delta: Math.round((cur.score - prev.score) * 100) / 100, prevDate: prev.date };
}

/** 变化量文本：整数不带小数点，非整数最多两位且去掉尾随 0（+7 / -18 / +1.25） */
function formatDelta(delta: number): string {
  const abs = Math.abs(delta);
  const text = Number.isInteger(abs)
    ? String(abs)
    : abs.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${delta > 0 ? '+' : '-'}${text}`;
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

export default function HistoryPage({ onOpenHistory }: HistoryPageProps) {
  const [items, setItems] = useState<HistoryListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 原始错误（英文 / 技术细节），只作为 title 提示，不直接展示 */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
  /** 正在拉取详情的 id：「查看」按钮据此显示「打开中…」并禁用，避免同一行被连点 */
  const [openingId, setOpeningId] = useState<string | null>(null);
  /** 待确认删除的 id（二次点击才真正执行，防误删） */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 「查看」的请求序号：先点 A（慢）再点 B，A 的响应后到时不得把 B 的报告顶掉——
   * 否则用户看到的是 A 的报告却以为是自己刚点的 B。
   */
  const openSeqRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      setErrorDetail(null);
      const list = await fetchHistoryList(50);
      setItems(list);
    } catch (err) {
      // 失败必须留下明确错误，否则会被下面的空态渲染成"暂无研究历史"
      const { text, detail } = describeError(
        err,
        '研究历史加载失败：',
        '请确认后端服务已启动后重试',
      );
      setError(text);
      setErrorDetail(detail ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 卸载时清掉二次确认的定时器：否则切页 3 秒后仍会对已卸载组件 setState
  // （React 18/19 下表现为 no-op，但定时器本身泄漏，且是"卸载后仍在跑"的隐患）
  useEffect(
    () => () => {
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
    },
    [],
  );

  async function openItem(id: string) {
    const seq = ++openSeqRef.current;
    setOpeningId(id);
    try {
      const detail = await fetchHistoryDetail(id);
      // 迟到响应：期间用户又点了另一行 → 丢弃，绝不用旧报告覆盖新选择
      if (seq !== openSeqRef.current) return;
      onOpenHistory(detail.result);
      setError(null);
      setErrorDetail(null);
    } catch (err) {
      if (seq !== openSeqRef.current) return;
      const { text, detail: raw } = describeError(
        err,
        '研究报告打不开：',
        '请确认后端服务已启动后重试',
      );
      setError(text);
      setErrorDetail(raw ?? null);
    } finally {
      // 只有最后一次请求有权收起「打开中…」（旧请求的收尾不能解禁新请求的按钮）
      if (seq === openSeqRef.current) setOpeningId(null);
    }
  }

  async function removeItem(id: string) {
    // 二次确认防误删：第一次点击进入确认态（3 秒后自动复位），再点才执行
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => {
        confirmTimerRef.current = null;
        setConfirmDeleteId(null);
      }, 3000);
      return;
    }
    setConfirmDeleteId(null);
    // 按 id 记录，而不是全局单值 deletingId：并发删除 A、B 时，
    // A 的 finally 会把 B 的「删除中…」一并清掉（表现为 B 的按钮提前解禁可再点）
    setDeletingIds((prev) => new Set(prev).add(id));
    try {
      await deleteHistoryItem(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch (err) {
      const { text, detail } = describeError(err, '删除失败：', '请稍后重试');
      setError(text);
      setErrorDetail(detail ?? null);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="history-page">
      <div className="history-header">
        <h2>研究历史</h2>
        <p className="history-sub">
          每次深度研究完成自动保存，同一股票仅保留最新一次报告。点击「查看」即可恢复完整研究报告。
        </p>
      </div>

      {/* 错误优先于空态：请求失败 + 无可用数据时，必须给出错误与重试入口，
          而不是落到"暂无研究历史"让用户以为系统正常 */}
      {error && !loading && (
        <div className="error-banner" role="alert">
          <div className="error-banner-body">
            <span className="error-banner-icon" aria-hidden="true">
              !
            </span>
            {/* 原始英文错误只放在 title 里做技术细节，不直接堆给用户 */}
            <span className="error-banner-text" title={errorDetail ?? undefined}>
              {error}
            </span>
          </div>
          <button className="error-banner-retry" onClick={load}>
            重试
          </button>
        </div>
      )}

      {loading ? (
        <div className="history-empty">加载中…</div>
      ) : items.length === 0 && !error ? (
        // 仅"请求成功且确实没有记录"才渲染空态；失败时上方错误横幅已表达
        <div className="history-empty">
          <p>暂无研究历史。</p>
          <p className="history-empty-hint">
            在「深度研究」页完成一次股票分析后，记录会自动出现在这里。
          </p>
        </div>
      ) : (
        <ul className="history-list">
          {items.map((it) => {
            const change = scoreDelta(it);
            return (
              <li key={it.id} className="history-item">
                <div className="history-item-main">
                  <div className="history-stock">
                    <span className="history-name">{it.stockName || it.stockCode}</span>
                    <span className="history-code">{it.stockCode}</span>
                    {it.industry && <span className="history-industry">{it.industry}</span>}
                  </div>
                  <div className="history-meta">
                    <span className={`history-rating ${RATING_CLASS[it.rating] ?? 'hb-neutral'}`}>
                      {it.rating}
                    </span>
                    <span className="history-score">
                      评分 {it.totalScore}
                      {/* 时间线没变化量可算时不渲染，避免出现空括号；配色沿用 A 股语义：红涨绿跌 */}
                      {change && (
                        <span
                          className={
                            change.delta > 0
                              ? 'val-positive'
                              : change.delta < 0
                                ? 'val-negative'
                                : 'val-neutral'
                          }
                          title={`较上次分析（${change.prevDate}）`}
                        >
                          {change.delta > 0 ? ' ▲ ' : change.delta < 0 ? ' ▼ ' : ' — '}
                          {change.delta === 0 ? '持平' : formatDelta(change.delta)}
                        </span>
                      )}
                    </span>
                    <span className="history-time">{formatTime(it.createdAt)}</span>
                  </div>
                </div>
                <div className="history-actions">
                  <button
                    className="btn-ghost history-open"
                    disabled={openingId === it.id}
                    onClick={() => openItem(it.id)}
                  >
                    {openingId === it.id ? '打开中…' : '查看'}
                  </button>
                  <button
                    className="btn-ghost history-delete"
                    disabled={deletingIds.has(it.id)}
                    onClick={() => removeItem(it.id)}
                  >
                    {deletingIds.has(it.id)
                      ? '删除中…'
                      : confirmDeleteId === it.id
                        ? '确认删除？'
                        : '删除'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

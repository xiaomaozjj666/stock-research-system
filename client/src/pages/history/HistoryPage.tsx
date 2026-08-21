import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchHistoryList, fetchHistoryDetail, deleteHistoryItem } from '../../api/client';
import type { AnalysisResult, HistorySummary } from '../../types';

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

export default function HistoryPage({ onOpenHistory }: HistoryPageProps) {
  const [items, setItems] = useState<HistorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** 待确认删除的 id（二次点击才真正执行，防误删） */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const list = await fetchHistoryList(50);
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '历史记录读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openItem(id: string) {
    try {
      const detail = await fetchHistoryDetail(id);
      onOpenHistory(detail.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '历史记录读取失败');
    }
  }

  async function removeItem(id: string) {
    // 二次确认防误删：第一次点击进入确认态（3 秒后自动复位），再点才执行
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    setConfirmDeleteId(null);
    setDeletingId(id);
    try {
      await deleteHistoryItem(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '历史记录删除失败');
    } finally {
      setDeletingId(null);
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

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner-icon">!</span>
          <div className="error-banner-body">{error}</div>
        </div>
      )}

      {loading ? (
        <div className="history-empty">加载中…</div>
      ) : items.length === 0 ? (
        <div className="history-empty">
          <p>暂无研究历史。</p>
          <p className="history-empty-hint">
            在「深度研究」页完成一次股票分析后，记录会自动出现在这里。
          </p>
        </div>
      ) : (
        <ul className="history-list">
          {items.map((it) => (
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
                  <span className="history-score">评分 {it.totalScore}</span>
                  <span className="history-time">{formatTime(it.createdAt)}</span>
                </div>
              </div>
              <div className="history-actions">
                <button className="btn-ghost history-open" onClick={() => openItem(it.id)}>
                  查看
                </button>
                <button
                  className="btn-ghost history-delete"
                  disabled={deletingId === it.id}
                  onClick={() => removeItem(it.id)}
                >
                  {deletingId === it.id
                    ? '删除中…'
                    : confirmDeleteId === it.id
                      ? '确认删除？'
                      : '删除'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

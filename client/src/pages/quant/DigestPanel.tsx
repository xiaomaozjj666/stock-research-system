/**
 * 研究简报面板：展示定时/手动生成的研究快照（初筛状态 + 台账概览 + 增量说明），
 * 支持手动生成。与 FactorLabPanel 同风格（卡片 + 台账式行文）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getResearchDigests, runResearchDigestNow, type ResearchDigest } from '../../api/client';
import { useToast } from '../../components/Toast';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function DigestItem({ d }: { d: ResearchDigest }) {
  const [open, setOpen] = useState(false);
  const s = d.screener;
  return (
    <div className="digest-item">
      <button type="button" className="digest-head" onClick={() => setOpen((v) => !v)}>
        <span className="digest-time">{fmtTime(d.createdAt)}</span>
        <span className="batch-hint">
          初筛 {s.at ? `命中 ${s.hitCount ?? 0}` : '无记录'} · 台账 {d.ledger.total} 条（采信{' '}
          {d.ledger.kept}）
        </span>
        <span className="digest-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="digest-body">
          <ul className="digest-notes">
            {d.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
          {s.at && s.topHits.length > 0 && (
            <div className="digest-screener">
              <div className="batch-hint">
                初筛（{fmtTime(s.at)}）：扫描 {s.scanned ?? '—'} 只 / 合格 {s.eligible ?? '—'} 只 /
                命中 {s.hitCount ?? 0} 条，代表性命中：
              </div>
              <ul className="digest-hits">
                {s.topHits.map((h, i) => (
                  <li key={`${h.code}-${h.strategy}-${i}`}>
                    <span className="batch-code">{h.code}</span> {h.name} · {h.strategy} ·{' '}
                    {h.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DigestPanel() {
  const [items, setItems] = useState<ResearchDigest[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const { showToast } = useToast();

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await getResearchDigests(10);
      if (!aliveRef.current) return;
      setItems(d.items ?? []);
      setError(null);
    } catch (e) {
      if (aliveRef.current) {
        setError(e instanceof Error ? e.message : '研究简报读取失败');
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRun = useCallback(async () => {
    setLoading(true);
    try {
      await runResearchDigestNow();
      showToast('研究简报已生成');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '生成失败', 'error');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [load, showToast]);

  return (
    <div className="card quant-panel digest-panel">
      <div className="digest-toolbar">
        <h3 className="quant-panel-title">研究简报</h3>
        <div className="batch-hint">
          定时生成由 QUANT_DIGEST_INTERVAL_HOURS 控制（默认关闭），此处可手动生成
        </div>
        <button type="button" className="btn" onClick={handleRun} disabled={loading}>
          {loading ? '生成中…' : '生成一份'}
        </button>
      </div>
      {error && <div className="digest-error">{error}</div>}
      {items === null && !error && <div className="batch-hint">加载中…</div>}
      {items !== null && items.length === 0 && (
        <div className="batch-hint">还没有简报：点「生成一份」创建第一份</div>
      )}
      {items !== null && items.length > 0 && (
        <div className="digest-list">
          {items.map((d) => (
            <DigestItem key={d.id} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import {
  ingestDocument,
  listDocuments,
  getModels,
  getCostReport,
  resetCostReport,
  clearChatHistory,
  startAutonomous,
  stopAutonomous,
  getAutonomousStatus,
  type ModelRoutingInfo,
  type CostReport as CostReportType,
  type AutonomousState,
} from '../api/client';

interface Props {
  sessionId: string;
}

/** 大体积二进制转 base64（分块避免 call stack 溢出） */
function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export default function ResearchEnhance({ sessionId }: Props) {
  const [docTitle, setDocTitle] = useState('');
  const [docText, setDocText] = useState('');
  const [docs, setDocs] = useState<{ id: string; source: string; preview: string }[]>([]);
  const [models, setModels] = useState<ModelRoutingInfo | null>(null);
  const [cost, setCost] = useState<CostReportType | null>(null);
  const [aum, setAum] = useState<AutonomousState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function refresh() {
    const [d, m, c, s] = await Promise.allSettled([
      listDocuments(),
      getModels(),
      getCostReport(),
      getAutonomousStatus(),
    ]);
    if (d.status === 'fulfilled') setDocs(d.value.docs);
    if (m.status === 'fulfilled') setModels(m.value);
    if (c.status === 'fulfilled') setCost(c.value);
    if (s.status === 'fulfilled') setAum(s.value);
  }

  useEffect(() => {
    void refresh();
    // 仅在挂载时拉一次；面板上手动刷新由交互触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleIngest() {
    if (!docTitle.trim() || !docText.trim()) {
      setMsg('请填写标题与内容');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      await ingestDocument({ title: docTitle.trim(), text: docText.trim() });
      setDocTitle('');
      setDocText('');
      setMsg('文档已入库，将参与后续对话的证据检索');
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '入库失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File) {
    setBusy(true);
    setMsg('');
    try {
      const buf = await file.arrayBuffer();
      const base64 = uint8ToBase64(new Uint8Array(buf));
      const title = docTitle.trim() || file.name.replace(/\.pdf$/i, '');
      await ingestDocument({ title, pdfBase64: base64 });
      setMsg('PDF 已解析并入库');
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'PDF 解析失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleClearMemory() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await clearChatHistory(sessionId);
      setMsg('对话记忆已清空');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '清空失败');
    } finally {
      setBusy(false);
    }
  }

  async function toggleAutonomous() {
    setBusy(true);
    setMsg('');
    try {
      if (aum?.running) {
        await stopAutonomous();
        setMsg('已停止自动监控');
      } else {
        await startAutonomous(10 * 60 * 1000);
        setMsg('已启动自动监控（每 10 分钟巡检自选股异动）');
      }
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleResetCost() {
    try {
      await resetCostReport();
      setMsg('成本统计已重置');
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '重置失败');
    }
  }

  return (
    <div className="enhance-panel">
      <div className="enhance-grid">
        {/* 文档入库 */}
        <section className="enhance-card">
          <h3 className="enhance-title">研究资料库</h3>
          <p className="enhance-hint">
            粘贴研报 / 财报 / 公告文本，或上传 PDF，抽取要点后注入 RAG，对话时可被引用为证据。
          </p>
          <input
            className="enhance-input"
            placeholder="文档标题（必填）"
            value={docTitle}
            onChange={(e) => setDocTitle(e.target.value)}
          />
          <textarea
            className="enhance-textarea"
            placeholder="粘贴文本，或先在上方填标题后选择 PDF…"
            value={docText}
            onChange={(e) => setDocText(e.target.value)}
            rows={4}
          />
          <div className="enhance-actions">
            <button className="btn-primary" onClick={handleIngest} disabled={busy}>
              入库文本
            </button>
            <label className="btn-ghost enhance-file">
              上传 PDF
              <input
                type="file"
                accept="application/pdf"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <div className="enhance-docs">
            {docs.length === 0 ? (
              <span className="enhance-empty">暂无已入库文档</span>
            ) : (
              docs.map((d) => (
                <div key={d.id} className="enhance-doc">
                  <span className="enhance-doc-src">{d.source}</span>
                  <span className="enhance-doc-preview">{d.preview}</span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* 模型路由 + 成本 */}
        <section className="enhance-card">
          <h3 className="enhance-title">模型路由与成本</h3>
          {models && (
            <div className="enhance-models">
              <div className="enhance-row">
                <span>LLM 可用</span>
                <span className={models.available ? 'tag tag-ok' : 'tag tag-warn'}>
                  {models.available ? '是' : '否（规则降级）'}
                </span>
              </div>
              <div className="enhance-row">
                <span>语义检索</span>
                <span className={models.embeddingEnabled ? 'tag tag-ok' : 'tag tag-warn'}>
                  {models.embeddingEnabled ? '向量模式' : 'BM25 模式'}
                </span>
              </div>
              <div className="enhance-routing">
                {Object.entries(models.routing).map(([task, model]) => (
                  <span key={task} className="chip chip-neutral">
                    {task}:{model}
                  </span>
                ))}
              </div>
            </div>
          )}
          {cost && (
            <div className="enhance-cost">
              <div className="enhance-row">
                <span>累计调用</span>
                <span>{cost.callCount} 次</span>
              </div>
              <div className="enhance-row">
                <span>Prompt / 输出 token</span>
                <span>
                  {cost.totalPromptTokens} / {cost.totalCompletionTokens}
                </span>
              </div>
              <div className="enhance-row">
                <span>估算成本</span>
                <span>${cost.totalCost.toFixed(4)}</span>
              </div>
              <button className="btn-ghost" onClick={handleResetCost}>
                重置成本统计
              </button>
            </div>
          )}
        </section>

        {/* 自动监控 + 记忆 */}
        <section className="enhance-card">
          <h3 className="enhance-title">自动监控与记忆</h3>
          <div className="enhance-row">
            <span>自选股异动巡检</span>
            <button
              className={aum?.running ? 'btn-ghost' : 'btn-primary'}
              onClick={toggleAutonomous}
              disabled={busy}
            >
              {aum?.running ? '停止监控' : '启动监控'}
            </button>
          </div>
          {aum?.running && (
            <div className="enhance-routing">
              <span className="chip chip-neutral">已运行 {aum.runCount ?? 0} 轮</span>
              <span className="chip chip-neutral">最近异动 {aum.lastAlertCount ?? 0} 条</span>
              {aum.errorCount ? (
                <span className="chip chip-warn">失败 {aum.errorCount} 次</span>
              ) : null}
            </div>
          )}
          <div className="enhance-row" style={{ marginTop: 8 }}>
            <span>对话记忆</span>
            <button className="btn-ghost" onClick={handleClearMemory} disabled={busy || !sessionId}>
              清空记忆
            </button>
          </div>
          <p className="enhance-hint">
            记忆按会话持久化，第二轮提问无需重复股票代码即可延续上下文。
          </p>
        </section>
      </div>
      {msg && <div className="enhance-msg">{msg}</div>}
    </div>
  );
}

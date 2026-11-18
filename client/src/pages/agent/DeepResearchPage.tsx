import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './DeepResearchPage.css';
import {
  deleteDeepResearchRun,
  getDeepResearchRun,
  listDeepResearchRuns,
  runDeepResearchStream,
  type DeepResearchEvent,
  type DeepResearchResult,
  type DeepResearchRunSummary,
} from '../../api/client';
import { useToast } from '../../components/Toast';
import { downloadMarkdown } from '../../utils/reportExport';

/**
 * AI 研究员（多步深度研究）工作台
 * ----------------------------------------------------------------------------
 * 与「深度研究」页的分工：
 *   深度研究 = 输入代码，跑固定的 8 专家流水线，输出评分/情景/策略；
 *   本页     = 输入开放问题，Agent 自己拆解子问题、多轮检索取证、交叉验证，
 *              输出带逐条引用与冲突裁决的论证型报告。
 *
 * 页面刻意把「过程」和「结论」并列展示：左侧是 Agent 的实时执行轨迹（哪一轮、
 * 检索了什么、命中了哪个通道、有没有降级），右侧是结论。主流投研工作台与普通
 * 聊天框的分水岭就在这里——结论必须是可复核的，而不是一个黑盒答案。
 */

const EXAMPLES = [
  '贵州茅台 600519 当前的基本面与估值是否匹配',
  '白酒行业未来两年的竞争格局与主要风险点',
  '光伏行业的产能出清进展到哪一步了',
];

/** 事件类型 → 展示文案与配色。未登记的类型走兜底，不会因为后端新增事件而白屏 */
const EVENT_META: Record<string, { label: string; tone: string }> = {
  run_started: { label: '启动研究', tone: 'accent' },
  plan_created: { label: '生成研究计划', tone: 'accent' },
  plan_revised: { label: '修订研究计划', tone: 'accent' },
  replan_triggered: { label: '重规划评估', tone: 'warning' },
  retrieval_started: { label: '开始检索', tone: 'muted' },
  retrieval_succeeded: { label: '检索命中', tone: 'muted' },
  retrieval_failed: { label: '检索失败', tone: 'danger' },
  retrieval_fallback: { label: '降级备用通道', tone: 'warning' },
  evidence_extracted: { label: '抽取证据', tone: 'success' },
  verification_completed: { label: '交叉验证', tone: 'success' },
  supplement_triggered: { label: '补充检索', tone: 'warning' },
  synthesis_started: { label: '编排结论', tone: 'accent' },
  synthesis_completed: { label: '结论完成', tone: 'success' },
  run_finished: { label: '研究结束', tone: 'success' },
  run_error: { label: '研究异常', tone: 'danger' },
};

/** 置信度 → 色阶：与全站 red/green 语义保持一致（A 股红涨绿跌反过来会误导） */
function confidenceClass(value: number): string {
  if (value >= 0.7) return 'high';
  if (value >= 0.45) return 'mid';
  return 'low';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

export default function DeepResearchPage() {
  const { showToast } = useToast();
  const [question, setQuestion] = useState('');
  const [industry, setIndustry] = useState('');
  const [timeRange, setTimeRange] = useState('');
  const [maxRounds, setMaxRounds] = useState(2);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<DeepResearchEvent[]>([]);
  const [result, setResult] = useState<DeepResearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 已完成的研究次数：用于给"再研究一次"之类的文案做区分，也便于用户判断是否重跑过 */
  const [runCount, setRunCount] = useState(0);

  /** 研究库：一次深度研究成本很高，刷新页面不该让结论消失 */
  const [history, setHistory] = useState<DeepResearchRunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** 当前展示的是哪条历史记录（null = 本次会话新跑的结果） */
  const [viewingId, setViewingId] = useState<string | null>(null);

  const cancelRef = useRef<(() => void) | null>(null);
  const traceEndRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await listDeepResearchRuns(20));
    } catch {
      // 历史列表只作补充，读取失败不影响研究工作台本身
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  // 卸载时中断在途研究：SSE 不关会一直占着连接，服务端也会继续烧 token
  useEffect(() => () => cancelRef.current?.(), []);

  // 轨迹自动滚动到底部（仅在运行中）：用户在运行结束后往回翻看时不该被强行拽到底
  useEffect(() => {
    if (!running) return;
    traceEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [events, running]);

  const handleRun = useCallback(() => {
    const q = question.trim();
    if (q.length < 4) {
      showToast('请输入至少 4 个字的研究问题', 'error');
      return;
    }

    cancelRef.current?.();
    const gen = ++seqRef.current;
    setRunning(true);
    setError(null);
    setResult(null);
    setEvents([]);
    setViewingId(null);

    const scope: Record<string, unknown> = {};
    if (industry.trim()) scope.industry = industry.trim();
    if (timeRange.trim()) scope.timeRange = timeRange.trim();

    const { cancel, done } = runDeepResearchStream(
      q,
      (evt) => {
        if (gen !== seqRef.current) return;
        if (evt.phase === 'agent_event') setEvents((prev) => [...prev, evt.event]);
      },
      { scope: Object.keys(scope).length > 0 ? scope : undefined, config: { maxRounds } },
    );
    cancelRef.current = cancel;

    done
      .then((res) => {
        if (gen !== seqRef.current) return;
        setResult(res);
        setRunCount((n) => n + 1);
        // 服务端在返回结果前已落库，这里刷新即可看到刚跑完的一条
        void refreshHistory();
      })
      .catch((err: unknown) => {
        if (gen !== seqRef.current) return;
        const message = err instanceof Error ? err.message : '研究失败';
        // 主动取消不算错误：清空轨迹，避免留下半截进度让人以为还能继续
        if (message.includes('已取消')) {
          setEvents([]);
          return;
        }
        setError(message);
      })
      .finally(() => {
        if (gen === seqRef.current) {
          cancelRef.current = null;
          setRunning(false);
        }
      });
  }, [question, industry, timeRange, maxRounds, showToast, refreshHistory]);

  const handleCancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setRunning(false);
  }, []);

  const handleExport = useCallback(() => {
    if (!result) return;
    const name = (result.report.title || '深度研究报告').replace(/[\\/:*?"<>|]/g, '_');
    downloadMarkdown(`${name}.md`, result.reportMarkdown);
    showToast('研究报告已导出');
  }, [result, showToast]);

  /** 回看历史研究：连同执行轨迹一起恢复，才能在事后复核结论是怎么来的 */
  const handleOpenHistory = useCallback(
    async (id: string) => {
      if (running) return;
      setHistoryLoading(true);
      try {
        const run = await getDeepResearchRun(id);
        setResult(run.result);
        setEvents(run.result.events);
        setQuestion(run.question);
        setViewingId(id);
        setError(null);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '历史研究读取失败', 'error');
      } finally {
        setHistoryLoading(false);
      }
    },
    [running, showToast],
  );

  const handleDeleteHistory = useCallback(
    async (event: React.MouseEvent, id: string) => {
      // 列表项本身可点击：删除按钮必须阻止冒泡，否则会连带触发「打开」
      event.stopPropagation();
      try {
        await deleteDeepResearchRun(id);
        setHistory((prev) => prev.filter((item) => item.id !== id));
        if (viewingId === id) {
          setResult(null);
          setEvents([]);
          setViewingId(null);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : '历史研究删除失败', 'error');
      }
    },
    [viewingId, showToast],
  );

  const handleExitHistory = useCallback(() => {
    setResult(null);
    setEvents([]);
    setViewingId(null);
    setQuestion('');
  }, []);

  const report = result?.report;

  /**
   * 引用只带 evidenceId，原文摘录在 evidence 里。这里做一次反查：
   * 「可溯源」不能只到来源标题，用户要能直接看到被引用的那句话。
   */
  const evidenceById = useMemo(
    () => new Map((result?.evidence ?? []).map((e) => [e.id, e])),
    [result],
  );

  return (
    <div className="dr-page">
      <header className="dr-header">
        <div>
          <h1 className="dr-title">AI 研究员</h1>
          <p className="dr-subtitle">
            提出一个开放问题，Agent
            自主拆解子问题、多轮检索取证、交叉验证冲突，输出可逐条溯源的论证型报告
          </p>
        </div>
        {runCount > 0 && <span className="dr-run-count">已完成 {runCount} 次研究</span>}
      </header>

      {viewingId && (
        <div className="dr-history-banner" role="status">
          <span>
            正在查看历史研究（{new Date(result?.report.generatedAt ?? '').toLocaleString()}）
          </span>
          <button type="button" className="btn-ghost" onClick={handleExitHistory}>
            退出查看
          </button>
        </div>
      )}

      <section className="dr-form card">
        <label className="dr-label" htmlFor="dr-question">
          研究问题
        </label>
        <textarea
          id="dr-question"
          className="dr-textarea"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例如：贵州茅台当前的基本面与估值是否匹配？未来两年的主要风险是什么？"
          rows={3}
          maxLength={500}
          disabled={running}
          // Ctrl/⌘+Enter 直接开跑：与全站「Ctrl+Enter 发起分析」的手感一致
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !running) {
              e.preventDefault();
              handleRun();
            }
          }}
        />
        <div className="dr-form-footer">
          <div className="dr-examples">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="dr-example"
                disabled={running}
                onClick={() => setQuestion(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
          <div className="dr-form-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? '收起选项' : '研究选项'}
            </button>
            {running ? (
              <button type="button" className="btn-ghost" onClick={handleCancel}>
                取消研究
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={handleRun}>
                {runCount > 0 ? '重新研究' : '开始研究'}
              </button>
            )}
          </div>
        </div>

        {advancedOpen && (
          <div className="dr-advanced">
            <div className="dr-field">
              <label htmlFor="dr-industry">行业限定</label>
              <input
                id="dr-industry"
                className="dr-input"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="如：白酒 / 光伏（留空则不限定）"
                maxLength={100}
                disabled={running}
              />
            </div>
            <div className="dr-field">
              <label htmlFor="dr-time">时间范围</label>
              <input
                id="dr-time"
                className="dr-input"
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value)}
                placeholder="如：近两年 / 2025 至今"
                maxLength={100}
                disabled={running}
              />
            </div>
            <div className="dr-field">
              <label htmlFor="dr-rounds">检索轮次上限</label>
              <select
                id="dr-rounds"
                className="dr-input"
                value={maxRounds}
                onChange={(e) => setMaxRounds(Number(e.target.value))}
                disabled={running}
              >
                <option value={1}>1 轮（最快）</option>
                <option value={2}>2 轮（推荐）</option>
                <option value={3}>3 轮（更充分）</option>
                <option value={4}>4 轮（最充分，耗时明显变长）</option>
              </select>
            </div>
            <p className="dr-advanced-hint">
              轮次越多，Agent 补充取证的机会越多，但每轮都会重新发起检索与 LLM
              调用，耗时和成本同步上升。
            </p>
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="dr-history card">
          <div className="dr-history-head">
            <h2>历史研究</h2>
            <span className="dr-history-hint">
              最近 {history.length} 条 · 点击可回看报告与完整执行轨迹
            </span>
          </div>
          <ul className="dr-history-list">
            {history.map((item) => (
              <li key={item.id} className="dr-history-row">
                <button
                  type="button"
                  className={`dr-history-item${viewingId === item.id ? ' is-active' : ''}`}
                  onClick={() => void handleOpenHistory(item.id)}
                  disabled={running || historyLoading}
                >
                  <span className="dr-history-question">{item.question}</span>
                  <span className="dr-history-meta">
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                    <span>
                      {item.rounds} 轮 · {item.evidenceCount} 条证据 · {item.conflictCount} 处冲突
                    </span>
                    <span className={`dr-confidence ${confidenceClass(item.overallConfidence)}`}>
                      {item.confidenceLabel}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="dr-history-delete"
                  onClick={(e) => void handleDeleteHistory(e, item.id)}
                  aria-label="删除该研究记录"
                  title="删除该研究记录"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <div className="error-banner" role="alert">
          <div className="error-banner-body">
            <span className="error-banner-icon" aria-hidden="true">
              !
            </span>
            <span className="error-banner-text">{error}</span>
          </div>
        </div>
      )}

      {(running || events.length > 0 || result) && (
        <div className="dr-workspace">
          {/* 左：执行轨迹 —— 让「这个结论是怎么来的」全程可见 */}
          <aside className="dr-trace card" aria-live="polite">
            <div className="dr-trace-head">
              <h2>研究轨迹</h2>
              {running && <span className="dr-live-dot" aria-label="研究进行中" />}
            </div>
            {events.length === 0 && running && <p className="dr-trace-empty">正在生成研究计划…</p>}
            <ol className="dr-trace-list">
              {events.map((ev) => {
                const meta = EVENT_META[ev.type] ?? { label: ev.type, tone: 'muted' };
                return (
                  <li key={ev.seq} className={`dr-trace-item tone-${meta.tone}`}>
                    <div className="dr-trace-marker" aria-hidden="true" />
                    <div className="dr-trace-body">
                      <div className="dr-trace-line">
                        <span className="dr-trace-label">{meta.label}</span>
                        <span className="dr-trace-round">R{ev.round}</span>
                        <time className="dr-trace-time">{formatTime(ev.at)}</time>
                      </div>
                      <p className="dr-trace-message">{ev.message}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div ref={traceEndRef} />
          </aside>

          {/* 右：结论 */}
          <main className="dr-report">
            {!report && running && (
              <div className="dr-pending card">
                <h2>正在检索与验证</h2>
                <p>
                  规划器已把问题拆成子问题，检索器会逐条取证并在验证阶段比对冲突。
                  报告要等所有子问题验证完毕后一次性生成，请耐心等待。
                </p>
                <ul className="dr-pending-stats">
                  <li>
                    <span className="dr-pending-num">{events.length}</span>
                    <span className="dr-pending-label">执行事件</span>
                  </li>
                  <li>
                    <span className="dr-pending-num">
                      {events.filter((e) => e.type === 'evidence_extracted').length}
                    </span>
                    <span className="dr-pending-label">已抽取证据</span>
                  </li>
                  <li>
                    <span className="dr-pending-num">
                      {events.filter((e) => e.type === 'verification_completed').length}
                    </span>
                    <span className="dr-pending-label">已验证子问题</span>
                  </li>
                </ul>
              </div>
            )}

            {report && (
              <>
                <section className="dr-report-head card">
                  <div className="dr-report-title-row">
                    <h2 className="dr-report-title">{report.title}</h2>
                    <span className={`dr-confidence ${confidenceClass(report.overallConfidence)}`}>
                      整体置信度 {report.confidenceLabel}（
                      {Math.round(report.overallConfidence * 100)}%）
                    </span>
                  </div>
                  <p className="dr-report-summary">{report.executiveSummary}</p>
                  <div className="dr-report-meta">
                    <span>{report.methodology.rounds} 轮检索</span>
                    <span>{report.methodology.evidenceCount} 条证据</span>
                    <span>{report.methodology.sourceCount} 个来源</span>
                    <span>{report.methodology.conflictsFound} 处冲突</span>
                    <span>计划 v{report.methodology.planVersions}</span>
                  </div>
                  <div className="dr-report-actions">
                    <button type="button" className="btn-ghost" onClick={handleExport}>
                      导出 Markdown
                    </button>
                  </div>
                </section>

                {report.sections.map((section, idx) => (
                  <section className="dr-section card" key={section.subQuestionId}>
                    <header className="dr-section-head">
                      <span className="dr-section-index">{idx + 1}</span>
                      <div>
                        <h3 className="dr-section-question">{section.question}</h3>
                        <span
                          className={`dr-section-confidence ${confidenceClass(section.confidence)}`}
                        >
                          置信度 {section.confidenceLabel}（{Math.round(section.confidence * 100)}
                          %）
                        </span>
                      </div>
                    </header>

                    <p className="dr-section-conclusion">{section.conclusion}</p>

                    {section.conflictNotes.length > 0 && (
                      <ul className="dr-section-conflicts">
                        {section.conflictNotes.map((note, i) => (
                          <li key={i}>{note}</li>
                        ))}
                      </ul>
                    )}

                    {section.citations.length > 0 && (
                      <details className="dr-citations">
                        <summary>
                          {section.citations.length} 条引用
                          <span className="dr-citations-hint">点击展开逐条核验</span>
                        </summary>
                        <ul className="dr-citation-list">
                          {section.citations.map((c) => {
                            const evidence = evidenceById.get(c.evidenceId);
                            return (
                              <li className="dr-citation" key={c.evidenceId}>
                                <p className="dr-citation-claim">{c.claim}</p>
                                {evidence && (
                                  <blockquote className="dr-citation-quote">
                                    {evidence.quote}
                                  </blockquote>
                                )}
                                <div className="dr-citation-meta">
                                  <span className="dr-citation-source">{c.sourceTitle}</span>
                                  {c.publisher && (
                                    <span className="dr-citation-publisher">{c.publisher}</span>
                                  )}
                                  {c.publishedAt && (
                                    <span className="dr-citation-date">{c.publishedAt}</span>
                                  )}
                                  <span className={`dr-citation-type type-${c.sourceType}`}>
                                    {c.sourceType}
                                  </span>
                                </div>
                                {/* 获取路径是"可审计"的关键：哪一轮、什么查询词、走了哪个通道、是否降级 */}
                                <div className="dr-citation-path">
                                  第 {c.path.round} 轮 · 查询「{c.path.query}」· 通道{' '}
                                  {c.path.adapter}
                                  {c.path.attempt > 1 && ` · 第 ${c.path.attempt} 次尝试`}
                                  {c.path.fallbackOf && ` · 降级自 ${c.path.fallbackOf}`}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    )}
                  </section>
                ))}

                {report.conflicts.length > 0 && (
                  <section className="dr-section card">
                    <h3 className="dr-section-question">证据冲突与裁决</h3>
                    <ul className="dr-conflict-list">
                      {report.conflicts.map((c, i) => (
                        <li key={i} className={`dr-conflict resolution-${c.resolution}`}>
                          <div className="dr-conflict-head">
                            <span className="dr-conflict-dimension">{c.dimension}</span>
                            <span className="dr-conflict-resolution">
                              {c.resolution === 'a_wins' && '采信前者'}
                              {c.resolution === 'b_wins' && '采信后者'}
                              {c.resolution === 'both_partially_true' && '两者部分成立'}
                              {c.resolution === 'unresolved' && '未能裁决'}
                            </span>
                          </div>
                          <p className="dr-conflict-desc">{c.description}</p>
                          {c.resolutionReason && (
                            <p className="dr-conflict-reason">裁决依据：{c.resolutionReason}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {report.limitations.length > 0 && (
                  <section className="dr-section card dr-limitations">
                    <h3 className="dr-section-question">研究局限</h3>
                    <ul>
                      {report.limitations.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="dr-section card">
                  <h3 className="dr-section-question">方法论</h3>
                  <div className="dr-methodology">
                    <div>
                      <span className="dr-methodology-label">检索通道</span>
                      <span className="dr-methodology-value">
                        {report.methodology.adaptersUsed.length > 0
                          ? report.methodology.adaptersUsed.join(' / ')
                          : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="dr-methodology-label">生成时间</span>
                      <span className="dr-methodology-value">
                        {new Date(report.generatedAt).toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="dr-methodology-label">运行统计</span>
                      <span className="dr-methodology-value">
                        检索 {result?.stats.succeededTasks ?? 0}/
                        {result?.stats.totalRetrievalTasks ?? 0} 成功 · 降级{' '}
                        {result?.stats.fallbacksUsed ?? 0} 次 · 停止原因{' '}
                        {result?.stats.stopReason ?? '—'}
                      </span>
                    </div>
                  </div>
                  <p className="dr-disclaimer">
                    本报告由 Agent
                    基于公开信息自动生成，每条结论均标注来源与获取路径，但不对信息的完整性作保证，不构成投资建议。
                  </p>
                </section>
              </>
            )}
          </main>
        </div>
      )}

      {!running && !result && events.length === 0 && !error && (
        <div className="dr-empty">
          <h2>能用来做什么</h2>
          <div className="dr-empty-grid">
            <div className="dr-empty-item">
              <h3>行业格局梳理</h3>
              <p>
                「光伏行业的产能出清进展到哪一步了」——Agent
                会自动去找政策、公告与新闻，交叉核对后再下结论。
              </p>
            </div>
            <div className="dr-empty-item">
              <h3>关键分歧查证</h3>
              <p>
                当不同来源的数据口径不一致时，验证阶段会明确列出冲突并给出裁决依据，而不是挑一个顺眼的写进报告。
              </p>
            </div>
            <div className="dr-empty-item">
              <h3>可复核的结论</h3>
              <p>
                每条结论都能下钻到具体来源、原文摘录、第几轮检索、走的哪个通道，必要时可回到原文核对。
              </p>
            </div>
          </div>
          <p className="dr-empty-hint">
            一次研究通常需要数十次模型调用，耗时数分钟；问题越具体，结论越可靠。
          </p>
        </div>
      )}
    </div>
  );
}

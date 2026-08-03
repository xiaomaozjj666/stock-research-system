import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { chatWithAgent, type ChatAgentResponse, type ChatTurn } from '../api/client';
import ResearchEnhance from './ResearchEnhance';

interface UIMessage extends ChatTurn {
  meta?: ChatAgentResponse;
}

const QUICK_PROMPTS = [
  '帮我分析 600519',
  '对比 600519 和 000858',
  '对 600519 做 ma_cross 回测',
  '600519 该看多还是看空？来一场多空辩论',
];

export default function ChatPanel() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [openEvidence, setOpenEvidence] = useState<Record<number, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // 会话级记忆 ID：持久化到 localStorage，第二轮提问无需重复股票代码
  const [sessionId] = useState<string>(() => {
    const KEY = 'srs-session-id';
    let v = localStorage.getItem(KEY);
    if (!v) {
      v = 'sess-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(KEY, v);
    }
    return v;
  });
  const [showEnhance, setShowEnhance] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages, loading]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || loading) return;
    const next: UIMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const res = await chatWithAgent({ message: content, history: messages, sessionId });
      setMessages([...next, { role: 'assistant', content: res.answer, meta: res }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '对话请求失败';
      setMessages([...next, { role: 'assistant', content: `⚠️ ${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-top">
          <h2>研究助手</h2>
          <button className="btn-ghost chat-enhance-toggle" onClick={() => setShowEnhance((s) => !s)}>
            {showEnhance ? '收起增强能力 ▲' : '研究增强 ▼'}
          </button>
        </div>
        <p className="chat-subtitle">用自然语言提问：分析个股、对比、回测、多空辩论。支持工具调用与证据引用。</p>
      </div>
      {showEnhance && <ResearchEnhance sessionId={sessionId} />}

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>试试这些问题：</p>
            <div className="chat-quick">
              {QUICK_PROMPTS.map((q) => (
                <button key={q} className="chip chip-neutral chat-quick-item" onClick={() => send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`chat-row chat-row-${m.role}`}>
            <div className={`chat-bubble chat-bubble-${m.role}`}>
              <div className="chat-text">{m.content}</div>

              {m.meta && (
                <div className="chat-meta">
                  {m.meta.degraded && <span className="chat-badge chat-badge-warn">离线降级</span>}
                  {m.meta.model && <span className="chat-badge chat-badge-model">{m.meta.model}</span>}
                  {m.meta.toolsUsed.length > 0 && (
                    <span className="chat-badge chat-badge-tool">
                      工具: {m.meta.toolsUsed.join('、')}
                    </span>
                  )}

                  {m.meta.evidence.length > 0 && (
                    <button
                      className="chat-evidence-toggle"
                      onClick={() => setOpenEvidence((s) => ({ ...s, [i]: !s[i] }))}
                    >
                      证据 {m.meta.evidence.length} 条 {openEvidence[i] ? '▲' : '▼'}
                    </button>
                  )}
                </div>
              )}

              {(m.meta?.evidence?.length ?? 0) > 0 && openEvidence[i] && (
                <ul className="chat-evidence">
                  {m.meta?.evidence?.map((ev) => (
                    <li key={ev.id}>
                      <span className="chat-evidence-src">{ev.source}</span>
                      <span className="chat-evidence-text">{ev.text.slice(0, 160)}</span>
                    </li>
                  ))}
                </ul>
              )}

              {m.meta?.debate && (
                <div className="chat-debate">
                  <div className="chat-debate-side chat-debate-bull">
                    <strong>看多</strong>
                    <p>{m.meta.debate.bull}</p>
                  </div>
                  <div className="chat-debate-side chat-debate-bear">
                    <strong>看空</strong>
                    <p>{m.meta.debate.bear}</p>
                  </div>
                  <div className="chat-debate-synthesis">
                    <strong>首席合成</strong>
                    <p>{m.meta.debate.synthesis}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="chat-row chat-row-assistant">
            <div className="chat-bubble chat-bubble-assistant chat-loading">
              <span className="chat-dot" /> 思考中…
            </div>
          </div>
        )}
      </div>

      <div className="chat-input-area">
        <textarea
          aria-label="对话输入"
          className="chat-input"
          placeholder="输入问题，Enter+Ctrl 发送…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />
        <button className="btn-primary chat-send" onClick={() => send(input)} disabled={loading}>
          发送
        </button>
      </div>
    </div>
  );
}

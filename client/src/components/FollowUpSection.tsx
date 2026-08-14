import { useEffect, useMemo, useState } from 'react';

interface FollowUpSectionProps {
  /** 报告生成的跟踪指标（每次分析动态生成） */
  data: string[];
  /** 股票代码：跟踪状态按股票持久化到 localStorage */
  stockCode?: string;
}

interface FollowUpState {
  /** 已关注（置顶显示）的生成项 */
  starred: string[];
  /** 用户自定义指标 */
  custom: string[];
}

const EMPTY: FollowUpState = { starred: [], custom: [] };

function storageKey(stockCode: string): string {
  return `srs-followup:${stockCode}`;
}

function loadState(stockCode?: string): FollowUpState {
  if (!stockCode) return EMPTY;
  try {
    const raw = localStorage.getItem(storageKey(stockCode));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<FollowUpState>;
    return {
      starred: Array.isArray(parsed.starred) ? parsed.starred : [],
      custom: Array.isArray(parsed.custom) ? parsed.custom : [],
    };
  } catch {
    return EMPTY;
  }
}

export default function FollowUpSection({ data = [], stockCode }: FollowUpSectionProps) {
  const [state, setState] = useState<FollowUpState>(() => loadState(stockCode));
  const [customInput, setCustomInput] = useState('');

  // 跟踪状态持久化（按股票代码）
  useEffect(() => {
    if (!stockCode) return;
    try {
      localStorage.setItem(storageKey(stockCode), JSON.stringify(state));
    } catch {
      /* 存储不可用（隐私模式等）时静默 */
    }
  }, [state, stockCode]);

  // 已关注项置顶 + 未关注项保持报告顺序
  const generated = useMemo(() => {
    const starred = data.filter((d) => state.starred.includes(d));
    const rest = data.filter((d) => !state.starred.includes(d));
    return [...starred, ...rest];
  }, [data, state.starred]);

  if (data.length === 0 && state.custom.length === 0) return null;

  function toggleStar(item: string) {
    setState((s) => ({
      ...s,
      starred: s.starred.includes(item)
        ? s.starred.filter((x) => x !== item)
        : [...s.starred, item],
    }));
  }

  function addCustom() {
    const text = customInput.trim();
    if (!text) return;
    setState((s) => ({ ...s, custom: s.custom.includes(text) ? s.custom : [...s.custom, text] }));
    setCustomInput('');
  }

  function removeCustom(item: string) {
    setState((s) => ({ ...s, custom: s.custom.filter((x) => x !== item) }));
  }

  return (
    <div className="card">
      <div className="section-title">后续跟踪指标</div>
      <div className="followup-list">
        {generated.map((item, i) => (
          <div className="followup-item" key={`g-${i}`}>
            <span className="followup-dot" />
            <span className="followup-text">{item}</span>
            <button
              className={`followup-star ${state.starred.includes(item) ? 'active' : ''}`}
              title={state.starred.includes(item) ? '取消关注（置顶）' : '关注（置顶显示）'}
              aria-label={state.starred.includes(item) ? '取消关注' : '关注'}
              onClick={() => toggleStar(item)}
            >
              {state.starred.includes(item) ? '★' : '☆'}
            </button>
          </div>
        ))}

        {state.custom.map((item) => (
          <div className="followup-item followup-custom" key={`c-${item}`}>
            <span className="followup-dot" />
            <span className="followup-text">{item}</span>
            <button
              className="followup-remove"
              title="删除自定义指标"
              aria-label="删除自定义指标"
              onClick={() => removeCustom(item)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="followup-add">
        <input
          className="followup-input"
          placeholder="添加自定义跟踪指标…（回车保存）"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addCustom();
          }}
          aria-label="自定义跟踪指标输入"
        />
        <button
          className="btn-ghost followup-add-btn"
          onClick={addCustom}
          disabled={!customInput.trim()}
        >
          添加
        </button>
      </div>
      <p className="followup-hint">
        关注（★）的指标下次分析会自动置顶；自定义指标按股票持久化保存在本机。
      </p>
    </div>
  );
}

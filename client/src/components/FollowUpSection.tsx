import { memo, useEffect, useMemo, useState } from 'react';

import { createThesis, evaluateThesis, getTheses } from '../api/client';
import type { ThesisRecord } from '../api/generated';

interface FollowUpSectionProps {
  /** 报告生成的跟踪指标（每次分析动态生成） */
  data: string[];
  /** 股票代码：跟踪状态按股票持久化到 localStorage */
  stockCode?: string;
  /** 是否展示可证伪预注册实验（分析页开启，轻量组件测试可关闭） */
  enableThesis?: boolean;
  rating?: string;
  entryPrice?: number;
}

interface FollowUpState {
  /** 已关注（置顶显示）的生成项 */
  starred: string[];
  /** 用户自定义指标 */
  custom: string[];
}

const EMPTY: FollowUpState = { starred: [], custom: [] };
const STATUS_LABEL: Record<ThesisRecord['status'], string> = {
  active: '进行中',
  invalidated: '已失效',
  expired: '已到期',
};
const METRIC_LABEL: Record<ThesisRecord['metric'], string> = {
  close_price: '收盘价',
  return_pct: '净收益率(%)',
  excess_return_pct: '超额收益率(%)',
};
const COMPARATOR_LABEL: Record<ThesisRecord['comparator'], string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

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

function evidenceText(thesis: ThesisRecord): string | null {
  if (thesis.evidenceStatus === 'insufficient_evidence') {
    return '证据不足：到期时无可用真实完成 K 线，不生成收益或命中结论';
  }
  if (thesis.evidenceStatus === 'no_execution') {
    return '未按冻结限价规则成交，不生成收益结论';
  }
  if (thesis.status === 'active') return '未到期或未评估，口径已冻结';
  if (thesis.evidenceStatus === 'sufficient') {
    return thesis.status === 'invalidated' ? '真实证据达到证伪条件' : '已到期，未达到证伪条件';
  }
  return null;
}

function FollowUpSection({
  data = [],
  stockCode,
  enableThesis = false,
  rating,
  entryPrice,
}: FollowUpSectionProps) {
  const [state, setState] = useState<FollowUpState>(() => loadState(stockCode));
  const [customInput, setCustomInput] = useState('');
  const [theses, setTheses] = useState<ThesisRecord[]>([]);
  const [thesisText, setThesisText] = useState('');
  const [metric, setMetric] = useState<ThesisRecord['metric']>('return_pct');
  const [comparator, setComparator] = useState<ThesisRecord['comparator']>('lte');
  const [threshold, setThreshold] = useState('-5');
  const [horizonDays, setHorizonDays] = useState('20');
  const [invalidationAction, setInvalidationAction] = useState('撤销假设并复核风险');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [entryPriceInput, setEntryPriceInput] = useState(String(entryPrice ?? ''));
  const [limitPrice, setLimitPrice] = useState(String(entryPrice ?? ''));
  const [quantity, setQuantity] = useState('100');
  const [error, setError] = useState('');
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);

  useEffect(() => {
    if (!stockCode) return;
    try {
      localStorage.setItem(storageKey(stockCode), JSON.stringify(state));
    } catch {
      /* 存储不可用（隐私模式等）时静默 */
    }
  }, [state, stockCode]);

  useEffect(() => {
    if (!enableThesis || !stockCode) return;
    let active = true;
    getTheses(stockCode)
      .then((result) => {
        if (active) setTheses(result.items);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '预注册实验读取失败');
      });
    return () => {
      active = false;
    };
  }, [enableThesis, stockCode]);

  const generated = useMemo(() => {
    const starred = data.filter((d) => state.starred.includes(d));
    const rest = data.filter((d) => !state.starred.includes(d));
    return [...starred, ...rest];
  }, [data, state.starred]);

  if (data.length === 0 && state.custom.length === 0 && !enableThesis) return null;

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

  async function submitThesis(event: React.FormEvent) {
    event.preventDefault();
    if (!stockCode || !rating || !thesisText.trim()) {
      setError('请填写投资论点并先完成股票评级');
      return;
    }
    const numericEntry = Number(entryPriceInput);
    const numericQuantity = Number(quantity);
    const numericThreshold = Number(threshold);
    const numericHorizon = Number(horizonDays);
    const numericLimit = Number(limitPrice);
    if (
      !Number.isFinite(numericEntry) ||
      numericEntry <= 0 ||
      !Number.isInteger(numericQuantity) ||
      numericQuantity < 100 ||
      !Number.isFinite(numericThreshold) ||
      !Number.isInteger(numericHorizon) ||
      numericHorizon < 1 ||
      numericHorizon > 3650 ||
      (orderType === 'limit' && (!Number.isFinite(numericLimit) || numericLimit <= 0))
    ) {
      setError('请填写有效价格、阈值、期限和整手数量');
      return;
    }
    setError('');
    try {
      const result = await createThesis({
        stockCode,
        thesis: thesisText.trim(),
        rating,
        metric,
        comparator,
        threshold: numericThreshold,
        horizonDays: numericHorizon,
        evidenceSource: 'real_ohlcv',
        invalidationAction: invalidationAction.trim() || '撤销假设并复核风险',
        benchmarkCode: '000300',
        execution: {
          side: 'buy',
          orderType,
          entryPrice: numericEntry,
          quantity: numericQuantity,
          ...(orderType === 'limit' ? { limitPrice: numericLimit } : {}),
          commissionRate: 0.0003,
          stampDutyRate: 0.0005,
        },
      });
      setTheses((items) => [result.thesis, ...items]);
      setThesisText('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预注册创建失败');
    }
  }

  async function runEvaluation(id: string) {
    setEvaluatingId(id);
    setError('');
    try {
      const result = await evaluateThesis(id);
      setTheses((items) => items.map((item) => (item.id === id ? result.thesis : item)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预注册评估失败');
    } finally {
      setEvaluatingId(null);
    }
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

      {enableThesis && stockCode && (
        <section className="thesis-panel" aria-label="可证伪预注册实验">
          <h3>可证伪预注册实验</h3>
          <p className="followup-hint">
            冻结评级、条件、期限、基准和成交费用；不自动下单，到期仅用真实已完成K线评估。
          </p>
          <form className="thesis-form" onSubmit={submitThesis}>
            <label>
              投资论点
              <input
                value={thesisText}
                onChange={(e) => setThesisText(e.target.value)}
                required
                maxLength={500}
              />
            </label>
            <label>
              证伪指标
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as ThesisRecord['metric'])}
              >
                <option value="return_pct">净收益率(%)</option>
                <option value="excess_return_pct">超额收益率(%)</option>
                <option value="close_price">收盘价</option>
              </select>
            </label>
            <label>
              比较符
              <select
                value={comparator}
                onChange={(e) => setComparator(e.target.value as ThesisRecord['comparator'])}
              >
                <option value="lte">&lt;=</option>
                <option value="lt">&lt;</option>
                <option value="gte">&gt;=</option>
                <option value="gt">&gt;</option>
              </select>
            </label>
            <label>
              证伪阈值
              <input
                type="number"
                step="any"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                required
              />
            </label>
            <label>
              期限（天）
              <input
                type="number"
                min="1"
                max="3650"
                step="1"
                value={horizonDays}
                onChange={(e) => setHorizonDays(e.target.value)}
                required
              />
            </label>
            <label>
              失效动作
              <input
                value={invalidationAction}
                onChange={(e) => setInvalidationAction(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label>
              冻结评级
              <input value={rating ?? ''} readOnly aria-label="冻结评级" />
            </label>
            <label>
              基准代码
              <input value="000300" readOnly aria-label="基准代码" />
            </label>
            <label>
              入场价
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={entryPriceInput}
                onChange={(e) => {
                  setEntryPriceInput(e.target.value);
                  setLimitPrice(e.target.value);
                }}
                required
              />
            </label>
            <label>
              数量（股）
              <input
                type="number"
                min="100"
                step="100"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </label>
            <label>
              订单类型
              <select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as 'market' | 'limit')}
              >
                <option value="market">市价（收盘）</option>
                <option value="limit">限价（收盘）</option>
              </select>
            </label>
            {orderType === 'limit' && (
              <label>
                限价
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  required
                />
              </label>
            )}
            <button
              className="btn-primary"
              type="submit"
              disabled={!thesisText.trim() || !rating || !entryPrice}
            >
              冻结并创建实验
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
          <div className="thesis-list">
            {theses.map((thesis) => (
              <article className="thesis-record" key={thesis.id}>
                <div className="thesis-record-head">
                  <strong>{thesis.thesis}</strong>
                  <span className={`thesis-status thesis-status-${thesis.status}`}>
                    {STATUS_LABEL[thesis.status]}
                  </span>
                </div>
                <p>
                  {thesis.rating} · {METRIC_LABEL[thesis.metric]}{' '}
                  {COMPARATOR_LABEL[thesis.comparator]} {thesis.threshold} · {thesis.horizonDays}天
                  · 基准 {thesis.benchmarkCode}
                </p>
                <p>
                  {thesis.execution.orderType === 'market'
                    ? '市价'
                    : `限价 ${thesis.execution.limitPrice}`}{' '}
                  · {thesis.execution.quantity}股 · 到期 {thesis.dueAt.slice(0, 10)} ·{' '}
                  {thesis.invalidationAction}
                </p>
                {thesis.returnPct !== undefined && (
                  <p>
                    净收益率 {thesis.returnPct}%
                    {thesis.excessPct !== undefined ? ` · 超额 ${thesis.excessPct}%` : ''}
                  </p>
                )}
                {evidenceText(thesis) && <p className="thesis-evidence">{evidenceText(thesis)}</p>}
                {thesis.status === 'active' && (
                  <button
                    className="btn-ghost"
                    onClick={() => void runEvaluation(thesis.id)}
                    disabled={evaluatingId === thesis.id}
                  >
                    {evaluatingId === thesis.id ? '评估中…' : '按冻结口径评估'}
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// App 的滚动/悬停等本地状态变化频率高，memo 避免纯数据展示区块随之全量重渲染
export default memo(FollowUpSection);

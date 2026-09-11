import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getUniverseBoards,
  getFactorExperiments,
  runFactorExpression,
  type FactorExperiment,
} from '../../api/client';
import type { IndustryBoard } from './types';

/** 默认板块按名称优先级（与截面面板同口径）：列表按市值降序首项过大过杂 */
const PREFERRED_DEFAULT_BOARDS = ['白酒', '银行'];

const DEFAULT_EXPRESSION = 'close / mean(close, 20) - 1';

function fmtIc(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : '—';
}
function fmtP(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v < 1e-4 ? '<1e-4' : v.toFixed(3);
}
function shortDate(iso: string): string {
  return String(iso ?? '')
    .slice(5, 16)
    .replace('T', ' ');
}

/**
 * 因子实验室（Factor Lab）
 * ------------------------------------------------------------------
 * 把「LLM/人提出因子假设 → 受限 DSL 求值 → 截面评估 → 台账留痕」闭环搬到界面上：
 * 上半区验证一条表达式，下半区回看试过什么、哪些被采信。
 * 表达式走服务端白名单解析（不执行任意代码），非法会直接被拒并给出原因。
 */
export default function FactorLabPanel() {
  const [boards, setBoards] = useState<IndustryBoard[]>([]);
  const [board, setBoard] = useState('');
  const [topN, setTopN] = useState(10);
  const [expression, setExpression] = useState(DEFAULT_EXPRESSION);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof runFactorExpression>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<FactorExperiment[]>([]);
  const [summary, setSummary] = useState<{
    total: number;
    kept: number;
    keptExpectedFalse?: number;
    keptOosShare?: number;
  } | null>(null);

  const loadLedger = useCallback(async () => {
    try {
      const d = await getFactorExperiments({ limit: 20 });
      setItems(d.items ?? []);
      setSummary(d.summary ?? null);
    } catch {
      // 台账是辅助信息：读失败不打断主流程
    }
  }, []);

  useEffect(() => {
    let alive = true;
    getUniverseBoards()
      .then((d) => {
        if (!alive) return;
        const list = d.boards ?? [];
        setBoards(list);
        setBoard(
          (prev) =>
            prev ||
            list.find((b) => PREFERRED_DEFAULT_BOARDS.includes(b.name))?.code ||
            list[0]?.code ||
            '',
        );
      })
      .catch(() => undefined);
    loadLedger();
    return () => {
      alive = false;
    };
  }, [loadLedger]);

  const canRun = useMemo(
    () => !!board && expression.trim().length > 0 && !running,
    [board, expression, running],
  );

  const handleRun = useCallback(async () => {
    if (!canRun) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const data = await runFactorExpression({ expression, board, topN, horizons: [21, 63] });
      setResult(data);
      await loadLedger();
    } catch (e) {
      setError(e instanceof Error ? e.message : '因子表达式评估失败');
    } finally {
      setRunning(false);
    }
  }, [canRun, expression, board, topN, loadLedger]);

  return (
    <div className="card quant-panel factor-lab">
      <h3 className="quant-panel-title">
        因子实验室
        <span className="factor-subtitle">
          受限语法内验证一个因子假设（白名单解析，不执行任意代码），结论自动进实验台账
        </span>
      </h3>

      <div className="batch-form">
        <div className="batch-field-row">
          <label className="batch-field">
            <span className="batch-label">行业板块</span>
            <select
              className="batch-input"
              value={board}
              disabled={running || boards.length === 0}
              onChange={(e) => setBoard(e.target.value)}
            >
              {boards.length === 0 && <option value="">加载板块中…</option>}
              {boards.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.name}（{b.code}）
                </option>
              ))}
            </select>
          </label>
          <label className="batch-field">
            <span className="batch-label">成分股数量</span>
            <input
              type="number"
              className="batch-input"
              min={3}
              max={300}
              value={topN}
              disabled={running}
              onChange={(e) => setTopN(Number(e.target.value))}
            />
          </label>
        </div>

        <label className="batch-field">
          <span className="batch-label">因子表达式</span>
          <input
            type="text"
            className="batch-input"
            value={expression}
            disabled={running}
            onChange={(e) => setExpression(e.target.value)}
            placeholder="close / mean(close, 20) - 1"
          />
          <span className="batch-hint">
            可用：open/high/low/close/volume/ret、roe/grossMargin/netProfitGrowth/debtRatio； 函数
            mean/std/sum/min/max/delay/corr/abs/log/sqrt
          </span>
        </label>

        <div className="batch-actions">
          <button
            className="btn-primary"
            onClick={handleRun}
            disabled={!canRun}
            title={canRun ? '评估该因子假设' : '请填写表达式并选择板块'}
          >
            {running ? '评估中…' : '评估因子假设'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {running && <p className="batch-loading">正在拉取面板并计算截面 IC…</p>}

      {result && !running && (
        <div className="batch-summary">
          入组 <b>{result.stocksIncluded.length}</b> 只 · 观测{' '}
          <b>{result.factor.report.sampleSize}</b> · 已入台账 {result.ledger.recorded} 条
          {result.factor.report.byPeriod.map((p) => (
            <span key={p.period} className="factor-lab-period">
              {p.period}日：IC {fmtIc(p.ic.mean)}（p={fmtP(p.ic.pValue)}）·
              {p.oos.stable ? 'OOS稳定' : 'OOS不稳'} ·
              <b className={p.verdict.effective ? 'sig-valid' : 'sig-none'}>
                {p.verdict.effective ? '采信' : '不采信'}
              </b>
            </span>
          ))}
        </div>
      )}

      <div className="factor-ledger">
        <div className="factor-ledger-head">
          <h4 className="quant-panel-title">实验台账</h4>
          {summary && (
            <span className="batch-hint">
              累计 {summary.total} 条 · 采信 {summary.kept} 条
              {typeof summary.keptExpectedFalse === 'number' && summary.kept > 0 && (
                <>
                  {' '}
                  · 期望假阳性 ≈{summary.keptExpectedFalse}（Σp，全历史试错的诚实折扣）
                  {typeof summary.keptOosShare === 'number' &&
                    ` · OOS 稳定 ${Math.round(summary.keptOosShare * 100)}%`}
                </>
              )}
            </span>
          )}
        </div>
        {items.length === 0 ? (
          <p className="batch-empty">还没有实验记录：评估一次截面或因子假设后自动留痕。</p>
        ) : (
          <div className="batch-table-wrap">
            <table className="batch-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>因子</th>
                  <th>来源</th>
                  <th>持有期</th>
                  <th>IC</th>
                  <th>p</th>
                  <th>OOS</th>
                  <th>结论</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="batch-code">{shortDate(it.createdAt)}</td>
                    <td title={it.expression ?? it.name}>{it.name}</td>
                    <td>{it.source}</td>
                    <td>{it.horizon}</td>
                    <td className={it.icMean >= 0 ? 'sig-valid' : 'sig-inverted'}>
                      {fmtIc(it.icMean)}
                    </td>
                    <td>{fmtP(it.pValue)}</td>
                    <td>{it.oosStable ? '稳定' : '不稳'}</td>
                    <td>
                      <span className={it.kept ? 'sig-valid' : 'sig-none'}>
                        {it.kept ? '采信' : '不采信'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

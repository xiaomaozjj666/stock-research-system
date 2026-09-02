import { useCallback, useMemo, useState } from 'react';
import { runBatchCompositeAlpha } from '../../api/client';
import type {
  CompositeAlphaBatchResult,
  CompositeAlphaBatchItem,
  CompositeAlphaResult,
  CompositeDirection,
} from './types';

/** 批量上限：与服务端 /api/quant/factor/composite/batch 的 20 只上限保持一致 */
const MAX_CODES = 20;
const PLACEHOLDER = '600519\n000858\nAAPL\n00700';

const DIRECTION_LABEL: Record<CompositeDirection, string> = {
  up: '看多',
  down: '看空',
  neutral: '中性',
};

function dirCls(d: CompositeDirection): string {
  return d === 'up' ? 'sig-valid' : d === 'down' ? 'sig-inverted' : 'sig-none';
}

/** 解析用户输入的代码串：支持换行 / 逗号 / 空格 / 分号分隔 */
function parseCodes(text: string): string[] {
  return text
    .split(/[\n,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 解析持有期串：默认 [21, 63]；非法项丢弃，全非法则回落默认 */
function parseHorizons(text: string): number[] {
  const parsed = text
    .split(/[\n,，;；\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  return parsed.length > 0 ? [...new Set(parsed)] : [21, 63];
}

/**
 * 取「主窗口」：显著因子最多的持有期（平手取首个）。汇总列（一致率/主导因子）以它为准，
 * 避免把不同窗口的数字混在一起展示。
 */
function primaryHorizon(r: CompositeAlphaResult) {
  const hs = r.compositeAlpha.horizons ?? [];
  return (
    hs.reduce<(typeof hs)[number] | null>(
      (best, h) => (best === null || h.significantCount > best.significantCount ? h : best),
      null,
    ) ?? null
  );
}

function horizonLabel(period: number): string {
  return period === 21 ? '1月' : period === 63 ? '3月' : `${period}日`;
}

/** 导出为 CSV（含 BOM，Excel 直接打开不乱码） */
function exportCsv(result: CompositeAlphaBatchResult) {
  const header = [
    '代码',
    '市场',
    '基准secid',
    '综合方向',
    '综合α',
    '显著因子',
    '一致率',
    '主导因子',
    'K线数',
    '数据起',
    '数据止',
    '基准可用',
  ];
  const rows = result.items.map((it) => {
    if (!it.ok) {
      return [it.stockCode, '', '', '失败', '', '', '', '', '', '', '', it.error];
    }
    const r = it.result;
    const ph = primaryHorizon(r);
    const top = ph?.topContributors?.[0];
    return [
      r.stockCode,
      r.market,
      r.benchmarkSecid,
      DIRECTION_LABEL[r.compositeAlpha.overallDirection],
      r.compositeAlpha.overallAlpha.toFixed(4),
      ph ? `${ph.significantCount}/${ph.evaluableCount}` : '',
      ph ? `${(ph.agreement * 100).toFixed(0)}%` : '',
      top ? `${top.name}(${top.effectiveIc.toFixed(3)})` : '',
      String(r.bars),
      r.dataRange.start,
      r.dataRange.end,
      r.benchmarkAvailable ? '是' : '否',
    ];
  });
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `组合alpha批量测算_${result.startDate}_${result.endDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function CompositeBatchPanel() {
  const [codesText, setCodesText] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [horizonsText, setHorizonsText] = useState('21,63');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompositeAlphaBatchResult | null>(null);
  const [sortByAlpha, setSortByAlpha] = useState(true);

  const codes = useMemo(() => parseCodes(codesText), [codesText]);
  const tooMany = codes.length > MAX_CODES;

  const handleRun = useCallback(async () => {
    const list = parseCodes(codesText);
    if (list.length === 0) {
      setError('请至少输入一个股票代码');
      return;
    }
    if (list.length > MAX_CODES) {
      setError(`单次最多测算 ${MAX_CODES} 只，当前 ${list.length} 只`);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await runBatchCompositeAlpha({
        stockCodes: list,
        // 留空则由服务端取默认区间（近两年 / 今天）
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        horizons: parseHorizons(horizonsText),
      });
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '批量测算失败');
    } finally {
      setLoading(false);
    }
  }, [codesText, startDate, endDate, horizonsText]);

  /** 排序：默认按综合 α 降序（看多在前），关闭则保持服务端返回的输入顺序 */
  const items: CompositeAlphaBatchItem[] = useMemo(() => {
    if (!result) return [];
    if (!sortByAlpha) return result.items;
    return [...result.items].sort((a, b) => {
      const av = a.ok ? a.result.compositeAlpha.overallAlpha : Number.NEGATIVE_INFINITY;
      const bv = b.ok ? b.result.compositeAlpha.overallAlpha : Number.NEGATIVE_INFINITY;
      return bv - av;
    });
  }, [result, sortByAlpha]);

  return (
    <div className="card quant-panel batch-panel">
      <h3 className="quant-panel-title">
        组合 alpha 批量测算
        <span className="factor-subtitle">
          多只股票的方向性组合信号（时间序列 IC 口径，不跑回测），单次最多 {MAX_CODES} 只
        </span>
      </h3>

      <div className="batch-form">
        <label className="batch-field">
          <span className="batch-label">股票代码</span>
          <textarea
            className="batch-codes"
            rows={5}
            placeholder={PLACEHOLDER}
            value={codesText}
            disabled={loading}
            onChange={(e) => setCodesText(e.target.value)}
          />
          <span className={`batch-hint ${tooMany ? 'batch-hint-error' : ''}`}>
            已识别 {codes.length} 只{tooMany ? `（超出上限 ${MAX_CODES}）` : ''} ·
            支持换行/逗号/空格分隔
          </span>
        </label>

        <div className="batch-field-row">
          <label className="batch-field">
            <span className="batch-label">开始日期</span>
            <input
              type="date"
              className="batch-input"
              value={startDate}
              disabled={loading}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <span className="batch-hint">留空 = 近两年</span>
          </label>
          <label className="batch-field">
            <span className="batch-label">结束日期</span>
            <input
              type="date"
              className="batch-input"
              value={endDate}
              disabled={loading}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <span className="batch-hint">留空 = 今天</span>
          </label>
          <label className="batch-field">
            <span className="batch-label">持有期（交易日）</span>
            <input
              type="text"
              className="batch-input"
              value={horizonsText}
              disabled={loading}
              onChange={(e) => setHorizonsText(e.target.value)}
            />
            <span className="batch-hint">默认 21,63（1月/3月）</span>
          </label>
        </div>

        <div className="batch-actions">
          <button className="btn-primary" onClick={handleRun} disabled={loading}>
            {loading ? '测算中…' : '开始测算'}
          </button>
          {result && result.items.length > 0 && (
            <>
              <button className="btn-ghost" onClick={() => exportCsv(result)}>
                导出 CSV
              </button>
              <label className="batch-checkbox">
                <input
                  type="checkbox"
                  checked={sortByAlpha}
                  disabled={loading}
                  onChange={(e) => setSortByAlpha(e.target.checked)}
                />
                按综合 α 降序
              </label>
            </>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && <p className="batch-loading">正在逐只拉取 K 线与市场基准…</p>}

      {result && !loading && (
        <>
          <p className="batch-summary">
            请求 {result.requested} 只 · 成功 <b>{result.succeeded}</b> · 失败{' '}
            <b className={result.failed > 0 ? 'negative' : ''}>{result.failed}</b> · 区间{' '}
            {result.startDate} ~ {result.endDate}
          </p>
          {result.items.length === 0 ? (
            <p className="batch-empty">无有效结果</p>
          ) : (
            <div className="batch-table-wrap">
              <table className="batch-table">
                <thead>
                  <tr>
                    <th>代码</th>
                    <th>市场 / 基准</th>
                    <th>综合方向</th>
                    <th>综合 α</th>
                    <th>各持有期 α</th>
                    <th>显著因子</th>
                    <th>一致率</th>
                    <th>主导因子</th>
                    <th>K线</th>
                    <th>基准</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    if (!it.ok) {
                      return (
                        <tr key={it.stockCode} className="batch-row-error">
                          <td>{it.stockCode}</td>
                          <td colSpan={9} className="batch-error-text">
                            {it.error}
                          </td>
                        </tr>
                      );
                    }
                    const r = it.result;
                    const ph = primaryHorizon(r);
                    const top = ph?.topContributors?.[0];
                    return (
                      <tr key={r.stockCode}>
                        <td className="batch-code">{r.stockCode}</td>
                        <td className="batch-market">
                          {r.market}
                          <span className="batch-secid">{r.benchmarkSecid}</span>
                        </td>
                        <td>
                          <span
                            className={`batch-dir ${dirCls(r.compositeAlpha.overallDirection)}`}
                          >
                            {DIRECTION_LABEL[r.compositeAlpha.overallDirection]}
                          </span>
                        </td>
                        <td className={`batch-alpha ${dirCls(r.compositeAlpha.overallDirection)}`}>
                          {r.compositeAlpha.overallAlpha >= 0 ? '+' : ''}
                          {r.compositeAlpha.overallAlpha.toFixed(3)}
                        </td>
                        <td className="batch-horizons">
                          {r.compositeAlpha.horizons.map((h) => (
                            <span key={h.period} className="batch-horizon">
                              <span className="batch-horizon-period">{horizonLabel(h.period)}</span>
                              <span className={`batch-alpha ${dirCls(h.direction)}`}>
                                {h.alpha >= 0 ? '+' : ''}
                                {h.alpha.toFixed(3)}
                              </span>
                            </span>
                          ))}
                        </td>
                        <td>{ph ? `${ph.significantCount}/${ph.evaluableCount}` : '—'}</td>
                        <td>{ph ? `${(ph.agreement * 100).toFixed(0)}%` : '—'}</td>
                        <td className="batch-top">
                          {top ? `${top.name} ${top.effectiveIc.toFixed(3)}` : '—'}
                        </td>
                        <td
                          className="batch-bars"
                          title={`${r.dataRange.start} ~ ${r.dataRange.end}`}
                        >
                          {r.bars}
                        </td>
                        <td>
                          {r.benchmarkAvailable ? '✓' : <span className="factor-muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="batch-footnote">
            仅纳入统计显著（p&lt;0.05）因子，按 |t| 置信度加权方向校正 IC
            合成；市场基准按市场自动选宽基 （A 股沪深300 / 美股标普500 /
            港股恒生），拉取失败时该只降级为「无市场收益」（Beta 类因子不参与加权）。回看不足（≥316
            根 K 线才有 63 日窗口）时对应窗口无预测力。
          </p>
        </>
      )}
    </div>
  );
}

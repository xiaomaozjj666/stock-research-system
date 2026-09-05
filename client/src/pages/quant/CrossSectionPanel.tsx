import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { getUniverseBoards, runCrossSectionEvaluation } from '../../api/client';
import type {
  CrossSectionResult,
  CrossSectionFactor,
  CrossSectionPeriodReport,
  IndustryBoard,
} from './types';

/** 与服务端 MAX_CODES 上限一致（QUANT_CROSS_SECTION_MAX_CODES，默认 300） */
const MAX_CODES = 300;

/** 因子中文显示名：量价（与 FactorPanel 一致）+ 基本面/事件 */
const FACTOR_LABELS: Record<string, string> = {
  volatility_1m: '1月波动率',
  volatility_3m: '3月波动率',
  idiosyncratic_vol: '特异波动率',
  reversal_1m: '1月反转',
  reversal_3m: '3月反转',
  residual_momentum_6m: '残差动量(6月)',
  momentum_12_1: '12-1动量',
  turnover_ratio_reversal: '换手率反转',
  amihud_illiquidity: 'Amihud非流动性',
  beta: '贝塔',
  max_daily_return_1m: '1月最大日收益',
  cs_roe: 'ROE（年报）',
  cs_gross_margin: '毛利率（年报）',
  cs_net_profit_growth: '净利增速（年报）',
  cs_debt_ratio: '资产负债率（年报）',
  cs_np_yoy_q: '单季净利同比（季度）',
  cs_roe_slope: 'ROE逐季斜率（季度）',
  ev_earnings_surprise: '业绩超预期（PEAD事件）',
  ev_dividend_yield: '分红股息率（事件）',
  ev_buyback_ratio: '回购力度（事件）',
  ev_unlock_overhang: '解禁压力（事件）',
};

const TYPE_LABELS: Record<CrossSectionFactor['type'], string> = {
  price_volume: '量价',
  fundamental: '基本面',
  event: '事件',
};

function parseCodes(text: string): string[] {
  return text
    .split(/[\n,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseHorizons(text: string): number[] {
  const parsed = text
    .split(/[\n,，;；\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 250)
    .map((n) => Math.floor(n));
  return parsed.length > 0 ? [...new Set(parsed)] : [21, 63];
}

function periodLabel(period: number): string {
  return period === 21 ? '1月' : period === 63 ? '3月' : `${period}日`;
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

/** 单持有期截面 IC 单元格：均值（按显著与方向着色）+ p 值 + OOS */
function IcCell({ p }: { p: CrossSectionPeriodReport }) {
  const sig = p.ic.pValue < 0.05;
  const stable = p.oos.stable;
  const cls = sig ? (p.ic.mean > 0 ? 'sig-valid' : 'sig-inverted') : 'sig-none';
  return (
    <div className="cs-ic-cell">
      <div className={`cs-ic-mean ${cls}`}>
        {p.ic.mean >= 0 ? '+' : ''}
        {p.ic.mean.toFixed(3)}
      </div>
      <div className="cs-ic-meta">
        p={p.ic.pValue < 1e-4 ? '<1e-4' : p.ic.pValue.toFixed(3)} · {p.ic.n}日
      </div>
      <div className={`cs-oos ${stable ? 'cs-oos-ok' : 'cs-oos-no'}`}>
        {stable ? 'OOS稳定' : 'OOS不稳'}
      </div>
    </div>
  );
}

export default function CrossSectionPanel({ active = true }: { active?: boolean }) {
  const [source, setSource] = useState<'board' | 'codes'>('board');
  const [boards, setBoards] = useState<IndustryBoard[]>([]);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  // 板块默认留空，列表加载成功后自动选第一个——板块代码会随数据源体系调整
  // （BK0475 曾是白酒、后为银行），硬编码默认值不可靠
  const [board, setBoard] = useState('');
  const [topN, setTopN] = useState(10);
  const [codesText, setCodesText] = useState('');
  const [horizonsText, setHorizonsText] = useState('21,63');
  const [includeFundamental, setIncludeFundamental] = useState(true);
  // 事件族（分红/回购/解禁 + PEAD）：默认开启；关闭可省去事件源网络调用
  const [includeEvents, setIncludeEvents] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CrossSectionResult | null>(null);
  /** 已耗时（秒）：真实计时 */
  const [elapsedSec, setElapsedSec] = useState(0);
  const startAtRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 面板常驻挂载（模式切换不丢结果），板块列表延迟到首次激活才拉取
  const [hasBeenActive, setHasBeenActive] = useState(active);
  useEffect(() => {
    if (active) setHasBeenActive(true);
  }, [active]);
  useEffect(() => {
    if (!hasBeenActive) return;
    let alive = true;
    getUniverseBoards()
      .then((d) => {
        if (!alive) return;
        setBoards(d.boards ?? []);
        // 未选择过板块时默认取第一个，保证「加载完即可运行」
        setBoard((prev) => prev || d.boards?.[0]?.code || '');
      })
      .catch((e: Error) => {
        if (alive) setBoardsError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [hasBeenActive]);

  // 评估期间真实计时
  useEffect(() => {
    if (!loading) {
      if (tickerRef.current) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
      return;
    }
    startAtRef.current = Date.now();
    setElapsedSec(0);
    tickerRef.current = setInterval(() => {
      setElapsedSec(Math.round((Date.now() - startAtRef.current) / 1000));
    }, 1000);
    return () => {
      if (tickerRef.current) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
    };
  }, [loading]);

  const codes = useMemo(() => parseCodes(codesText), [codesText]);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const horizons = parseHorizons(horizonsText);
      const data = await runCrossSectionEvaluation(
        source === 'board'
          ? { board, topN, horizons, includeFundamental, includeEvents }
          : {
              codes: codes.slice(0, MAX_CODES),
              horizons,
              includeFundamental,
              includeEvents,
            },
      );
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '截面因子评估失败');
    } finally {
      setLoading(false);
    }
  }, [source, board, topN, codesText, codes, horizonsText, includeFundamental, includeEvents]);

  const canRun = source === 'board' ? !!board : codes.length >= 2;

  return (
    <div className="card quant-panel cs-panel">
      <h3 className="quant-panel-title">
        截面因子评估
        <span className="factor-subtitle">
          行业横截面上的因子有效性（alphalens 口径：逐日截面 IC + Newey-West + 分层收益 + OOS
          复核）——横截面越宽，统计功效越高
        </span>
      </h3>

      <div className="batch-form">
        <div className="cs-source-row" role="group" aria-label="universe 来源">
          <button
            type="button"
            className={`quant-mode ${source === 'board' ? 'active' : ''}`}
            onClick={() => setSource('board')}
            disabled={loading}
          >
            按行业板块
          </button>
          <button
            type="button"
            className={`quant-mode ${source === 'codes' ? 'active' : ''}`}
            onClick={() => setSource('codes')}
            disabled={loading}
          >
            手输代码
          </button>
        </div>

        {source === 'board' ? (
          <div className="batch-field-row">
            <label className="batch-field">
              <span className="batch-label">行业板块</span>
              <select
                className="batch-input"
                value={board}
                disabled={loading}
                onChange={(e) => setBoard(e.target.value)}
              >
                {!boards.length && (
                  <option value="">{boardsError ? '板块列表不可用' : '加载板块中…'}</option>
                )}
                {boards.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}（{b.code}）
                  </option>
                ))}
              </select>
              <span className="batch-hint">
                {boardsError
                  ? `板块列表加载失败：${boardsError}，可直接使用板块代码`
                  : `${boards.length} 个行业板块 · 成分股取总市值前 N 只`}
              </span>
            </label>
            <label className="batch-field">
              <span className="batch-label">成分股数量（topN）</span>
              <input
                type="number"
                className="batch-input"
                min={3}
                max={MAX_CODES}
                value={topN}
                disabled={loading}
                onChange={(e) => setTopN(Number(e.target.value))}
              />
              <span className="batch-hint">
                3-300；越大截面统计功效越强，数百只全市场面板冷启动可能耗时数分钟
              </span>
            </label>
          </div>
        ) : (
          <label className="batch-field">
            <span className="batch-label">股票代码（2-{MAX_CODES} 只）</span>
            <textarea
              className="batch-codes"
              rows={4}
              placeholder={'600519\n000858\n603288'}
              value={codesText}
              disabled={loading}
              onChange={(e) => setCodesText(e.target.value)}
            />
            <span className="batch-hint">6 位 A 股代码，换行/逗号/空格分隔</span>
          </label>
        )}

        <div className="batch-field-row">
          <label className="batch-field">
            <span className="batch-label">持有期（交易日）</span>
            <input
              type="text"
              className="batch-input"
              value={horizonsText}
              disabled={loading}
              onChange={(e) => setHorizonsText(e.target.value)}
            />
            <span className="batch-hint">默认 21,63</span>
          </label>
          <label className="batch-checkbox cs-fundamental-toggle">
            <input
              type="checkbox"
              checked={includeFundamental}
              disabled={loading}
              onChange={(e) => setIncludeFundamental(e.target.checked)}
            />
            包含基本面因子（拉取财务 + 季度财报，耗时增加）
          </label>
          <label className="batch-checkbox cs-fundamental-toggle">
            <input
              type="checkbox"
              checked={includeEvents}
              disabled={loading}
              onChange={(e) => setIncludeEvents(e.target.checked)}
            />
            包含事件因子（分红/回购/解禁走事件数据源；PEAD 依赖财报）
          </label>
        </div>

        <div className="batch-actions">
          <button className="btn-primary" onClick={handleRun} disabled={loading || !canRun}>
            {loading ? '评估中…' : '开始评估'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && (
        <p className="batch-loading">
          正在逐只拉取行情与财务数据并装配截面面板…（已耗时 {elapsedSec} 秒）
        </p>
      )}

      {result && !loading && (
        <>
          <p className="batch-summary">
            {result.universe.source === 'board'
              ? `板块 ${result.universe.boardName ?? ''}（${result.universe.board}）`
              : '手输代码'}{' '}
            · 请求 {result.universe.requested} 只 · 入组 <b>{result.stocksIncluded.length}</b> ·
            跳过{' '}
            <b className={result.stocksSkipped.length > 0 ? 'negative' : ''}>
              {result.stocksSkipped.length}
            </b>{' '}
            · 因子 {result.factors.length} 个 · 持有期 {result.horizons.map(periodLabel).join('/')}
          </p>
          {result.stocksSkipped.length > 0 && (
            <div className="batch-notice">
              ⚠ 跳过：
              {result.stocksSkipped.map((s) => `${s.code}（${s.reason}）`).join('；')}
            </div>
          )}
          {result.factors.length === 0 ? (
            <p className="batch-empty">
              没有因子凑齐最低样本（每因子 ≥30 个观测）。截面宽度不足是主因——试试增大 topN
              或延长持有期。
            </p>
          ) : (
            <div className="batch-table-wrap">
              <table className="batch-table cs-table">
                <thead>
                  <tr>
                    <th>因子</th>
                    <th>类型</th>
                    {result.horizons.map((h) => (
                      <th key={h}>{periodLabel(h)}截面IC</th>
                    ))}
                    <th>单调性</th>
                    <th>多空价差</th>
                    <th>多空净值</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  {result.factors.map((f) => {
                    const byPeriod = new Map(f.report.byPeriod.map((p) => [p.period, p]));
                    const lastPeriod = f.report.byPeriod[f.report.byPeriod.length - 1];
                    return (
                      <tr key={f.name}>
                        <td className="batch-code" title={f.name}>
                          {FACTOR_LABELS[f.name] ?? f.name}
                        </td>
                        <td>{TYPE_LABELS[f.type]}</td>
                        {result.horizons.map((h) => {
                          const p = byPeriod.get(h);
                          return p ? (
                            <td key={h}>
                              <IcCell p={p} />
                            </td>
                          ) : (
                            <td key={h} className="factor-muted">
                              样本不足
                            </td>
                          );
                        })}
                        <td>{lastPeriod ? lastPeriod.quantile.monotonicity.toFixed(2) : '—'}</td>
                        <td>{lastPeriod ? fmtPct(lastPeriod.quantile.spread) : '—'}</td>
                        <td>{lastPeriod ? lastPeriod.longShortCumulative.toFixed(3) : '—'}</td>
                        <td>
                          {lastPeriod ? (
                            <span
                              className={`factor-badge ${lastPeriod.verdict.effective ? 'sig-valid' : 'sig-none'}`}
                              title={lastPeriod.verdict.reasons.join('；')}
                            >
                              {lastPeriod.verdict.effective ? '有效' : '未通过'}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="batch-footnote">
            截面 IC：每个交易日对「当日有数据的股票」计算因子值与远期收益的 Spearman 秩相关，再做
            Newey-West（maxLag = period−1）显著性检验；OOS 稳定 = 前 70%/后 30%
            两段方向同号且均显著。「判定 = 有效」要求 IC 显著 + 分层单调 ≥0.6 +
            多空价差为正三条全部成立。因子值在评估窗口内为常数的基本面因子，截面排序不变，IC
            依然可解释。
          </p>
        </>
      )}
    </div>
  );
}

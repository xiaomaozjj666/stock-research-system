import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import {
  AnalysisCancelledError,
  getUniverseBoards,
  runCrossSectionEvaluation,
} from '../../api/client';
import { useToast } from '../../components/Toast';
import type {
  CrossSectionResult,
  CrossSectionFactor,
  CrossSectionPeriodReport,
  IndustryBoard,
} from './types';

/** 与服务端 MAX_CODES 上限一致（QUANT_CROSS_SECTION_MAX_CODES，默认 300） */
const MAX_CODES = 300;

/** 默认首跑板块按名称优先级挑选：白酒/银行成分股同质性强、体量适中；
 * 东财板块列表按总市值降序，第一项「电子」大而杂，不适合做首次运行默认。
 * 按名称而非 BK 码匹配——板块代码会随数据源体系漂移（BK0475 曾是白酒、后为银行） */
const PREFERRED_DEFAULT_BOARDS = ['白酒', '银行'];

/** 组合回测默认参数：请求体与界面文案共用一处定义，改这里即可同步 */
const PORTFOLIO_DEFAULTS = { holdDays: 21, topN: 5, costBps: 30 } as const;

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
  mg_balance_chg20: '两融余额20日变化（资金）',
  mg_balance_pct: '两融余额占市值比（资金）',
  ev_earnings_surprise: '业绩超预期（PEAD事件）',
  ev_dividend_yield: '分红股息率（事件）',
  ev_buyback_ratio: '回购力度（事件）',
  ev_unlock_overhang: '解禁压力（事件）',
  ev_dragon_tiger: '龙虎榜净买入（事件）',
  pat_turtle_breakout: '海龟突破（形态）',
  pat_ma_volume_breakout: '均线上穿放量（形态）',
  pat_limit_up: '涨停强度（形态）',
};

const TYPE_LABELS: Record<CrossSectionFactor['type'], string> = {
  price_volume: '量价',
  fundamental: '基本面',
  event: '事件',
  pattern: '形态',
  margin: '两融',
};

/** 整数入参钳制：非法值回退默认，范围 [min,max] */
function clampInt(v: number, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number.isFinite(v) ? v : dflt);
  return Math.min(max, Math.max(min, n));
}

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
  const { showToast } = useToast();
  const [source, setSource] = useState<'board' | 'codes' | 'index'>('board');
  /** 指数历史成分源（Baostock sidecar）：指数与可选快照日期 */
  const [indexName, setIndexName] = useState<'hs300' | 'zz500' | 'sz50'>('hs300');
  const [indexDate, setIndexDate] = useState('');
  const [boards, setBoards] = useState<IndustryBoard[]>([]);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  // 板块默认留空，列表加载成功后自动选第一个——板块代码会随数据源体系调整
  // （BK0475 曾是白酒、后为银行），硬编码默认值不可靠
  const [board, setBoard] = useState('');
  const [topN, setTopN] = useState(10);
  const [codesText, setCodesText] = useState('');
  const [horizonsText, setHorizonsText] = useState('21,63');
  const [includeFundamental, setIncludeFundamental] = useState(true);
  /** 组合回测（可选）：为全部因子附「按它交易」的 PnL 视角 */
  const [portfolioOn, setPortfolioOn] = useState(false);
  // 组合回测参数：默认取 PORTFOLIO_DEFAULTS，界面可调（请求与展示共用同一 state）
  const [portfolioHoldDays, setPortfolioHoldDays] = useState<number>(PORTFOLIO_DEFAULTS.holdDays);
  const [portfolioTopN, setPortfolioTopN] = useState<number>(PORTFOLIO_DEFAULTS.topN);
  const [portfolioCostBps, setPortfolioCostBps] = useState<number>(PORTFOLIO_DEFAULTS.costBps);
  // 事件族（分红/回购/解禁 + PEAD）：默认开启；关闭可省去事件源网络调用
  const [includeEvents, setIncludeEvents] = useState(true);
  // 两融族（融资余额变化率/拥挤度，PIT + T+1 披露）：默认开启；关闭可省去两融源网络调用
  const [includeMargin, setIncludeMargin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CrossSectionResult | null>(null);
  /** 已耗时（秒）：真实计时 */
  const [elapsedSec, setElapsedSec] = useState(0);
  const startAtRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 在途评估请求的中止器：数百只大面板冷启动可达数分钟，用户应能中途撤回 */
  const abortRef = useRef<AbortController | null>(null);
  /** 卸载标记：卸载触发的 abort 不应弹「已取消」提示（ToastProvider 在组件树外，卸载后弹窗仍会显示） */
  const unmountedRef = useRef(false);

  // 卸载时中止在途请求，避免向已卸载组件 setState
  useEffect(
    () => () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
    },
    [],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
        // 未选择过板块时按名称优先级取默认，保证「加载完即可运行」
        setBoard(
          (prev) =>
            prev ||
            d.boards?.find((b) => PREFERRED_DEFAULT_BOARDS.includes(b.name))?.code ||
            d.boards?.[0]?.code ||
            '',
        );
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

  /** 因子名 → 持有期报告表：渲染前统一构建一次，避免每次重渲染逐因子重建 Map */
  const byPeriodMaps = useMemo(() => {
    const m = new Map<string, Map<number, CrossSectionPeriodReport>>();
    for (const f of result?.factors ?? []) {
      m.set(f.name, new Map(f.report.byPeriod.map((p) => [p.period, p])));
    }
    return m;
  }, [result]);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const horizons = parseHorizons(horizonsText);
      const common = {
        horizons,
        includeFundamental,
        includeEvents,
        includeMargin,
        ...(portfolioOn
          ? {
              portfolio: {
                holdDays: clampInt(portfolioHoldDays, 5, 250, PORTFOLIO_DEFAULTS.holdDays),
                topN: clampInt(portfolioTopN, 1, 20, PORTFOLIO_DEFAULTS.topN),
                costBps: clampInt(portfolioCostBps, 0, 200, PORTFOLIO_DEFAULTS.costBps),
              },
            }
          : {}),
      };
      const data = await runCrossSectionEvaluation(
        source === 'board'
          ? { board, topN, ...common }
          : source === 'index'
            ? {
                indexUniverse: {
                  index: indexName,
                  ...(indexDate.trim() ? { date: indexDate.trim() } : {}),
                },
                ...common,
              }
            : { codes: codes.slice(0, MAX_CODES), ...common },
        controller.signal,
      );
      setResult(data);
    } catch (e) {
      if (unmountedRef.current) return; // 卸载触发的中止：不弹提示、不再 setState
      if (e instanceof AnalysisCancelledError) {
        showToast('已取消本次评估');
      } else {
        setError(e instanceof Error ? e.message : '截面因子评估失败');
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [
    source,
    board,
    topN,
    indexName,
    indexDate,
    codesText,
    codes,
    horizonsText,
    includeFundamental,
    includeEvents,
    includeMargin,
    portfolioOn,
    portfolioHoldDays,
    portfolioTopN,
    portfolioCostBps,
    showToast,
  ]);

  const canRun = source === 'board' ? !!board : source === 'index' ? true : codes.length >= 2;

  // 板块中文名从本面板已加载的板块列表解析（下拉是板块唯一入口，必有名称）；
  // 服务端不再为取名字多发一次板块列表请求
  const boardLabel = useMemo(() => {
    if (!result || result.universe.source !== 'board') return '';
    const name = boards.find((b) => b.code === result.universe.board)?.name;
    return name ? `${name}（${result.universe.board}）` : `${result.universe.board}`;
  }, [result, boards]);

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
            className={`quant-mode ${source === 'index' ? 'active' : ''}`}
            onClick={() => setSource('index')}
            disabled={loading}
          >
            指数历史成分
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
                  ? `板块列表加载失败：${boardsError}，可切换「手输代码」模式评估个股组合`
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
        ) : source === 'index' ? (
          <div className="batch-field-row">
            <label className="batch-field">
              <span className="batch-label">指数</span>
              <select
                className="batch-input"
                value={indexName}
                disabled={loading}
                onChange={(e) => setIndexName(e.target.value as 'hs300' | 'zz500' | 'sz50')}
              >
                <option value="hs300">沪深300</option>
                <option value="zz500">中证500</option>
                <option value="sz50">上证50</option>
              </select>
              <span className="batch-hint">
                历史成分快照（Baostock），含其后退市的证券——可正面观察幸存者偏差
              </span>
            </label>
            <label className="batch-field">
              <span className="batch-label">快照日期（可选）</span>
              <input
                type="date"
                className="batch-input"
                value={indexDate}
                disabled={loading}
                onChange={(e) => setIndexDate(e.target.value)}
              />
              <span className="batch-hint">留空 = 最新成分；指定日期取该日前最近一次调仓名单</span>
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
          <div className="cs-toggles">
            <label className="batch-checkbox cs-fundamental-toggle">
              <input
                type="checkbox"
                checked={includeFundamental}
                disabled={loading}
                onChange={(e) => setIncludeFundamental(e.target.checked)}
              />
              包含基本面因子（拉取财务 + 季度财报）
            </label>
            <label className="batch-checkbox cs-fundamental-toggle">
              <input
                type="checkbox"
                checked={includeEvents}
                disabled={loading}
                onChange={(e) => setIncludeEvents(e.target.checked)}
              />
              包含事件因子（分红/回购/解禁 + PEAD）
            </label>
            <label className="batch-checkbox cs-fundamental-toggle">
              <input
                type="checkbox"
                checked={includeMargin}
                disabled={loading}
                onChange={(e) => setIncludeMargin(e.target.checked)}
              />
              包含两融因子（融资余额变化率/拥挤度）
            </label>
            <label className="batch-checkbox cs-fundamental-toggle">
              <input
                type="checkbox"
                checked={portfolioOn}
                disabled={loading}
                onChange={(e) => setPortfolioOn(e.target.checked)}
              />
              因子组合回测
            </label>
            {portfolioOn && (
              <>
                <label className="batch-checkbox cs-fundamental-toggle">
                  调仓周期
                  <input
                    type="number"
                    min={5}
                    max={250}
                    value={portfolioHoldDays}
                    disabled={loading}
                    onChange={(e) => setPortfolioHoldDays(Number(e.target.value))}
                    style={{ width: 64 }}
                  />
                  日
                </label>
                <label className="batch-checkbox cs-fundamental-toggle">
                  持仓只数
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={portfolioTopN}
                    disabled={loading}
                    onChange={(e) => setPortfolioTopN(Number(e.target.value))}
                    style={{ width: 56 }}
                  />
                </label>
                <label className="batch-checkbox cs-fundamental-toggle">
                  单边成本
                  <input
                    type="number"
                    min={0}
                    max={200}
                    value={portfolioCostBps}
                    disabled={loading}
                    onChange={(e) => setPortfolioCostBps(Number(e.target.value))}
                    style={{ width: 56 }}
                  />
                  bps
                </label>
              </>
            )}
          </div>
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
      {loading && (
        <button type="button" className="btn-ghost" onClick={handleCancel}>
          取消评估
        </button>
      )}

      {result && !loading && (
        <>
          <p className="batch-summary">
            {result.universe.source === 'board'
              ? `板块 ${boardLabel}`
              : result.universe.source === 'index'
                ? `指数历史成分（${result.universe.index ?? ''}${
                    result.universe.updateDate ? ` @ ${result.universe.updateDate}` : ''
                  }）`
                : '手输代码'}{' '}
            · 请求 {result.universe.requested} 只 · 入组 <b>{result.stocksIncluded.length}</b> ·
            跳过{' '}
            <b className={result.stocksSkipped.length > 0 ? 'negative' : ''}>
              {result.stocksSkipped.length}
            </b>{' '}
            · 因子 {result.factors.length} 个 · 持有期 {result.horizons.map(periodLabel).join('/')}
          </p>
          {result.universe.survivorshipNote && (
            <p className="batch-hint">{result.universe.survivorshipNote}</p>
          )}
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
                    const byPeriod = byPeriodMaps.get(f.name)!;
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
          {result.factors.some((f) => f.portfolio) && (
            <div className="batch-table-wrap">
              <table className="batch-table cs-table">
                <thead>
                  <tr>
                    <th>
                      因子组合回测（{portfolioHoldDays}日调仓 · top-
                      {portfolioTopN} 等权 · {portfolioCostBps}bps）
                    </th>
                    <th>期数</th>
                    <th>总收益</th>
                    <th>年化</th>
                    <th>夏普</th>
                    <th>最大回撤</th>
                    <th>周期胜率</th>
                    <th>平均换手</th>
                  </tr>
                </thead>
                <tbody>
                  {result.factors
                    .filter((f) => f.portfolio)
                    .sort((a, b) => b.portfolio!.totalReturn - a.portfolio!.totalReturn)
                    .map((f) => (
                      <tr key={`pf-${f.name}`}>
                        <td className="batch-code" title={f.name}>
                          {FACTOR_LABELS[f.name] ?? f.name}
                        </td>
                        <td>{f.portfolio!.periods}</td>
                        <td
                          className={f.portfolio!.totalReturn >= 0 ? 'sig-valid' : 'sig-inverted'}
                        >
                          {f.portfolio!.totalReturn >= 0 ? '+' : ''}
                          {f.portfolio!.totalReturn.toFixed(1)}%
                        </td>
                        <td>{f.portfolio!.annualizedReturn.toFixed(1)}%</td>
                        <td>{f.portfolio!.sharpe.toFixed(2)}</td>
                        <td>{f.portfolio!.maxDrawdown.toFixed(1)}%</td>
                        <td>{f.portfolio!.winRate.toFixed(0)}%</td>
                        <td>{(f.portfolio!.avgTurnover * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <p className="batch-footnote">
                基准 = 候选宇宙等权（因子中性对照）；T+1 次日开盘撮合、涨停不建模。
              </p>
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

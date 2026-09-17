import { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import EChart from '../../components/EChart';
import {
  getPaperPortfolio,
  placePaperOrder,
  settlePaperDay,
  getPaperStats,
  getAuditLog,
  getIntlFundamentals,
  getIntlKlines,
  normalizeApiError,
} from '../../api/client';
import type { IntlKline } from '../../api/client';
import StockSearchInput from '../../components/StockSearchInput';
import type {
  PaperPortfolio,
  PaperStats,
  PaperOrder,
  AuditEntry,
  AuditRiskLevel,
  IntlFundamentalsResult,
} from '../../types';

/**
 * 审计日志每页条数。
 * 此前固定 `entries.slice(0, 20)` 且不显示总数，超出部分没有任何提示，
 * 用户会以为"审计日志只有 20 条"（合规查询场景下这是误导）。
 */
const AUDIT_PAGE_SIZE = 20;

/** 订单状态 → 徽章样式 */
function orderBadge(status: PaperOrder['status']): { text: string; cls: string } {
  switch (status) {
    case 'filled':
      return { text: '已成交', cls: 'chip-positive' };
    case 'rejected':
      return { text: '已拒绝', cls: 'chip-negative' };
    case 'expired':
      return { text: '已过期', cls: 'chip-neutral' };
    default:
      return { text: '挂单中', cls: 'chip-neutral' };
  }
}

/** 净值折线图：现金额+持仓市值（¥）；日收益用柱状副轴过重，保留表格看明细 */
function PaperEquityChart({ equity }: { equity: { date: string; value: number }[] }) {
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 72, right: 12, top: 16, bottom: 24 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: equity.map((e) => e.date),
        axisLabel: { color: '#657181', fontSize: 10 },
        axisLine: { lineStyle: { color: '#333f4e' } },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: {
          color: '#657181',
          fontSize: 10,
          formatter: (v: number) => `¥${(v / 10000).toFixed(1)}万`,
        },
        splitLine: { lineStyle: { color: '#232b37' } },
      },
      series: [
        {
          name: '净值',
          type: 'line',
          showSymbol: equity.length <= 30,
          data: equity.map((e) => e.value),
          lineStyle: { width: 2, color: '#4c8dff' },
          itemStyle: { color: '#4c8dff' },
          areaStyle: { color: 'rgba(76, 141, 255, 0.08)' },
        },
      ],
    }),
    [equity],
  );
  const allFlat = new Set(equity.map((e) => e.value)).size === 1;
  return (
    <div>
      {allFlat && (
        <p className="paper-note" role="status">
          账户暂无盈亏变化（各结算点净值相同）：买入成交并完成日终结算后，曲线开始分化。
        </p>
      )}
      <EChart option={option} className="paper-equity-chart" />
    </div>
  );
}

/** 审计风险等级 → 中文徽章（等级原值保留用于过滤，展示一律中文） */
const AUDIT_LEVEL_LABEL: Record<AuditRiskLevel, string> = {
  info: '提示',
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
};

function riskBadge(level: AuditRiskLevel): { text: string; cls: string } {
  if (level === 'critical' || level === 'high') {
    // 高危审计用 danger 红（状态语义），不用 negative 绿——那是「下跌」色
    return { text: AUDIT_LEVEL_LABEL[level], cls: 'chip-danger' };
  }
  return { text: AUDIT_LEVEL_LABEL[level] ?? level, cls: 'chip-neutral' };
}

const fmtMoney = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);

/** 今天是否周末（节假日不识别——若恰逢节假日，结算会按无收盘价如实拒绝/记录） */
function isWeekendToday(): boolean {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

/**
 * 最近交易日 YYYY-MM-DD（日终结算默认基准日）：
 * 今天是周六/周日时回退到周五——周末结算没有收盘价，挂单只会被拒、
 * 净值点也是无意义的平点（2026-09-05/09-12 两个周六的实测教训）。
 */
function latestTradingDayStr(): string {
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function PaperTradingPage() {
  // 表单控件 id：useId 生成保证唯一，供 <label htmlFor> 关联（不改 DOM 层级、不动样式）
  const orderSideId = useId();
  const orderTypeId = useId();
  const orderQtyId = useId();
  const orderPriceId = useId();
  const settleDateId = useId();
  const closePriceLabelId = useId();
  const intlCodeId = useId();
  const intlMarketId = useId();
  const auditLevelId = useId();

  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [stats, setStats] = useState<PaperStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 下单表单
  const [orderCode, setOrderCode] = useState('');
  const [orderName, setOrderName] = useState('');
  const [orderSide, setOrderSide] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [orderQty, setOrderQty] = useState('');
  const [orderPrice, setOrderPrice] = useState('');
  /**
   * 下单在途标记（独立于 loading）：
   * loading 只由 loadAccount() 驱动，handlePlaceOrder 全程不碰它，
   * 于是 POST 在途的 15 秒里每点一次就发一次，表单又要等成功后才清空 → 产生多笔完全相同的成交。
   */
  const [submitting, setSubmitting] = useState(false);

  // 日终结算：日期 + 按持仓代码填收盘价（缺省视为停牌）
  const [settleDate, setSettleDate] = useState(latestTradingDayStr());
  const [closePrices, setClosePrices] = useState<Record<string, string>>({});
  const [settling, setSettling] = useState(false);

  // 港美股查询
  const [intlCode, setIntlCode] = useState('');
  const [intlMarket, setIntlMarket] = useState<'' | 'HK' | 'US'>('');
  const [intlResult, setIntlResult] = useState<IntlFundamentalsResult | null>(null);
  const [intlKlines, setIntlKlines] = useState<IntlKline[] | null>(null);
  const [intlKlineError, setIntlKlineError] = useState<string | null>(null);
  const [intlLoading, setIntlLoading] = useState(false);
  /**
   * 港美股查询的请求序号：先查 00700 再查 TSLA 时，00700 后到的响应会让
   * 「输入框显示 TSLA、表格是腾讯」。两次 setState（含 intlLoading 复位）都要过这道守卫。
   */
  const intlSeqRef = useRef(0);

  // 审计日志
  const [auditLevel, setAuditLevel] = useState<AuditRiskLevel | ''>('');
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  /** 服务端返回的匹配总数（count）：用于「共 N 条」与「加载更多」的剩余量 */
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  /**
   * 已显示条数的 ref 镜像：offset 必须取「最新条数」，
   * 不能用渲染快照 auditEntries.length——同帧连点两次都带 offset: 20，去重后追加为空、
   * 总数又被写回，最后一页永远取不到。
   */
  const auditEntriesRef = useRef<AuditEntry[]>([]);
  /** 入口拦截：按钮 disabled 要等 React 提交才生效，挡不住同帧连点 */
  const loadingMoreRef = useRef(false);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pf, st] = await Promise.all([getPaperPortfolio(), getPaperStats()]);
      setPortfolio(pf);
      setStats(st);
    } catch (err) {
      setError(normalizeApiError(err, '读取模拟盘账户失败').message);
    } finally {
      setLoading(false);
    }
  }, []);

  const auditSeqRef = useRef(0);
  const loadAudit = useCallback(async () => {
    // 请求序守卫：快速切换风险等级时，只采纳最后一次请求的结果（旧响应乱序返回会被丢弃）
    const seq = ++auditSeqRef.current;
    try {
      const filter = auditLevel ? { riskLevel: auditLevel } : {};
      const res = await getAuditLog({ ...filter, limit: AUDIT_PAGE_SIZE, offset: 0 });
      if (seq !== auditSeqRef.current) return;
      // ref 是分页的权威来源：同步更新，不能等 effect（否则紧接着的"加载更多"
      // 会读到上一轮的条数，重复 offset 被去重后一行都加不上）
      auditEntriesRef.current = res.entries;
      setAuditEntries(res.entries);
      setAuditTotal(res.count);
    } catch {
      /* 审计查询失败不阻塞主流程 */
    }
  }, [auditLevel]);

  /** 「加载更多」：按 offset 取下一页并【追加】（不替换已显示条目） */
  const loadMoreAudit = useCallback(async () => {
    // 入口拦截：同帧连点两次时 setState 还没提交，disabled 挡不住第二次
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const seq = auditSeqRef.current; // 过滤条件已变化 → 本页作废，丢弃响应
    setAuditLoadingMore(true);
    try {
      const filter = auditLevel ? { riskLevel: auditLevel } : {};
      const res = await getAuditLog({
        ...filter,
        limit: AUDIT_PAGE_SIZE,
        // 最新条数（ref 镜像），不是上一次渲染的 auditEntries.length
        offset: auditEntriesRef.current.length,
      });
      if (seq !== auditSeqRef.current) return;
      // 追加而非替换；按 id 去重：审计日志持续写入，两次请求之间条目可能变动，
      // offset 窗口轻微错位时宁可少一行，不要同一行渲染两次（React key 冲突）。
      // 以 ref 为基准同步算出新数组并同时写回 ref 与 state：这样"取 offset → 追加"
      // 不依赖 effect 的提交时机，连点两次也能逐页推进。
      const prev = auditEntriesRef.current;
      const seen = new Set(prev.map((e) => e.id));
      const merged = [...prev, ...res.entries.filter((e) => !seen.has(e.id))];
      auditEntriesRef.current = merged;
      setAuditEntries(merged);
      setAuditTotal(res.count);
    } catch {
      /* 同上：加载更多失败不阻塞主流程 */
    } finally {
      loadingMoreRef.current = false;
      setAuditLoadingMore(false);
    }
  }, [auditLevel]);

  // 条数镜像已不需要：auditEntriesRef 在两个写入点（loadAudit / loadMoreAudit）
  // 与 setAuditEntries 同步更新，作为分页 offset 的唯一来源。留一条镜像 effect 反而
  // 会把"已算好的新数组"用上一轮渲染的 state 覆盖回去。

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  // 持仓变化时，初始化日终收盘价表单（仅按持仓代码）
  useEffect(() => {
    if (portfolio) {
      setClosePrices((prev) => {
        const next: Record<string, string> = {};
        for (const p of portfolio.positions) next[p.code] = prev[p.code] ?? '';
        return next;
      });
    }
  }, [portfolio]);

  const handlePlaceOrder = useCallback(async () => {
    // 入口拦截（不只是靠按钮 disabled）：同一帧内的第二次点击在 React 提交前就到达这里，
    // 资金类操作重复提交会产生多笔内容完全相同的成交
    if (submitting) return;
    const code = orderCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setError('股票代码需为 6 位数字');
      return;
    }
    const quantity = Number(orderQty);
    // 服务端会静默取整，前端必须先把非整数拦下（文案与判定保持一致）
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setError('数量必须为正整数');
      return;
    }
    if (orderType === 'limit') {
      const price = Number(orderPrice);
      if (!Number.isFinite(price) || price <= 0) {
        setError('限价单需提供正价格');
        return;
      }
    }
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await placePaperOrder({
        code,
        side: orderSide,
        type: orderType,
        quantity,
        price: orderType === 'limit' ? Number(orderPrice) : undefined,
        date: portfolio?.currentDate ?? undefined,
      });
      setMessage('下单成功，日终结算时按收盘价撮合');
      setOrderCode('');
      setOrderName('');
      setOrderQty('');
      setOrderPrice('');
      await loadAccount();
    } catch (err) {
      setError(normalizeApiError(err, '模拟下单失败').message);
    } finally {
      setSubmitting(false);
    }
  }, [orderCode, orderSide, orderType, orderQty, orderPrice, portfolio, loadAccount, submitting]);

  const handleSettle = useCallback(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(settleDate)) {
      setError('结算日期格式应为 YYYY-MM-DD');
      return;
    }
    const closes: Record<string, number> = {};
    for (const [code, v] of Object.entries(closePrices)) {
      const n = Number(v);
      if (v.trim() !== '' && Number.isFinite(n) && n > 0) closes[code] = n;
    }
    setError(null);
    setMessage(null);
    setSettling(true);
    try {
      const res = await settlePaperDay({ date: settleDate, closePrices: closes });
      setMessage(
        `日终结算完成：${res.date} 净值 ¥${res.latestEquity ? fmtMoney(res.latestEquity.value) : '—'}`,
      );
      await loadAccount();
    } catch (err) {
      setError(normalizeApiError(err, '日终结算失败').message);
    } finally {
      setSettling(false);
    }
  }, [settleDate, closePrices, loadAccount]);

  const handleIntlQuery = useCallback(async () => {
    const code = intlCode.trim();
    if (!code) {
      setError('请先输入港美股代码');
      return;
    }
    // 请求序号：串行 await 两次请求期间用户可能已经发起了另一次查询，
    // 迟到的旧响应不得覆盖新查询的结果（否则输入框与表格各说各话）
    const seq = ++intlSeqRef.current;
    setError(null);
    setIntlLoading(true);
    try {
      const res = await getIntlFundamentals(code, intlMarket || undefined);
      if (seq !== intlSeqRef.current) return;
      setIntlResult(res);
      setIntlKlines(null);
      setIntlKlineError(null);
      // 降级（fundamentals 为 null）时 K 线与错误都渲染不到——K 线只画在
      // `fundamentals ? …` 分支内，此时发请求既白跑一次上游，结果也不可见
      if (!res.fundamentals) return;
      try {
        const end = new Date().toISOString().slice(0, 10);
        const start = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
        const k = await getIntlKlines({
          code,
          market: res.fundamentals.market ?? intlMarket ?? undefined,
          startDate: start,
          endDate: end,
        });
        if (seq !== intlSeqRef.current) return;
        setIntlKlines(k.klines);
      } catch (err) {
        if (seq !== intlSeqRef.current) return;
        setIntlKlineError(err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      if (seq !== intlSeqRef.current) return;
      setError(normalizeApiError(err, '港美股数据获取失败').message);
    } finally {
      // 复合同一守卫：旧请求的收尾不能解禁仍在途的新请求
      if (seq === intlSeqRef.current) setIntlLoading(false);
    }
  }, [intlCode, intlMarket]);

  const positions = portfolio?.positions ?? [];
  const orders = portfolio?.orders ?? [];
  const equity = portfolio?.equity ?? [];

  return (
    <div className="paper-page">
      <div className="paper-header">
        <h2>模拟盘</h2>
        <p className="paper-sub">
          使用真实 A 股规则（T+1 结算、涨跌停限制、整手买卖、佣金印花税）进行日 K
          收盘撮合，全程无实盘资金，验证策略后即可放心实战。
          {portfolio ? (
            <>
              当前交易日：
              {portfolio.currentDate || '未设置'}
              ，可用现金 ¥{fmtMoney(portfolio.cash)}。
            </>
          ) : (
            '当前交易日：未设置，请先下单或同步日期。'
          )}
        </p>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner-text">{error}</span>
        </div>
      )}
      {message && (
        <div className="paper-message" role="status">
          {message}
        </div>
      )}

      {/* 绩效统计卡 */}
      <div className="paper-stats">
        <div className="paper-stat-card">
          <div className="paper-stat-label">初始资金</div>
          <div className="paper-stat-value">¥{stats ? fmtMoney(stats.initialCapital) : '—'}</div>
        </div>
        <div className="paper-stat-card">
          <div className="paper-stat-label">当前净值</div>
          <div className="paper-stat-value">¥{stats ? fmtMoney(stats.finalEquity) : '—'}</div>
        </div>
        <div className="paper-stat-card">
          <div className="paper-stat-label">累计收益</div>
          <div
            className={`paper-stat-value ${(stats?.totalReturnPct ?? 0) >= 0 ? 'val-positive' : 'val-negative'}`}
          >
            {stats ? fmtPct(stats.totalReturnPct) : '—'}
          </div>
        </div>
        <div className="paper-stat-card">
          <div className="paper-stat-label">最大回撤</div>
          <div className="paper-stat-value">
            {stats
              ? stats.maxDrawdownPct !== null
                ? `${stats.maxDrawdownPct.toFixed(2)}%`
                : '—'
              : '—'}
          </div>
        </div>
        <div className="paper-stat-card">
          <div className="paper-stat-label">年化夏普</div>
          <div className="paper-stat-value">{stats ? (stats.sharpeRatio ?? '—') : '—'}</div>
        </div>
        <div className="paper-stat-card">
          <div className="paper-stat-label">结算天数</div>
          <div className="paper-stat-value">{stats ? stats.totalDays : '—'}</div>
        </div>
      </div>

      <div className="paper-grid">
        {/* 下单表单 */}
        <section className="card">
          <h3 className="paper-card-title">模拟下单</h3>
          {!portfolio?.currentDate && (
            <div className="paper-first-use-hint">
              首次使用：请先在右侧「日终结算」选定一个交易日完成结算——设定交易日之后才能下单。
            </div>
          )}
          <div className="paper-form-row">
            <div className="paper-field">
              <label>代码{orderName && <span className="paper-code-name">{orderName}</span>}</label>
              <StockSearchInput
                onSelect={(code, name) => {
                  setOrderCode(code);
                  setOrderName(name);
                }}
                placeholder="如 600519 / 贵州茅台"
                ariaLabel="下单股票代码"
              />
            </div>
            <div className="paper-field">
              <label htmlFor={orderSideId}>方向</label>
              <select
                id={orderSideId}
                value={orderSide}
                onChange={(e) => setOrderSide(e.target.value as 'buy' | 'sell')}
              >
                <option value="buy">买入</option>
                <option value="sell">卖出</option>
              </select>
            </div>
            <div className="paper-field">
              <label htmlFor={orderTypeId}>类型</label>
              <select
                id={orderTypeId}
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as 'market' | 'limit')}
              >
                <option value="market">市价</option>
                <option value="limit">限价</option>
              </select>
            </div>
            <div className="paper-field">
              <label htmlFor={orderQtyId}>数量（股）</label>
              <input
                id={orderQtyId}
                type="number"
                value={orderQty}
                placeholder="100 的整数倍"
                onChange={(e) => setOrderQty(e.target.value)}
              />
            </div>
            {orderType === 'limit' && (
              <div className="paper-field">
                <label htmlFor={orderPriceId}>限价</label>
                <input
                  id={orderPriceId}
                  type="number"
                  value={orderPrice}
                  placeholder="申报价"
                  onChange={(e) => setOrderPrice(e.target.value)}
                />
              </div>
            )}
          </div>
          <button
            className="btn-primary"
            onClick={handlePlaceOrder}
            disabled={loading || submitting}
          >
            {submitting ? '提交中…' : '下单'}
          </button>
        </section>

        {/* 日终结算 */}
        <section className="card">
          <h3 className="paper-card-title">日终结算</h3>
          <div className="paper-form-row">
            <div className="paper-field">
              <label htmlFor={settleDateId}>结算日期</label>
              <input
                id={settleDateId}
                value={settleDate}
                onChange={(e) => setSettleDate(e.target.value)}
              />
              {isWeekendToday() && (
                <span className="paper-note">今天是非交易日，默认已回退至最近交易日</span>
              )}
            </div>
          </div>
          {positions.length === 0 ? (
            <p className="paper-note">当前无持仓，结算仅记录当日净值。</p>
          ) : (
            <div className="paper-field" role="group" aria-labelledby={closePriceLabelId}>
              <label id={closePriceLabelId}>持仓收盘价（缺省按停牌处理）</label>
              {positions.map((p) => (
                <div key={p.code} className="paper-close-row">
                  <span className="mono">{p.code}</span>
                  <input
                    type="number"
                    aria-label={`${p.code} 收盘价（数量 ${p.quantity} · 成本 ${p.avgCost.toFixed(2)}，缺省按停牌处理）`}
                    placeholder={`数量 ${p.quantity} · 成本 ${p.avgCost.toFixed(2)}`}
                    value={closePrices[p.code] ?? ''}
                    onChange={(e) =>
                      setClosePrices((prev) => ({ ...prev, [p.code]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          )}
          <div className="paper-actions">
            <button className="btn-primary" onClick={handleSettle} disabled={settling || loading}>
              {settling ? '结算中…' : '日终结算'}
            </button>
          </div>
        </section>
      </div>

      {/* 持仓 */}
      <section className="paper-section">
        <h3 className="paper-card-title">持仓</h3>
        <div className="watchlist-table-wrap">
          <table className="watchlist-table">
            <thead>
              <tr>
                <th>代码</th>
                <th>数量</th>
                <th>摊薄成本</th>
                <th>买入日期</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    暂无持仓
                  </td>
                </tr>
              ) : (
                positions.map((p) => (
                  <tr key={p.code}>
                    <td className="mono">{p.code}</td>
                    <td>{p.quantity}</td>
                    <td>¥{p.avgCost.toFixed(2)}</td>
                    <td>{p.buyDate}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 净值曲线：≥2 个结算点显示折线图（初始资金点 + 首个结算点即可连线） */}
      <section className="paper-section">
        <h3 className="paper-card-title">净值曲线</h3>
        {equity.length >= 2 && <PaperEquityChart equity={equity} />}
        <div className="watchlist-table-wrap">
          <table className="watchlist-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>净值</th>
                <th>日收益</th>
              </tr>
            </thead>
            <tbody>
              {equity.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    暂无净值记录，完成一次日终结算后出现
                  </td>
                </tr>
              ) : (
                equity.map((e, i) => {
                  const prev = i > 0 ? equity[i - 1].value : null;
                  const daily = prev && prev > 0 ? ((e.value - prev) / prev) * 100 : null;
                  return (
                    <tr key={e.date}>
                      <td className="mono">{e.date}</td>
                      <td>¥{fmtMoney(e.value)}</td>
                      <td
                        className={
                          daily !== null ? (daily >= 0 ? 'val-positive' : 'val-negative') : 'muted'
                        }
                      >
                        {daily !== null ? `${daily >= 0 ? '+' : ''}${daily.toFixed(2)}%` : '—'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 订单流水 */}
      <section className="paper-section">
        <h3 className="paper-card-title">订单流水（最近 {orders.length} 笔）</h3>
        {orders.some((o) => o.status === 'pending') && (
          <p className="paper-note" role="status">
            有 {orders.filter((o) => o.status === 'pending').length} 笔挂单待成交——市价单将在
            「日终结算」时按当日收盘价撮合，限价单需价格条件满足。
          </p>
        )}
        <div className="watchlist-table-wrap">
          <table className="watchlist-table">
            <thead>
              <tr>
                <th>代码</th>
                <th>方向</th>
                <th>类型</th>
                <th>数量</th>
                <th>限价</th>
                <th>成交价</th>
                <th>状态</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    暂无订单
                  </td>
                </tr>
              ) : (
                orders.map((o) => {
                  const badge = orderBadge(o.status);
                  return (
                    <tr key={o.id}>
                      <td className="mono">{o.code}</td>
                      <td>{o.side === 'buy' ? '买入' : '卖出'}</td>
                      <td>{o.type === 'market' ? '市价' : '限价'}</td>
                      <td>{o.quantity}</td>
                      <td>{o.price ?? '—'}</td>
                      <td>{o.fillPrice ?? '—'}</td>
                      <td>
                        <span className={`chip ${badge.cls}`}>{badge.text}</span>
                      </td>
                      <td className="muted">
                        {o.rejectReason ?? `佣金 ${o.commission ?? 0} 税 ${o.stampDuty ?? 0}`}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 港美股查询小工具 */}
      <section className="paper-section">
        <h3 className="paper-card-title">港美股财务估值查询</h3>
        <div className="paper-form-row">
          <div className="paper-field">
            <label htmlFor={intlCodeId}>代码</label>
            <input
              id={intlCodeId}
              value={intlCode}
              placeholder="港股 5 位 / 美股字母，如 00700 / TSLA"
              onChange={(e) => setIntlCode(e.target.value)}
            />
          </div>
          <div className="paper-field">
            <label htmlFor={intlMarketId}>市场</label>
            <select
              id={intlMarketId}
              value={intlMarket}
              onChange={(e) => setIntlMarket(e.target.value as '' | 'HK' | 'US')}
            >
              <option value="">自动识别</option>
              <option value="HK">港股</option>
              <option value="US">美股</option>
            </select>
          </div>
          <button className="btn-primary" onClick={handleIntlQuery} disabled={intlLoading}>
            {intlLoading ? '查询中…' : '查询'}
          </button>
        </div>
        {intlResult &&
          (intlResult.fundamentals ? (
            <div className="watchlist-table-wrap">
              <table className="watchlist-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>代码</th>
                    <th>市场</th>
                    <th>PE</th>
                    <th>PB</th>
                    <th>市值(亿)</th>
                    <th>营收(亿)</th>
                    <th>净利(亿)</th>
                    <th>货币</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{intlResult.fundamentals.name}</td>
                    <td className="mono">{intlResult.fundamentals.code}</td>
                    <td>{intlResult.fundamentals.market === 'HK' ? '港股' : '美股'}</td>
                    <td>{intlResult.fundamentals.pe || '—'}</td>
                    <td>{intlResult.fundamentals.pb || '—'}</td>
                    <td>{intlResult.fundamentals.marketCap || '—'}</td>
                    <td>{intlResult.fundamentals.revenue || '—'}</td>
                    <td>{intlResult.fundamentals.netIncome || '—'}</td>
                    <td>{intlResult.fundamentals.currency}</td>
                  </tr>
                </tbody>
              </table>
              {intlKlines && intlKlines.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <EChart
                    option={{
                      grid: { left: 56, right: 16, top: 28, bottom: 40 },
                      tooltip: { trigger: 'axis' },
                      xAxis: { type: 'category', data: intlKlines.map((k) => k.date) },
                      yAxis: {
                        type: 'value',
                        scale: true,
                        name: intlResult.fundamentals.currency,
                      },
                      series: [
                        {
                          type: 'line',
                          name: '收盘价',
                          data: intlKlines.map((k) => k.close),
                          showSymbol: false,
                          lineStyle: { width: 1.5 },
                        },
                      ],
                      color: ['#ef3f4c'],
                    }}
                    style={{ height: 260, width: '100%' }}
                  />
                  <p className="paper-note">近一年日收盘价（{intlKlines.length} 根）</p>
                </div>
              )}
              {intlKlineError && <p className="paper-note">K 线加载失败：{intlKlineError}</p>}
              <p className="paper-note">
                数据源：{intlResult.source} · 抓取时间{' '}
                {new Date(intlResult.fetchedAt).toLocaleString('zh-CN')}
              </p>
            </div>
          ) : (
            <p className="paper-note">
              查询降级或未返回数据（{intlResult.source}），请检查代码/市场后重试。
            </p>
          ))}
      </section>

      {/* 合规审计日志 */}
      <section className="paper-section">
        <h3 className="paper-card-title">合规审计日志</h3>
        <div className="paper-form-row">
          <div className="paper-field">
            <label htmlFor={auditLevelId}>风险等级过滤</label>
            <select
              id={auditLevelId}
              value={auditLevel}
              onChange={(e) => setAuditLevel(e.target.value as AuditRiskLevel | '')}
            >
              <option value="">全部</option>
              <option value="info">提示（info）</option>
              <option value="low">低（low）</option>
              <option value="medium">中（medium）</option>
              <option value="high">高（high）</option>
              <option value="critical">严重（critical）</option>
            </select>
          </div>
        </div>
        <div className="paper-form-row">
          <p className="paper-note">
            共 {auditTotal} 条，当前显示前 {auditEntries.length} 条
            {/* 审计日志按写入顺序（时间正序）返回，最早的在最前面 */}
            {auditTotal > auditEntries.length && '（按时间正序，最早在前）'}
          </p>
          {auditEntries.length < auditTotal && (
            <button
              type="button"
              className="btn-ghost"
              onClick={loadMoreAudit}
              disabled={auditLoadingMore}
            >
              {auditLoadingMore
                ? '加载中…'
                : `加载更多（还剩 ${auditTotal - auditEntries.length} 条）`}
            </button>
          )}
        </div>
        <div className="watchlist-table-wrap">
          <table className="watchlist-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>类别</th>
                <th>等级</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {auditEntries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    暂无审计条目
                  </td>
                </tr>
              ) : (
                // 已显示的条目全部渲染（不再固定 slice(0,20)）：
                // 分页由上方「加载更多」控制，避免"取回 20 条又只展示 20 条"的重复截断
                auditEntries.map((e) => {
                  const badge = riskBadge(e.riskLevel);
                  return (
                    <tr key={e.id}>
                      <td className="mono">{new Date(e.timestamp).toLocaleString('zh-CN')}</td>
                      <td className="mono">{e.action}</td>
                      <td>{e.category}</td>
                      <td>
                        <span className={`chip ${badge.cls}`}>{badge.text}</span>
                      </td>
                      <td className="muted">{e.detail}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

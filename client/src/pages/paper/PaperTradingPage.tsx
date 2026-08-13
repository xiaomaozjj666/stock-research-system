import { useState, useEffect, useCallback } from 'react';
import {
  getPaperPortfolio,
  placePaperOrder,
  settlePaperDay,
  getPaperStats,
  getAuditLog,
  getIntlFundamentals,
  normalizeApiError,
} from '../../api/client';
import type {
  PaperPortfolio,
  PaperStats,
  PaperOrder,
  AuditEntry,
  AuditRiskLevel,
  IntlFundamentalsResult,
} from '../../types';

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

/** 审计风险等级 → 徽章样式 */
function riskBadge(level: AuditRiskLevel): { text: string; cls: string } {
  if (level === 'critical' || level === 'high') {
    return { text: level.toUpperCase(), cls: 'chip-negative' };
  }
  return { text: level, cls: 'chip-neutral' };
}

const fmtMoney = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);

/** 今日日期 YYYY-MM-DD（日终结算默认基准日） */
function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function PaperTradingPage() {
  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [stats, setStats] = useState<PaperStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 下单表单
  const [orderCode, setOrderCode] = useState('');
  const [orderSide, setOrderSide] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [orderQty, setOrderQty] = useState('');
  const [orderPrice, setOrderPrice] = useState('');

  // 日终结算：日期 + 按持仓代码填收盘价（缺省视为停牌）
  const [settleDate, setSettleDate] = useState(todayStr());
  const [closePrices, setClosePrices] = useState<Record<string, string>>({});
  const [settling, setSettling] = useState(false);

  // 港美股查询
  const [intlCode, setIntlCode] = useState('');
  const [intlMarket, setIntlMarket] = useState<'' | 'HK' | 'US'>('');
  const [intlResult, setIntlResult] = useState<IntlFundamentalsResult | null>(null);
  const [intlLoading, setIntlLoading] = useState(false);

  // 审计日志
  const [auditLevel, setAuditLevel] = useState<AuditRiskLevel | ''>('');
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);

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

  const loadAudit = useCallback(async () => {
    try {
      const res = await getAuditLog(auditLevel ? { riskLevel: auditLevel } : {});
      setAuditEntries(res.entries);
    } catch {
      /* 审计查询失败不阻塞主流程 */
    }
  }, [auditLevel]);

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
    const code = orderCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setError('股票代码需为 6 位数字');
      return;
    }
    const quantity = Number(orderQty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
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
      setOrderQty('');
      setOrderPrice('');
      await loadAccount();
    } catch (err) {
      setError(normalizeApiError(err, '模拟下单失败').message);
    }
  }, [orderCode, orderSide, orderType, orderQty, orderPrice, portfolio, loadAccount]);

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
    setError(null);
    setIntlLoading(true);
    try {
      const res = await getIntlFundamentals(code, intlMarket || undefined);
      setIntlResult(res);
    } catch (err) {
      setError(normalizeApiError(err, '港美股数据获取失败').message);
    } finally {
      setIntlLoading(false);
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
          无实盘资金的研究闭环：日 K 收盘撮合 + A 股规则（T+1 / 涨跌停 / 整手 / 费用）。
          当前交易日：{portfolio?.currentDate ?? '未设置'}，可用现金 ¥
          {portfolio ? fmtMoney(portfolio.cash) : '—'}。
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
            {stats ? `${stats.maxDrawdownPct?.toFixed(2) ?? '—'}%` : '—'}
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
          <div className="paper-form-row">
            <div className="paper-field">
              <label>代码</label>
              <input
                value={orderCode}
                maxLength={6}
                placeholder="如 600519"
                onChange={(e) => setOrderCode(e.target.value)}
              />
            </div>
            <div className="paper-field">
              <label>方向</label>
              <select
                value={orderSide}
                onChange={(e) => setOrderSide(e.target.value as 'buy' | 'sell')}
              >
                <option value="buy">买入</option>
                <option value="sell">卖出</option>
              </select>
            </div>
            <div className="paper-field">
              <label>类型</label>
              <select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as 'market' | 'limit')}
              >
                <option value="market">市价</option>
                <option value="limit">限价</option>
              </select>
            </div>
            <div className="paper-field">
              <label>数量（股）</label>
              <input
                type="number"
                value={orderQty}
                placeholder="100 的整数倍"
                onChange={(e) => setOrderQty(e.target.value)}
              />
            </div>
            {orderType === 'limit' && (
              <div className="paper-field">
                <label>限价</label>
                <input
                  type="number"
                  value={orderPrice}
                  placeholder="申报价"
                  onChange={(e) => setOrderPrice(e.target.value)}
                />
              </div>
            )}
          </div>
          <button className="btn-primary" onClick={handlePlaceOrder} disabled={loading}>
            下单
          </button>
        </section>

        {/* 日终结算 */}
        <section className="card">
          <h3 className="paper-card-title">日终结算</h3>
          <div className="paper-form-row">
            <div className="paper-field">
              <label>结算日期</label>
              <input value={settleDate} onChange={(e) => setSettleDate(e.target.value)} />
            </div>
          </div>
          {positions.length === 0 ? (
            <p className="paper-note">当前无持仓，结算仅记录当日净值。</p>
          ) : (
            <div className="paper-field">
              <label>持仓收盘价（缺省按停牌处理）</label>
              {positions.map((p) => (
                <div key={p.code} className="paper-close-row">
                  <span className="mono">{p.code}</span>
                  <input
                    type="number"
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

      {/* 净值曲线简表 */}
      <section className="paper-section">
        <h3 className="paper-card-title">净值曲线</h3>
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
            <label>代码</label>
            <input
              value={intlCode}
              placeholder="港股 5 位 / 美股字母，如 00700 / TSLA"
              onChange={(e) => setIntlCode(e.target.value)}
            />
          </div>
          <div className="paper-field">
            <label>市场</label>
            <select
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
            <label>风险等级过滤</label>
            <select
              value={auditLevel}
              onChange={(e) => setAuditLevel(e.target.value as AuditRiskLevel | '')}
            >
              <option value="">全部</option>
              <option value="info">info</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
          </div>
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
                auditEntries.slice(0, 20).map((e) => {
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

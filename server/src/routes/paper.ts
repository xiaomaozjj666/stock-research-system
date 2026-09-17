/**
 * 模拟盘（paper trading）研究闭环：无实盘资金，日 K 收盘撮合 + A 股规则（T+1/涨跌停/整手/费用）。
 */
import { Router } from 'express';
import type { Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { PaperAccount } from '../quant/paperTrading.js';
import { auditTradeSignal } from '../services/auditLog.js';
import { getReqTraceContext } from '../services/telemetry.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';

const router = Router();

const PAPER_INITIAL_CAPITAL = Number(process.env.PAPER_INITIAL_CAPITAL) || 100_000;
let _paperAccount: PaperAccount | null = null;
// 持久化路径可被 PAPER_TRADING_FILE 重定向（与 watchlist 的 WATCHLIST_FILE 同模式），测试据此隔离临时文件
function paperStoreFile(): string {
  return process.env.PAPER_TRADING_FILE && process.env.PAPER_TRADING_FILE.length > 0
    ? process.env.PAPER_TRADING_FILE
    : path.join(import.meta.dirname, '..', 'data', 'paperTrading.json');
}
function getPaperAccount(): PaperAccount {
  if (!_paperAccount) {
    const file = paperStoreFile();
    // 文件缺失（首次运行/测试临时路径）时回退新建账户，避免 load 抛 ENOENT 导致 500
    _paperAccount =
      (fs.existsSync(file) ? PaperAccount.load(file) : null) ??
      new PaperAccount(PAPER_INITIAL_CAPITAL, { autoSave: true });
  }
  return _paperAccount;
}

/** 单次结算允许的价格条目上限（防超大 body 造成无谓的遍历与落盘膨胀） */
const MAX_PRICE_ENTRIES = 500;

/**
 * 解析「股票代码 → 价格」映射并做数值校验。
 * 必须严格校验：结算价一旦是非数值（如 "abc"），会经 Math.round(NaN*100)/100 传染到
 * cash / 持仓成本 / 净值，落盘时被 JSON 序列化成 null 且不可自愈——账户只能手改文件恢复。
 */
function parsePriceMap(
  raw: unknown,
  field: string,
): { ok: true; map: Map<string, number> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, map: new Map() };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${field} 应为对象（形如 {"600519":1680.5}）` };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_PRICE_ENTRIES) {
    return { ok: false, error: `${field} 条目过多（上限 ${MAX_PRICE_ENTRIES} 只）` };
  }
  const map = new Map<string, number>();
  for (const [code, value] of entries) {
    const key = code.trim();
    if (!key) return { ok: false, error: `${field} 存在空股票代码` };
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return { ok: false, error: `${field} 中 ${key} 的价格无效：需为大于 0 的有限数值` };
    }
    map.set(key, value);
  }
  return { ok: true, map };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 交易日必须是真的 YYYY-MM-DD 且能被解析。
 * 此前只查 `typeof === 'string'`，`{"date":"hello"}` 或 `"2026-13-45"` 会被写成
 * 账户的当前交易日并进入订单的 placedDate，污染 T+1 判定与净值序列（按日期做键）。
 */
function isValidTradingDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  // 排除 2026-02-31 这类"格式对但日期不存在"的值：Date.parse 会顺延到 3 月
  return new Date(t).toISOString().slice(0, 10) === v;
}

router.get('/api/paper/portfolio', (_req, res) => {
  try {
    const acct = getPaperAccount();
    res.json({
      initialCapital: acct.initialCapital,
      cash: acct.cash,
      currentDate: acct.currentTradingDate,
      positions: [...acct.positions.entries()].map(([, p]) => ({ ...p })),
      orders: acct.orders.slice(-50),
      equity: acct.getDailyEquity(),
    });
  } catch (error) {
    logger.error('Paper portfolio error', { route: '/api/paper/portfolio', err: error });
    res.status(500).json({ error: '模拟盘账户读取失败', detail: errorDetail(error) });
  }
});

router.post('/api/paper/order', (req, res) => {
  try {
    const body = req.body ?? {};
    // 枚举与数值校验前置：非法 side 会被引擎的非卖出分支放过从而绕过 T+1，
    // 非法 type 会走错误的撮合路径；这里直接拒绝并给出可操作提示。
    if (body.side !== 'buy' && body.side !== 'sell') {
      return res.status(400).json({ error: '下单失败', detail: '买卖方向无效（应为 buy / sell）' });
    }
    if (body.type !== 'market' && body.type !== 'limit') {
      return res
        .status(400)
        .json({ error: '下单失败', detail: '订单类型无效（应为 market / limit）' });
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: '下单失败', detail: '数量必须为正整数' });
    }
    if (
      body.type === 'limit' &&
      (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price <= 0)
    ) {
      return res.status(400).json({ error: '下单失败', detail: '限价单需提供正价格' });
    }
    const acct = getPaperAccount();
    if (body.date !== undefined && !isValidTradingDate(body.date)) {
      return res
        .status(400)
        .json({ error: '下单失败', detail: '交易日需为 YYYY-MM-DD 且为真实日期' });
    }
    if (typeof body.date === 'string') acct.setCurrentDate(body.date);
    const order = acct.placeOrder({
      code: String(body.code ?? ''),
      side: body.side,
      type: body.type,
      price: typeof body.price === 'number' ? body.price : undefined,
      quantity,
    });
    // 校验失败（非法代码/数量/限价等）placeOrder 返回 rejected 订单而非抛错 → 按 400 拒绝
    if (order.status === 'rejected') {
      return res.status(400).json({ error: '下单失败', detail: order.rejectReason ?? '无效订单' });
    }
    // 落盘失败不能回 400：订单已在内存生效，若报"下单失败"用户会重复下单。
    try {
      acct.save();
    } catch (saveError) {
      logger.error('Paper order save failed', { route: '/api/paper/order', err: saveError });
      return res.status(500).json({
        error: '下单已受理，但落盘失败（重启后可能丢失）',
        detail: errorDetail(saveError),
      });
    }
    // 审计留痕并带上链路 ID：模拟盘下单是"会产生持仓变动"的操作，属审计范围。
    // traceId 取 telemetry 注入的 res.locals（index.ts 的 expressTracerMiddleware），
    // 退化取请求 ID 中间件挂在 req 上的 reqId；都取不到就透传 undefined（不写脏字段）。
    const traceId = getReqTraceContext(res)?.traceId ?? (req as Request & { reqId?: string }).reqId;
    auditTradeSignal(
      'paper',
      order.code,
      order.side === 'buy' ? '模拟盘买入' : '模拟盘卖出',
      `委托 ${order.quantity} 股（${order.type === 'market' ? '市价' : '限价'}，交易日 ${order.placedDate}）`,
      traceId,
    );
    res.json({ order });
  } catch (error) {
    logger.warn('Paper order rejected', { route: '/api/paper/order', err: error });
    // 下单失败的 500 分支同样走统一脱敏（400 分支都是固定中文校验提示，保持原样）
    res.status(400).json({ error: '下单失败', detail: errorDetail(error) });
  }
});

router.post('/api/paper/settle', (req, res) => {
  try {
    const body = req.body ?? {};
    if (!isValidTradingDate(body.date)) {
      return res.status(400).json({ error: '缺少结算日期 date（YYYY-MM-DD）' });
    }
    const acct = getPaperAccount();
    acct.setCurrentDate(body.date);
    const closesParsed = parsePriceMap(body.closePrices, 'closePrices');
    if (!closesParsed.ok) {
      return res.status(400).json({ error: '结算参数无效', detail: closesParsed.error });
    }
    const prevParsed = parsePriceMap(body.prevClosePrices, 'prevClosePrices');
    if (!prevParsed.ok) {
      return res.status(400).json({ error: '结算参数无效', detail: prevParsed.error });
    }
    acct.settleDay(closesParsed.map, body.prevClosePrices ? prevParsed.map : undefined);
    acct.save();
    const equity = acct.getDailyEquity();
    res.json({ date: body.date, cash: acct.cash, latestEquity: equity.at(-1), history: equity });
  } catch (error) {
    logger.error('Paper settle error', { route: '/api/paper/settle', err: error });
    res.status(500).json({ error: '日终结算失败', detail: errorDetail(error) });
  }
});

router.get('/api/paper/stats', (_req, res) => {
  try {
    res.json(getPaperAccount().computeStats());
  } catch (error) {
    logger.error('Paper stats error', { route: '/api/paper/stats', err: error });
    res.status(500).json({ error: '统计失败', detail: errorDetail(error) });
  }
});

export default router;

/**
 * 模拟盘（paper trading）研究闭环：无实盘资金，日 K 收盘撮合 + A 股规则（T+1/涨跌停/整手/费用）。
 */
import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { PaperAccount } from '../quant/paperTrading.js';
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
    res.status(500).json({ error: '模拟盘账户读取失败', detail: (error as Error).message });
  }
});

router.post('/api/paper/order', (req, res) => {
  try {
    const body = req.body ?? {};
    const acct = getPaperAccount();
    if (typeof body.date === 'string') acct.setCurrentDate(body.date);
    const order = acct.placeOrder({
      code: String(body.code ?? ''),
      side: body.side as 'buy' | 'sell',
      type: body.type as 'market' | 'limit',
      price: typeof body.price === 'number' ? body.price : undefined,
      quantity: Number(body.quantity),
    });
    // 校验失败（非法代码/数量/限价等）placeOrder 返回 rejected 订单而非抛错 → 按 400 拒绝
    if (order.status === 'rejected') {
      return res.status(400).json({ error: '下单失败', detail: order.rejectReason ?? '无效订单' });
    }
    acct.save();
    res.json({ order });
  } catch (error) {
    logger.warn('Paper order rejected', { route: '/api/paper/order', err: error });
    res.status(400).json({ error: '下单失败', detail: (error as Error).message });
  }
});

router.post('/api/paper/settle', (req, res) => {
  try {
    const body = req.body ?? {};
    if (typeof body.date !== 'string') {
      return res.status(400).json({ error: '缺少结算日期 date（YYYY-MM-DD）' });
    }
    const acct = getPaperAccount();
    acct.setCurrentDate(body.date);
    const closes = new Map<string, number>(Object.entries(body.closePrices ?? {}));
    const prev = body.prevClosePrices
      ? new Map<string, number>(Object.entries(body.prevClosePrices))
      : undefined;
    acct.settleDay(closes, prev);
    acct.save();
    const equity = acct.getDailyEquity();
    res.json({ date: body.date, cash: acct.cash, latestEquity: equity.at(-1), history: equity });
  } catch (error) {
    logger.error('Paper settle error', { route: '/api/paper/settle', err: error });
    res.status(500).json({ error: '日终结算失败', detail: (error as Error).message });
  }
});

router.get('/api/paper/stats', (_req, res) => {
  try {
    res.json(getPaperAccount().computeStats());
  } catch (error) {
    logger.error('Paper stats error', { route: '/api/paper/stats', err: error });
    res.status(500).json({ error: '统计失败', detail: (error as Error).message });
  }
});

export default router;

/**
 * 自选股：清单管理 / 批量新闻回测 / 异动监控。
 */
import { Router } from 'express';
import { watchlistLimiter, circuitBreakerGuard } from '../middleware.js';
import { getWatchlist, addToWatchlist, removeFromWatchlist } from '../services/watchlistService.js';
import { runWatchlistNewsBacktest } from '../services/watchlistBacktest.js';
import { detectAlerts } from '../services/alerts.js';
import logger from '../utils/logger.js';

const router = Router();

// === 自选股/持仓监控：清单管理 ===
router.get('/api/watchlist', (_req, res) => {
  res.json({ codes: getWatchlist() });
});

router.post('/api/watchlist', (req, res) => {
  const code = String(req.body?.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '请提供有效的6位股票代码' });
  }
  const codes = addToWatchlist(code);
  res.json({ codes });
});

router.delete('/api/watchlist/:code', (req, res) => {
  const code = String(req.params.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '无效的股票代码' });
  }
  const codes = removeFromWatchlist(code);
  res.json({ codes });
});

// 批量"含最新消息回测"：对每只自选股跑新闻叠加回测
router.post(
  '/api/watchlist/news-backtest',
  watchlistLimiter,
  circuitBreakerGuard,
  async (req, res) => {
    try {
      const body = req.body ?? {};
      let codes: string[] = Array.isArray(body.codes) ? body.codes : [];
      if (codes.length === 0) codes = getWatchlist();
      if (codes.length === 0) {
        return res.status(400).json({ error: '自选股清单为空，请先添加股票' });
      }
      if (codes.length > 20) {
        return res.status(400).json({ error: '单次批量回测上限 20 只' });
      }
      const report = await runWatchlistNewsBacktest(codes);
      res.json(report);
    } catch (error) {
      logger.error('Watchlist news-backtest error', {
        route: '/api/watchlist/news-backtest',
        err: error,
      });
      const message = error instanceof Error ? error.message : '批量回测失败';
      res.status(500).json({ error: '自选股批量回测失败', detail: message });
    }
  },
);

// 自选股主动监控：重跑批量新闻回测并检出异动预警
router.post('/api/watchlist/monitor', watchlistLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const codes = getWatchlist();
    if (codes.length === 0) {
      return res.status(400).json({ error: '自选股清单为空，请先添加股票' });
    }
    const report = await runWatchlistNewsBacktest(codes);
    const alerts = detectAlerts(report.results);
    res.json({ generatedAt: report.generatedAt, monitored: report.count, alerts });
  } catch (error) {
    logger.error('Watchlist monitor error', { route: '/api/watchlist/monitor', err: error });
    res.status(500).json({ error: '自选股监控失败', detail: (error as Error).message });
  }
});

export default router;

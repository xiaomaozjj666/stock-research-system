/**
 * 自选股：清单管理 / 批量新闻回测 / 异动监控。
 */
import { Router } from 'express';
import { watchlistLimiter, circuitBreakerGuard } from '../middleware.js';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlistAlertsSnapshot,
  normalizeAlertsSnapshot,
  saveWatchlistAlertsSnapshot,
} from '../services/watchlistService.js';
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

// 最近一次异动监控快照（只读回看）：无快照时返回稳定空结构而非 404，前端一条分支即可处理
router.get('/api/watchlist/alerts', (_req, res) => {
  res.json(getWatchlistAlertsSnapshot());
});

// 自选股主动监控：重跑批量新闻回测并检出异动预警
router.post('/api/watchlist/monitor', watchlistLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const codes = getWatchlist();
    if (codes.length === 0) {
      return res.status(400).json({ error: '自选股清单为空，请先添加股票' });
    }
    const report = await runWatchlistNewsBacktest(codes);
    const alerts = detectAlerts(report.results);
    // 落盘「最近一次」快照：只回给当次请求的话，用户一刷新就丢，预警触达不到人。
    // 响应与落盘共用同一份规范化结果（条数上限一致），写盘失败也不影响本次返回。
    const snapshot = normalizeAlertsSnapshot({
      generatedAt: report.generatedAt,
      monitored: report.count,
      alerts,
    });
    saveWatchlistAlertsSnapshot(snapshot);
    res.json(snapshot);
  } catch (error) {
    logger.error('Watchlist monitor error', { route: '/api/watchlist/monitor', err: error });
    res.status(500).json({ error: '自选股监控失败', detail: (error as Error).message });
  }
});

export default router;

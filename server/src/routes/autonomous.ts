/**
 * 主动监控自治循环（autonomous loop）。
 */
import { Router } from 'express';
import { watchlistLimiter } from '../middleware.js';
import { startAutonomousLoop, type AutonomousController } from '../services/scheduler.js';
import { runWatchlistNewsBacktest } from '../services/watchlistBacktest.js';
import { getWatchlist } from '../services/watchlistService.js';
import type { WatchlistAlert } from '../services/alerts.js';
import logger from '../utils/logger.js';

const router = Router();

let autonomousController: AutonomousController | null = null;
let lastAutonomousAlerts: WatchlistAlert[] = [];

router.post('/api/autonomous/start', watchlistLimiter, async (req, res) => {
  try {
    if (autonomousController) autonomousController.stop();
    // 间隔夹紧到 [30秒, 24小时]：防止传入过小间隔导致高频空转，过大则失去监控意义
    const rawIntervalMs = Number(req.body?.intervalMs);
    const intervalMs =
      Number.isFinite(rawIntervalMs) && rawIntervalMs > 0
        ? Math.min(Math.max(rawIntervalMs, 30 * 1000), 24 * 60 * 60 * 1000)
        : 5 * 60 * 1000;
    autonomousController = startAutonomousLoop({
      intervalMs,
      monitor: async () => runWatchlistNewsBacktest(getWatchlist()),
      onAlert: (alerts) => {
        lastAutonomousAlerts = alerts;
        logger.info('[autonomous] 检出异动预警', { count: alerts.length });
      },
    });
    res.json({ started: true, ...autonomousController.getState() });
  } catch (error) {
    logger.error('Autonomous start error', { route: '/api/autonomous/start', err: error });
    res.status(500).json({ error: '启动自治循环失败', detail: (error as Error).message });
  }
});

router.post('/api/autonomous/stop', (_req, res) => {
  if (autonomousController) {
    autonomousController.stop();
    autonomousController = null;
  }
  res.json({ stopped: true, lastAlerts: lastAutonomousAlerts });
});

router.get('/api/autonomous/status', (_req, res) => {
  res.json(autonomousController ? autonomousController.getState() : { running: false });
});

export default router;

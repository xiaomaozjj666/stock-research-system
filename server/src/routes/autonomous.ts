/**
 * 主动监控自治循环（autonomous loop）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { watchlistLimiter } from '../middleware.js';
import { startAutonomousLoop, type AutonomousController } from '../services/scheduler.js';
import { runWatchlistNewsBacktest } from '../services/watchlistBacktest.js';
import { getWatchlist } from '../services/watchlistService.js';
import { auditToolCall } from '../services/auditLog.js';
import { getReqTraceContext } from '../services/telemetry.js';
import { errorDetail } from '../utils/errorDetail.js';
import type { WatchlistAlert } from '../services/alerts.js';
import logger from '../utils/logger.js';

const router = Router();

let autonomousController: AutonomousController | null = null;
let lastAutonomousAlerts: WatchlistAlert[] = [];

/**
 * 最近一轮监控的「覆盖披露」。
 * ----------------------------------------------------------------------------
 * 自治循环把整张自选股清单交给 runWatchlistNewsBacktest，而该函数默认只处理前
 * WATCHLIST_MAX_CODES（20）只。此前自治状态里没有任何披露渠道，用户会以为清单里
 * 每一只都在被监控——这里记下实际发生的裁剪，由状态响应如实透出。
 * 无裁剪（skipped=0）时保持 null：响应不出现该字段，维持既有契约。
 */
let lastCoverage: { requested: number; skipped: number } | null = null;

/** 从请求上下文取 traceId：telemetry 注入的 res.locals → 退化取 reqId → 取不到即 undefined */
function requestTraceId(req: Request, res: Response): string | undefined {
  return getReqTraceContext(res)?.traceId ?? (req as Request & { reqId?: string }).reqId;
}

/** 把覆盖披露并入自治状态（仅在真的发生裁剪时附加字段） */
function withCoverage<T extends object>(state: T): T & { requested?: number; skipped?: number } {
  return lastCoverage ? { ...state, ...lastCoverage } : state;
}

router.post('/api/autonomous/start', watchlistLimiter, async (req, res) => {
  try {
    if (autonomousController) autonomousController.stop();
    // 间隔夹紧到 [30秒, 24小时]：防止传入过小间隔导致高频空转，过大则失去监控意义
    const rawIntervalMs = Number(req.body?.intervalMs);
    const intervalMs =
      Number.isFinite(rawIntervalMs) && rawIntervalMs > 0
        ? Math.min(Math.max(rawIntervalMs, 30 * 1000), 24 * 60 * 60 * 1000)
        : 5 * 60 * 1000;
    // 新一轮循环重新计数：上一轮的裁剪披露不应挂到新循环的状态上
    lastCoverage = null;
    autonomousController = startAutonomousLoop({
      intervalMs,
      monitor: async () => {
        const report = await runWatchlistNewsBacktest(getWatchlist());
        // 服务层如实回传 requested/skipped（见 WatchlistBacktestResult）；
        // 这里只把「发生了裁剪」的情况记下来供状态响应披露
        lastCoverage =
          report.skipped > 0 ? { requested: report.requested, skipped: report.skipped } : null;
        return report;
      },
      onAlert: (alerts) => {
        lastAutonomousAlerts = alerts;
        logger.info('[autonomous] 检出异动预警', { count: alerts.length });
      },
    });
    auditToolCall(
      'autonomous',
      'autonomous.start',
      { intervalMs },
      { started: true },
      'low',
      requestTraceId(req, res),
    );
    res.json({ started: true, ...withCoverage(autonomousController.getState()) });
  } catch (error) {
    logger.error('Autonomous start error', { route: '/api/autonomous/start', err: error });
    res.status(500).json({ error: '启动自治循环失败', detail: errorDetail(error) });
  }
});

router.post('/api/autonomous/stop', (req, res) => {
  if (autonomousController) {
    autonomousController.stop();
    autonomousController = null;
  }
  auditToolCall(
    'autonomous',
    'autonomous.stop',
    {},
    { stopped: true, lastAlertCount: lastAutonomousAlerts.length },
    'low',
    requestTraceId(req, res),
  );
  res.json({ stopped: true, lastAlerts: lastAutonomousAlerts });
});

router.get('/api/autonomous/status', (_req, res) => {
  res.json(
    autonomousController ? withCoverage(autonomousController.getState()) : { running: false },
  );
});

export default router;

/**
 * 自选股：清单管理 / 批量新闻回测 / 异动监控。
 */
import { Router } from 'express';
import type { Response } from 'express';
import { watchlistLimiter, circuitBreakerGuard } from '../middleware.js';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlistAlertsSnapshot,
  normalizeAlertsSnapshot,
  saveWatchlistAlertsSnapshot,
  watchlistMax,
} from '../services/watchlistService.js';
import { runWatchlistNewsBacktest } from '../services/watchlistBacktest.js';
import { detectAlerts } from '../services/alerts.js';
import { normalizeAShareCode } from '../utils/stockCode.js';
import logger from '../utils/logger.js';

const router = Router();

// === 自选股/持仓监控：清单管理 ===
router.get('/api/watchlist', (_req, res) => {
  res.json({ codes: getWatchlist() });
});

router.post('/api/watchlist', (req, res) => {
  const code = normalizeAShareCode(req.body?.code);
  if (code === null) {
    return res.status(400).json({ error: '请提供有效的6位股票代码' });
  }
  // 容量上限：满员时返回**可操作的 400**（写明上限、当前只数、怎么清理），
  // 而不是静默截断（用户会以为加成功了）或写入超限数据（监控端会整表跑长任务）。
  const cur = getWatchlist();
  const limit = watchlistMax();
  if (!cur.includes(code) && cur.length >= limit) {
    return res.status(400).json({
      error: `自选股清单已达上限（${limit} 只），请先删除部分股票后再添加`,
      detail:
        `当前 ${cur.length} 只 / 上限 ${limit} 只。可用 DELETE /api/watchlist/:code 逐只移除，` +
        '或调整环境变量 WATCHLIST_MAX 提高上限',
      codes: cur,
      limit,
    });
  }
  res.json({ codes: addToWatchlist(code) });
});

router.delete('/api/watchlist/:code', (req, res) => {
  const code = normalizeAShareCode(req.params.code);
  if (code === null) {
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
    // 客户端提前断开 → 级联中止在途取数（≤20 只也是一串网络请求，断开后没必要跑完）
    const abort = abortOnClientClose(res);
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
      const report = await runWatchlistNewsBacktest(codes, { signal: abort.signal });
      if (abort.signal.aborted) return; // 客户端已不在：静默终止，不写响应
      res.json(report);
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info('批量回测客户端已断开，在途取数已中止', {
          route: '/api/watchlist/news-backtest',
        });
        return;
      }
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
  // 客户端提前断开（关页/取消）→ 级联中止在途取数：整张清单是几十只 × 逐只拉 K 线 + 新闻，
  // 断开后继续跑只会白烧上游配额（与 routes/quant.ts 的 abortOnClientClose 同一思路）。
  const abort = abortOnClientClose(res);
  try {
    const codes = getWatchlist();
    if (codes.length === 0) {
      return res.status(400).json({ error: '自选股清单为空，请先添加股票' });
    }
    // 单次上限由服务层统一施加（默认 20 只，见 watchlistBatchMax）：这里刻意**不**回 400——
    // monitor 是定时/自治循环驱动的唯一预警通道，清单超过 20 只就整体报错等于关掉预警；
    // 改为「处理前 N 只 + 在响应里如实说明被跳过的只数」，并用 requested/skipped 落盘留痕。
    const report = await runWatchlistNewsBacktest(codes, { signal: abort.signal });
    if (abort.signal.aborted) return; // 客户端已不在：静默终止，不写响应
    const alerts = detectAlerts(report.results);
    const skipped = Math.max(0, codes.length - report.count);
    // 落盘「最近一次」快照：只回给当次请求的话，用户一刷新就丢，预警触达不到人。
    // 响应与落盘共用同一份规范化结果（条数上限一致），写盘失败也不影响本次返回。
    const snapshot = normalizeAlertsSnapshot({
      generatedAt: report.generatedAt,
      monitored: report.count,
      alerts,
      requested: codes.length,
      skipped,
    });
    saveWatchlistAlertsSnapshot(snapshot);
    res.json(snapshot);
  } catch (error) {
    if (abort.signal.aborted) {
      logger.info('监控客户端已断开，在途取数已中止', { route: '/api/watchlist/monitor' });
      return;
    }
    logger.error('Watchlist monitor error', { route: '/api/watchlist/monitor', err: error });
    res.status(500).json({ error: '自选股监控失败', detail: (error as Error).message });
  }
});

/**
 * 客户端提前断开时中止在途取数。
 * 监听 res close（连接断开）且响应尚未写完 → abort；返回的 signal 传进
 * runWatchlistNewsBacktest → mapWithConcurrency → fetchOHLCVData，取消沿调用链级联到 socket 级。
 * 与 routes/quant.ts 的同名实现语义一致（该 helper 未导出，跨模块共享需改动 quant.ts，
 * 不在本次允许范围内，故此处保留一份）。
 */
function abortOnClientClose(res: Response): AbortController {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}

export default router;

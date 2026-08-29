/**
 * 核心分析：多专家研判 / SSE 流式 / 研究历史。
 */
import { Router } from 'express';
import { analyzeLimiter, circuitBreakerGuard } from '../middleware.js';
import { runAnalysis } from '../services/analysisPipeline.js';
import {
  saveHistoryEntry,
  getPreviousAnalysis,
  computeVsPrevious,
  listHistory,
  getHistoryItem,
  deleteHistoryItem,
} from '../services/historyService.js';
import { recordAnalysis } from '../services/outcomeTracker.js';
import { createSseChannel } from '../utils/sse.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * 分析结果自动写入研究历史（同代码去重；任何失败静默降级，不阻断主流程）。
 * 记忆反思闭环（借鉴 TradingAgents）：保存前读取该股票上一次分析，
 * 把评级/评分变化（vs_previous）附加到结果，随报告一同呈现——
 * 让每次分析都能对照历史观点，看到观点演化而非孤立快照。
 */
function persistAnalysisHistory(result: unknown): void {
  try {
    const item = (result as { stock_pool?: Array<Record<string, unknown>> })?.stock_pool?.[0];
    if (!item || typeof item.stock_code !== 'string') return;

    const prev = getPreviousAnalysis(item.stock_code);
    const vsPrevious = computeVsPrevious(
      { rating: String(item.rating ?? ''), totalScore: Number(item.total_score) || 0 },
      prev,
    );
    if (vsPrevious) item.vs_previous = vsPrevious;

    saveHistoryEntry({
      stockCode: item.stock_code,
      stockName: String(item.stock_name ?? item.stock_code),
      industry: typeof item.industry === 'string' ? item.industry : undefined,
      rating: String(item.rating ?? ''),
      totalScore: Number(item.total_score) || 0,
      result: result as never,
    });

    // 决策-结果闭环：记下本次评级与发出时的价格，到期后回填实际收益用于命中率校准
    recordAnalysis({
      stockCode: item.stock_code,
      rating: String(item.rating ?? ''),
      totalScore: Number(item.total_score) || 0,
      entryPrice: Number(
        (item.valuation as { currentPrice?: number } | undefined)?.currentPrice ?? 0,
      ),
    });
  } catch {
    /* 历史落盘失败不影响分析响应 */
  }
}

// === 核心分析接口 ===
router.post('/api/analyze', analyzeLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const { stockCode, resume } = req.body;
    if (!stockCode || !/^\d{6}$/.test(stockCode)) {
      return res.status(400).json({ error: '请提供有效的6位股票代码' });
    }
    // resume：上次分析中断时，从最后一个成功阶段续跑（省去已支付过的 LLM 成本）
    const result = await runAnalysis(stockCode, undefined, { resume: resume === true });
    persistAnalysisHistory(result); // 分析完成自动入库（失败静默，不影响响应）
    res.json(result);
  } catch (error) {
    logger.error('Analysis error', {
      route: '/api/analyze',
      stockCode: req.body?.stockCode,
      err: error,
    });
    res.status(500).json({ error: '分析过程出错', detail: (error as Error).message });
  }
});

// === 流式分析接口（SSE，逐步推送分析进度） ===
router.get('/api/analyze/stream', analyzeLimiter, circuitBreakerGuard, async (req, res) => {
  const stockCode = String(req.query.stockCode || '');
  if (!/^\d{6}$/.test(stockCode)) {
    return res.status(400).json({ error: '请提供有效的6位股票代码' });
  }

  // 断开感知：客户端关闭页面后，下一次 emit 抛错使管线在阶段边界提前中止，
  // 不再白跑 1-3 分钟的专家研判/外部请求
  const sse = createSseChannel(req, res);

  try {
    // resume=1：上次分析中断（如客户端断开）时，从最后一个成功阶段续跑
    const resume = req.query.resume === '1' || req.query.resume === 'true';
    const result = await runAnalysis(stockCode, (stage) => sse.send(stage), { resume });
    persistAnalysisHistory(result); // 分析完成自动入库（失败静默）
    sse.trySend({ phase: 'done', message: '分析完成', result });
  } catch (error) {
    if (sse.isClosed()) {
      logger.info('SSE 客户端已断开，分析提前中止', { route: '/api/analyze/stream', stockCode });
    } else {
      logger.error('Stream analysis error', {
        route: '/api/analyze/stream',
        stockCode,
        err: error,
      });
      sse.trySend({ phase: 'error', message: (error as Error).message || '分析过程出错' });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// === 研究历史记录（分析结果自动入库；列表/详情/删除） ===
router.get('/api/history', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json({ items: listHistory(limit) });
});

router.get('/api/history/:id', (req, res) => {
  const item = getHistoryItem(req.params.id);
  if (!item) return res.status(404).json({ error: '历史记录不存在' });
  res.json(item);
});

router.delete('/api/history/:id', (req, res) => {
  const ok = deleteHistoryItem(req.params.id);
  if (!ok) return res.status(404).json({ error: '历史记录不存在' });
  res.json({ deleted: true });
});

export default router;

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
  } catch {
    /* 历史落盘失败不影响分析响应 */
  }
}

// === 核心分析接口 ===
router.post('/api/analyze', analyzeLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const { stockCode } = req.body;
    if (!stockCode || !/^\d{6}$/.test(stockCode)) {
      return res.status(400).json({ error: '请提供有效的6位股票代码' });
    }
    const result = await runAnalysis(stockCode);
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (data: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* 客户端已断开 */
    }
  };

  try {
    const result = await runAnalysis(stockCode, (stage) => send(stage));
    persistAnalysisHistory(result); // 分析完成自动入库（失败静默）
    send({ phase: 'done', message: '分析完成', result });
  } catch (error) {
    send({ phase: 'error', message: (error as Error).message || '分析过程出错' });
  } finally {
    res.end();
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

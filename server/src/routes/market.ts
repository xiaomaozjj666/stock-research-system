/**
 * 股票列表 / 搜索 / 横向对比。
 */
import { Router } from 'express';
import { searchLimiter, compareLimiter, circuitBreakerGuard } from '../middleware.js';
import { getSupportedStocks, searchStocks } from '../services/dataService.js';
import { runAnalysis } from '../services/analysisPipeline.js';
import logger from '../utils/logger.js';

const router = Router();

// 获取支持的股票列表
router.get('/api/stocks', async (_req, res) => {
  try {
    const stocks = await getSupportedStocks();
    res.json(stocks);
  } catch (error) {
    logger.warn('获取股票列表失败，返回兜底数据', { err: error });
    res.json([{ code: '600519', name: '贵州茅台', industry: '白酒' }]);
  }
});

// 搜索股票
router.get('/api/stocks/search', searchLimiter, async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword || typeof keyword !== 'string') {
      return res.status(400).json({ error: '请提供搜索关键词' });
    }
    const results = await searchStocks(keyword);
    res.json(results);
  } catch (error) {
    logger.warn('股票搜索失败，返回空结果', { keyword: req.query.keyword, err: error });
    res.json([]);
  }
});

// 股票对比接口
router.post('/api/compare', compareLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const { stockCodes } = req.body;
    if (!Array.isArray(stockCodes) || stockCodes.length < 2 || stockCodes.length > 3) {
      return res.status(400).json({ error: '请选择2-3只股票进行对比' });
    }
    for (const code of stockCodes) {
      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: `无效的股票代码：${code}` });
      }
    }
    // Run analysis for each stock in parallel
    const results = await Promise.all(stockCodes.map((code: string) => runAnalysis(code)));
    res.json({ stocks: results.map((r) => r.stock_pool[0]) });
  } catch (error: unknown) {
    logger.error('Compare error', {
      route: '/api/compare',
      stockCodes: req.body?.stockCodes,
      err: error,
    });
    const detail = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: '对比分析失败', detail });
  }
});

export default router;

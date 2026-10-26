import { Router } from 'express';

import { createThesis, evaluateThesis, listTheses } from '../services/thesisService.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';

const router = Router();
const CODE_RE = /^\d{6}$/;
const METRICS = new Set(['close_price', 'return_pct', 'excess_return_pct']);
const COMPARATORS = new Set(['gt', 'gte', 'lt', 'lte']);

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

router.post('/api/theses', async (req, res) => {
  try {
    const body = req.body ?? {};
    const execution = body.execution ?? {};
    if (
      !CODE_RE.test(body.stockCode) ||
      !validText(body.thesis, 500) ||
      !validText(body.rating, 50) ||
      !METRICS.has(body.metric) ||
      !COMPARATORS.has(body.comparator) ||
      typeof body.threshold !== 'number' ||
      !Number.isFinite(body.threshold) ||
      !Number.isInteger(body.horizonDays) ||
      body.horizonDays < 1 ||
      body.horizonDays > 3650 ||
      body.evidenceSource !== 'real_ohlcv' ||
      !validText(body.invalidationAction, 200) ||
      !CODE_RE.test(body.benchmarkCode) ||
      execution.side !== 'buy' ||
      (execution.orderType !== 'market' && execution.orderType !== 'limit') ||
      typeof execution.entryPrice !== 'number' ||
      !Number.isFinite(execution.entryPrice) ||
      execution.entryPrice <= 0 ||
      typeof execution.quantity !== 'number' ||
      !Number.isInteger(execution.quantity) ||
      execution.quantity < 100 ||
      typeof execution.commissionRate !== 'number' ||
      execution.commissionRate < 0 ||
      execution.commissionRate > 0.1 ||
      typeof execution.stampDutyRate !== 'number' ||
      execution.stampDutyRate < 0 ||
      execution.stampDutyRate > 0.1 ||
      (execution.orderType === 'limit' &&
        (typeof execution.limitPrice !== 'number' || execution.limitPrice <= 0)) ||
      (body.totalScore !== undefined &&
        (typeof body.totalScore !== 'number' || !Number.isFinite(body.totalScore)))
    ) {
      return res
        .status(400)
        .json({ error: '预注册参数无效', detail: '请检查论点、证伪条件、期限、基准和成交规则' });
    }

    const thesis = await createThesis({
      stockCode: body.stockCode,
      thesis: body.thesis.trim(),
      rating: body.rating.trim(),
      totalScore: body.totalScore,
      metric: body.metric,
      comparator: body.comparator,
      threshold: body.threshold,
      horizonDays: body.horizonDays,
      evidenceSource: body.evidenceSource,
      invalidationAction: body.invalidationAction.trim(),
      benchmarkCode: body.benchmarkCode,
      execution: {
        side: execution.side,
        orderType: execution.orderType,
        entryPrice: execution.entryPrice,
        quantity: execution.quantity,
        limitPrice: execution.limitPrice,
        commissionRate: execution.commissionRate,
        stampDutyRate: execution.stampDutyRate,
      },
    });
    res.status(201).json({ thesis });
  } catch (error) {
    logger.error('Create thesis failed', { route: '/api/theses', err: error });
    res.status(500).json({ error: '预注册创建失败', detail: errorDetail(error) });
  }
});

router.get('/api/theses', (req, res) => {
  const stockCode = typeof req.query.stockCode === 'string' ? req.query.stockCode : undefined;
  if (stockCode && !CODE_RE.test(stockCode)) {
    return res.status(400).json({ error: '股票代码无效' });
  }
  res.json({ items: listTheses(stockCode) });
});

router.post('/api/theses/:id/evaluate', async (req, res) => {
  try {
    const thesis = await evaluateThesis(req.params.id);
    if (!thesis) return res.status(404).json({ error: '预注册实验不存在' });
    res.json({ thesis });
  } catch (error) {
    logger.error('Evaluate thesis failed', { route: '/api/theses/:id/evaluate', err: error });
    res.status(500).json({ error: '预注册评估失败', detail: errorDetail(error) });
  }
});

export default router;

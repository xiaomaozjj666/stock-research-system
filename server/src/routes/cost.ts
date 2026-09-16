/**
 * 多模型路由 / 成本治理。
 */
import { Router } from 'express';
import { metaLimiter, writeLimiter } from '../middleware.js';
import {
  getModelRegistry,
  selectModel,
  getCostReport,
  resetCostTracker,
  isLLMAvailable,
  isEmbeddingConfigured,
} from '../llm/index.js';

const router = Router();

// 模型注册表 / 成本报表：页面挂载即拉取的只读元数据 → metaLimiter(30/min)。
// 重置成本统计是写操作（会抹掉用量观测数据），单独用 writeLimiter(10/min)，
// 避免「读接口的宽松配额」顺带把写接口也放开。
router.get('/api/models', metaLimiter, (_req, res) => {
  const tasks = ['chat', 'analysis', 'debate', 'extract', 'reasoning', 'embedding'] as const;
  res.json({
    available: isLLMAvailable(),
    embeddingEnabled: isEmbeddingConfigured(),
    registry: getModelRegistry(),
    routing: Object.fromEntries(tasks.map((t) => [t, selectModel(t)])),
  });
});

router.get('/api/cost', metaLimiter, (_req, res) => {
  res.json(getCostReport());
});

router.post('/api/cost/reset', writeLimiter, (_req, res) => {
  resetCostTracker();
  res.json({ ok: true });
});

export default router;

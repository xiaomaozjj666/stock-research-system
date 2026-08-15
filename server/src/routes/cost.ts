/**
 * 多模型路由 / 成本治理。
 */
import { Router } from 'express';
import {
  getModelRegistry,
  selectModel,
  getCostReport,
  resetCostTracker,
  isLLMAvailable,
  isEmbeddingConfigured,
} from '../llm/index.js';

const router = Router();

router.get('/api/models', (_req, res) => {
  const tasks = ['chat', 'analysis', 'debate', 'extract', 'reasoning', 'embedding'] as const;
  res.json({
    available: isLLMAvailable(),
    embeddingEnabled: isEmbeddingConfigured(),
    registry: getModelRegistry(),
    routing: Object.fromEntries(tasks.map((t) => [t, selectModel(t)])),
  });
});

router.get('/api/cost', (_req, res) => {
  res.json(getCostReport());
});

router.post('/api/cost/reset', (_req, res) => {
  resetCostTracker();
  res.json({ ok: true });
});

export default router;

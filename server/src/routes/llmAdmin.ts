import { Router } from 'express';

import { quantLimiter, circuitBreakerGuard, respondIfQueueTimeout } from '../middleware.js';
import { runEnsemble, recordModelOutcome, getModelWeights } from '../llm/ensemble.js';
import {
  validateMessages,
  normalizeTemperatureInput,
  normalizeMaxTokensInput,
  resolveMaxTokensCap,
} from '../utils/limitGate.js';
import { routeSkill } from '../llm/skillRouter.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';

/**
 * LLM 运维端点（集成投票 / 权重校准 / 技能路由）
 *
 * 本文件由原 routes/quant.ts 按领域机械拆分而来（2026-09-28）：
 * 路由路径、限流与熔断参数逐字未变，对外 HTTP 契约零变化。
 */

const router = Router();

// === 多模型集成投票与置信度校准 ===
// 默认 candidateModels 只取 1 个模型（等价关闭），须显式传 models 或设
// LLM_ENSEMBLE_SIZE>1 才走投票——既有单模型链路零变更。
// 入参口径（P1 修复）：
//  - messages：条数/单条/总字符上限，越界一律 400（显式 prompt 静默截断会改变语义）；
//  - temperature：非数值/NaN/负数 400，> 2 夹紧到 2；
//  - maxTokens：非数值/NaN/负数/<1 400，超过 LLM_MAX_TOKENS_CAP（默认 4096）夹紧
//    ——这是账单放大的直接入口，夹紧比拒绝更可用（"尽量长"的意图仍明确）。
// 理由统一写在 utils/limitGate.ts 的注释里；夹紧发生时会 warn 留痕。
router.post('/api/llm/ensemble', quantLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      messages?: unknown;
      models?: unknown;
      task?: unknown;
      temperature?: unknown;
      maxTokens?: unknown;
    };
    const parsed = validateMessages(body.messages);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    let models: string[] | undefined;
    if (body.models !== undefined && body.models !== null) {
      if (!Array.isArray(body.models)) {
        return res.status(400).json({ error: 'models 必须是字符串数组' });
      }
      if (body.models.length > 5) {
        return res.status(400).json({ error: 'models 最多 5 个' });
      }
      if (!body.models.every((m) => typeof m === 'string' && m.trim().length > 0)) {
        return res.status(400).json({ error: 'models 每一项都必须是非空字符串' });
      }
      models = body.models;
    }
    const temperature = normalizeTemperatureInput(body.temperature);
    if (!temperature.ok) {
      return res.status(400).json({ error: temperature.error });
    }
    const maxTokens = normalizeMaxTokensInput(body.maxTokens);
    if (!maxTokens.ok) {
      return res.status(400).json({ error: maxTokens.error });
    }
    if (temperature.clampedFrom !== undefined || maxTokens.clampedFrom !== undefined) {
      logger.warn('LLM 集成参数越界，已夹紧到上限', {
        route: '/api/llm/ensemble',
        temperatureFrom: temperature.clampedFrom,
        maxTokensFrom: maxTokens.clampedFrom,
        maxTokensCap: resolveMaxTokensCap(),
      });
    }
    const result = await runEnsemble(parsed.messages as never, {
      ...(models ? { models } : {}),
      ...(typeof body.task === 'string' ? { task: body.task as never } : {}),
      ...(temperature.value !== undefined ? { temperature: temperature.value } : {}),
      ...(maxTokens.value !== undefined ? { maxTokens: maxTokens.value } : {}),
    });
    res.json(result);
  } catch (error) {
    // 闸门排队超时 → 429 + Retry-After（此前落到 502，客户端无法据此退避重试）
    if (respondIfQueueTimeout(res, error, '/api/llm/ensemble')) return;
    logger.error('LLM ensemble error', { route: '/api/llm/ensemble', err: error });
    res.status(502).json({ error: '多模型集成调用失败', detail: errorDetail(error) });
  }
});

/** 模型权重（校准结果） */
router.get('/api/llm/calibration', quantLimiter, (_req, res) => {
  res.json({ weights: getModelWeights() });
});

/** 记录一次模型判断的验证结果（correct = 事后被验证正确） */
router.post('/api/llm/calibration', quantLimiter, (req, res) => {
  try {
    const body = (req.body ?? {}) as { model?: unknown; correct?: unknown };
    const model = String(body.model ?? '').trim();
    if (!model) return res.status(400).json({ error: '请提供 model' });
    recordModelOutcome(model, body.correct === true);
    res.json({ ok: true, weights: getModelWeights() });
  } catch (error) {
    logger.error('Calibration record error', { route: '/api/llm/calibration', err: error });
    res.status(500).json({ error: '校准记录失败' });
  }
});

/** 技能路由：给定一句话，判定该走哪个专用技能（规则表，确定性） */
router.get('/api/llm/skills', quantLimiter, (req, res) => {
  const message = String((req.query ?? {}).message ?? '');
  res.json(routeSkill(message));
});

export default router;

/**
 * 改进循环对外接口（RSI · L2）
 * ----------------------------------------------------------------------------
 * 三个端点，对应一件事的三个视角：现在用的是什么判据（status）、跑一轮改进
 * （run）、历史上改过什么又否掉了什么（history）。
 *
 * 状态响应刻意把「可回放证据够不够」单独列出来：判据证据是本次改造起才开始
 * 留痕的，刚上线时 `available` 必然远小于 `required`——如果把这一点藏起来，
 * 用户会以为循环在干活，实际它每次都因证据不足直接返回。宁可难看，不要假象。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { writeLimiter } from '../middleware.js';
import { auditToolCall } from '../services/auditLog.js';
import { getReqTraceContext } from '../services/telemetry.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';
import { getHarnessPolicyState } from '../quant/harnessPolicy.js';
import { listImprovements, summarizeImprovements } from '../quant/improvementLedger.js';
import {
  collectReplayRows,
  isFactoryPolicy,
  MIN_EVIDENCE_COUNT,
  MIN_VALIDATION_COUNT,
  runImprovementRound,
  splitCounts,
} from '../quant/improvementLoop.js';

const router = Router();

function requestTraceId(req: Request, res: Response): string | undefined {
  return getReqTraceContext(res)?.traceId ?? (req as Request & { reqId?: string }).reqId;
}

router.get('/api/improvement/status', (_req, res) => {
  try {
    const state = getHarnessPolicyState();
    const ledger = summarizeImprovements();
    const available = collectReplayRows().length;
    // 切分口径与循环共用 splitCounts：接口预告与实际执行的判断必须同源
    const validationAvailable = splitCounts(available).validation;
    res.json({
      target: 'factor-verdict-policy',
      policy: state.policy,
      policySource: state.source,
      policyUpdatedAt: state.updatedAt,
      policyRevision: state.revision,
      lastChange: state.lastChange,
      /** 判据是否仍是出厂值（从未被改进循环改动过） */
      isFactoryPolicy: isFactoryPolicy(state.policy),
      ledger: {
        total: ledger.total,
        kept: ledger.kept,
        reverted: ledger.reverted,
        lastAt: ledger.lastAt,
        lastKeptAt: ledger.lastKeptAt,
        triedCandidates: ledger.triedValues.length,
      },
      replay: {
        available,
        required: MIN_EVIDENCE_COUNT,
        validationRequired: MIN_VALIDATION_COUNT,
        validationAvailable,
        /** 现在跑一轮是否会真的评估候选（false 时 run 会直接返回原因） */
        ready: available >= MIN_EVIDENCE_COUNT && validationAvailable >= MIN_VALIDATION_COUNT,
        note: '只有带判据证据（evidence）的实验记录能参与回放；该字段自本次改造起才开始落盘，改造前的历史记录不参与',
      },
    });
  } catch (error) {
    logger.error('Improvement status error', { route: '/api/improvement/status', err: error });
    res.status(500).json({ error: '读取改进状态失败', detail: errorDetail(error) });
  }
});

router.post('/api/improvement/run', writeLimiter, (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const result = runImprovementRound({ dryRun });
    auditToolCall(
      'improvement',
      dryRun ? 'improvement.dryRun' : 'improvement.run',
      { dryRun },
      {
        changed: result.changed,
        evaluated: result.evaluated,
        outcome: result.record?.outcome ?? null,
      },
      'low',
      requestTraceId(req, res),
    );
    res.json({
      changed: result.changed,
      reason: result.reason,
      evaluated: result.evaluated,
      dryRun,
      // 演练不落盘，故不回传记录——避免调用方以为"有记录=已生效"
      record: dryRun ? null : result.record,
      policy: result.policyState.policy,
      policySource: result.policyState.source,
      policyRevision: result.policyState.revision,
    });
  } catch (error) {
    logger.error('Improvement run error', { route: '/api/improvement/run', err: error });
    res.status(500).json({ error: '执行改进循环失败', detail: errorDetail(error) });
  }
});

router.get('/api/improvement/history', (req, res) => {
  try {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : 20;
    res.json({ limit, items: listImprovements(limit) });
  } catch (error) {
    logger.error('Improvement history error', { route: '/api/improvement/history', err: error });
    res.status(500).json({ error: '读取改进历史失败', detail: errorDetail(error) });
  }
});

export default router;

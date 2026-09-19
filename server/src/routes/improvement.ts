/**
 * 改进循环对外接口（RSI · L2）
 * ----------------------------------------------------------------------------
 * 四组端点，对应一件事的四个视角：现在用的是什么判据（status）、跑一轮改进
 * （run）、历史上改过什么又否掉了什么（history）、周期调度开没开（scheduler）。
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
import {
  getImprovementSchedulerState,
  resolveIntervalFromEnv,
  startImprovementScheduler,
  stopImprovementScheduler,
} from '../services/improvementScheduler.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';
import { getHarnessPolicyState } from '../quant/harnessPolicy.js';
import { listImprovements, summarizeImprovements } from '../quant/improvementLedger.js';
import {
  collectReplayRows,
  DECISION_ALPHA,
  isFactoryPolicy,
  MIN_EVIDENCE_COUNT,
  MIN_VALIDATION_COUNT,
  runImprovementRound,
  splitCounts,
} from '../quant/improvementLoop.js';

const router = Router();

/** 手填间隔的上限（小时）：与调度器内部 clamp 同值，避免接口说一套、内部做一套 */
const MAX_INTERVAL_HOURS = 720;

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
      /** 决策门槛：让调用方知道"显著"是按什么标准判的 */
      decision: {
        alpha: DECISION_ALPHA,
        test: 'McNemar 精确检验（双侧，配对）',
      },
      /** 周期调度状态；未启动为 null（不假装在跑） */
      scheduler: getImprovementSchedulerState(),
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

/** 启动 / 重设周期调度。带 intervalHours 时**显式压过 env**（用户当场说了算） */
router.post('/api/improvement/scheduler/start', writeLimiter, (req, res) => {
  try {
    const rawHours = Number(req.body?.intervalHours);
    const hasExplicit = Number.isFinite(rawHours) && rawHours > 0;
    if (!hasExplicit && resolveIntervalFromEnv() === null) {
      // env 显式关闭（IMPROVEMENT_INTERVAL_HOURS=0）时，不传间隔就不知道该按什么节奏跑。
      // 静默改用默认值会让"我明明关了它"变成假的，故如实拒绝并给出两条出路。
      res.status(400).json({
        error:
          '周期调度已被 IMPROVEMENT_INTERVAL_HOURS=0 关闭：要么传入 intervalHours，要么先改环境变量',
      });
      return;
    }
    const intervalHours = hasExplicit ? Math.min(rawHours, MAX_INTERVAL_HOURS) : undefined;
    const controller = startImprovementScheduler(
      intervalHours === undefined ? {} : { intervalMs: intervalHours * 3600_000 },
    );
    auditToolCall(
      'improvement',
      'improvement.scheduler.start',
      { intervalHours: intervalHours ?? null },
      { started: controller !== null },
      'low',
      requestTraceId(req, res),
    );
    res.json({ started: controller !== null, scheduler: controller?.getState() ?? null });
  } catch (error) {
    logger.error('Improvement scheduler start error', {
      route: '/api/improvement/scheduler/start',
      err: error,
    });
    res.status(500).json({ error: '启动改进调度失败', detail: errorDetail(error) });
  }
});

router.post('/api/improvement/scheduler/stop', writeLimiter, (req, res) => {
  try {
    stopImprovementScheduler();
    auditToolCall(
      'improvement',
      'improvement.scheduler.stop',
      {},
      { stopped: true },
      'low',
      requestTraceId(req, res),
    );
    res.json({ stopped: true, scheduler: null });
  } catch (error) {
    logger.error('Improvement scheduler stop error', {
      route: '/api/improvement/scheduler/stop',
      err: error,
    });
    res.status(500).json({ error: '停止改进调度失败', detail: errorDetail(error) });
  }
});

export default router;

/**
 * 多步深度研究（Deep Research）接口
 * ----------------------------------------------------------------------------
 * 把 research-agent 的编排器暴露为 HTTP 能力，两种消费方式：
 *
 *   POST /api/research/deep          同步：等整轮研究跑完一次性返回
 *   GET  /api/research/deep/stream   SSE ：逐条推送 AgentEvent（规划/检索/验证/编排）
 *
 * 与 /api/analyze 的分工：analyze 是「给定代码，跑固定的专家流水线」；
 * deep research 是「给定开放问题，Agent 自己拆解子问题、反复检索取证、交叉验证」，
 * 适用于行业格局、政策影响、竞争壁垒这类没有固定模板的问题。
 *
 * 成本护栏（研究一次会扇出几十次 LLM 调用，护栏必须有）：
 *   1. 进程内并发上限；2. 问题长度与子问题数上限；3. 轮次上限；4. 同步接口整体超时。
 *
 * 断线续跑（runId）：
 *   一次研究要跑几十次 LLM 调用、分钟级，SSE 断开即整次作废是长期缺口。
 *   服务端按「规划完成 + 每轮结束」落断点（services/researchCheckpoint），
 *   客户端带上 runId 重新请求即从下一轮继续：已完成的子问题复用验证结论与
 *   证据，不重复检索、不重复付费。只传 runId 即可（问题/范围/参数以断点为准）；
 *   同时传了与原研究不一致的 question/scope/config 会显式 400，避免混跑。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';

import { analyzeLimiter, circuitBreakerGuard, metaLimiter, writeLimiter } from '../middleware.js';
import { isLLMAvailable } from '../llm/index.js';
import {
  ResearchOrchestrator,
  createDefaultSearchAdapters,
  createLLMAdapter,
  type ResearchConfig,
  type ResearchResumeState,
  type ScopeConstraints,
} from '../research-agent/index.js';
import {
  deleteResearchRun,
  getResearchRun,
  listResearchRuns,
  saveResearchRun,
} from '../services/researchLibrary.js';
import {
  clearResearchCheckpoint,
  isResearchRunId,
  listResearchCheckpoints,
  loadResearchCheckpoint,
  newResearchRunId,
  saveResearchCheckpoint,
  type ResearchCheckpointRecord,
} from '../services/researchCheckpoint.js';
import { errorDetail } from '../utils/errorDetail.js';
import { abortOnClientClose } from '../utils/clientAbort.js';
import logger from '../utils/logger.js';
import { createSseChannel } from '../utils/sse.js';

const router = Router();

const MIN_QUESTION = 4;
const MAX_QUESTION = 500;
const MAX_EXTRA_REQUIREMENTS = 5;
const MAX_EXTRA_LENGTH = 200;

/** 进程内并发上限：一次深度研究要跑几十次 LLM 调用，放任并发会打爆速率限制与成本 */
const MAX_CONCURRENT_RUNS = 2;
/** 同步接口整体超时（毫秒）。SSE 不设总超时——心跳会保连接，前端可主动断开 */
const SYNC_TIMEOUT_MS = Number(process.env.RESEARCH_TIMEOUT_MS) || 300_000;

let inFlight = 0;

/** 取一个非空字符串字段（超长或非字符串一律视为非法） */
function readText(value: unknown, max: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length <= max ? trimmed : null;
}

/** 校验并归一化研究范围（全部字段可选；任一字段非法即整体拒绝） */
function parseScope(raw: unknown): ScopeConstraints | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;

  const scope: ScopeConstraints = {};
  for (const key of ['timeRange', 'region', 'industry', 'language'] as const) {
    const value = readText(body[key], 100);
    if (value === null) return null;
    if (value !== undefined) scope[key] = value;
  }

  if (body.extraRequirements !== undefined && body.extraRequirements !== null) {
    if (!Array.isArray(body.extraRequirements)) return null;
    if (body.extraRequirements.length > MAX_EXTRA_REQUIREMENTS) return null;
    const items: string[] = [];
    for (const item of body.extraRequirements) {
      const value = readText(item, MAX_EXTRA_LENGTH);
      if (value === null) return null;
      if (value !== undefined) items.push(value);
    }
    if (items.length > 0) scope.extraRequirements = items;
  }

  return scope;
}

/** 校验编排参数（全部可选；越界直接拒绝而不是静默夹紧——静默夹紧会让用户以为生效了） */
function parseConfig(raw: unknown): Partial<ResearchConfig> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;

  const config: Partial<ResearchConfig> = {};
  const numeric: Array<[keyof ResearchConfig, number, number]> = [
    ['maxRounds', 1, 4],
    ['maxSubQuestions', 3, 10],
    ['resultsPerQuery', 1, 10],
    ['maxDocsPerQuery', 1, 5],
  ];

  for (const [key, min, max] of numeric) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return null;
    }
    config[key] = value;
  }

  return config;
}

interface ParsedRequest {
  question: string;
  scope: ScopeConstraints;
  config: Partial<ResearchConfig>;
} /** 同步与流式共用一套入参校验：两个入口的口径必须一致，否则用户会看到"同一个问题两种行为" */
function parseRequest(source: Record<string, unknown>): ParsedRequest | { error: string } {
  const rawQuestion = source.question;
  if (typeof rawQuestion !== 'string' || rawQuestion.trim() === '') {
    return { error: '请提供研究问题' };
  }
  const question = rawQuestion.trim();
  if (question.length < MIN_QUESTION) {
    return { error: `研究问题过短（至少 ${MIN_QUESTION} 字）` };
  }
  if (question.length > MAX_QUESTION) {
    return { error: `研究问题过长（上限 ${MAX_QUESTION} 字）` };
  }

  const scope = parseScope(source.scope);
  if (scope === null) return { error: '研究范围参数非法' };

  const config = parseConfig(source.config);
  if (config === null) return { error: '研究参数非法（轮次 1-4、子问题 3-10）' };

  return { question, scope, config };
}

/** LLM 未配置时的统一提示：规划/验证/编排全靠 LLM，没有规则降级路径 */
const LLM_REQUIRED_MESSAGE =
  '深度研究依赖 LLM（规划、证据抽取、交叉验证、结论编排），请先配置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY';

/**
 * 进程内在跑的 runId。同一次研究不允许被并发续跑：两路 SSE 会各跑一遍
 * 剩余轮次（重复付费），并互相覆盖同一份断点。
 */
const activeRunIds = new Set<string>();

function claimRun(runId: string): boolean {
  if (activeRunIds.has(runId)) return false;
  activeRunIds.add(runId);
  return true;
}

function releaseRun(runId: string): void {
  activeRunIds.delete(runId);
}

/** 断点记录 → 编排器可消费的续跑状态（字段同形，快照即状态） */
function toResumeState(record: ResearchCheckpointRecord): ResearchResumeState {
  return { ...record.snapshot };
}

/**
 * 续跑入参一致性：问题/范围/参数以断点为准，客户端可以只传 runId。
 * 显式传了却与原研究不一致时拒绝——否则用户以为在续跑旧研究，
 * 实际跑出来的是「旧证据 + 新问题」的混合体。
 */
function resumeMismatch(
  record: ResearchCheckpointRecord,
  incoming: {
    question: unknown;
    scope: unknown;
    config: unknown;
  },
): string | null {
  if (incoming.question !== undefined && incoming.question !== null) {
    if (typeof incoming.question !== 'string') return '续跑时 question 必须是字符串';
    const q = incoming.question.trim();
    if (q !== '' && q !== record.question) {
      return '续跑的研究问题与原研究不一致（续跑只需传 runId）';
    }
  }
  if (incoming.scope !== undefined && incoming.scope !== null) {
    const scope = parseScope(incoming.scope);
    if (scope === null) return '研究范围参数非法';
    if (JSON.stringify(scope) !== JSON.stringify(record.scope)) {
      return '续跑的研究范围与原研究不一致（续跑只需传 runId）';
    }
  }
  if (incoming.config !== undefined && incoming.config !== null) {
    const config = parseConfig(incoming.config);
    if (config === null) return '研究参数非法（轮次 1-4、子问题 3-10）';
    if (JSON.stringify(config) !== JSON.stringify(record.config)) {
      return '续跑的编排参数与原研究不一致（续跑只需传 runId）';
    }
  }
  return null;
}

type ResolvedRequest =
  | {
      ok: true;
      parsed: ParsedRequest;
      runId: string;
      /** 非 null 表示这是续跑，携带有已有断点 */
      resume: ResearchCheckpointRecord | null;
    }
  | { ok: false; status: number; error: string };

/**
 * 两个入口（POST / SSE）共用的入参解析：
 *   - 未传 runId：沿用原有校验（question 必填），分配新 runId；
 *   - 传了 runId：读断点，问题/范围/参数以断点为准，传了不一致的值即 400。
 * scope/config 在这里已是解码后的值（SSE 入口先做 JSON 解析）。
 */
function resolveResearchRequest(input: {
  runId: unknown;
  question: unknown;
  scope: unknown;
  config: unknown;
}): ResolvedRequest {
  const rawRunId = input.runId;
  if (rawRunId === undefined || rawRunId === null) {
    const parsed = parseRequest({
      question: input.question,
      scope: input.scope,
      config: input.config,
    });
    if ('error' in parsed) return { ok: false, status: 400, error: parsed.error };
    return { ok: true, parsed, runId: newResearchRunId(), resume: null };
  }
  // 重复 query 参数（?runId=a&runId=b）在 Express 里是数组——显式拒绝
  if (typeof rawRunId !== 'string' || rawRunId.trim() === '') {
    return { ok: false, status: 400, error: 'runId 必须是非空字符串' };
  }
  const runId = rawRunId.trim();
  if (!isResearchRunId(runId)) {
    return { ok: false, status: 400, error: 'runId 格式非法' };
  }
  const record = loadResearchCheckpoint(runId);
  if (!record) {
    return {
      ok: false,
      status: 404,
      error: '研究断点不存在或已过期（断点默认保留 6 小时），请重新发起研究',
    };
  }
  const mismatch = resumeMismatch(record, input);
  if (mismatch) return { ok: false, status: 400, error: mismatch };
  return {
    ok: true,
    parsed: { question: record.question, scope: record.scope, config: record.config },
    runId,
    resume: record,
  };
}

/** 断点落盘（best-effort）：写失败只意味着「断了不能续」，不得中断研究 */
function persistCheckpoint(
  runId: string,
  parsed: ParsedRequest,
  snapshot: Parameters<typeof saveResearchCheckpoint>[0]['snapshot'],
  route: string,
): void {
  try {
    const ok = saveResearchCheckpoint({
      runId,
      question: parsed.question,
      scope: parsed.scope,
      config: parsed.config,
      snapshot,
    });
    if (!ok) logger.warn('研究断点写入失败（本次研究不可续跑）', { route, runId });
  } catch (error) {
    logger.warn('研究断点写入异常（本次研究不可续跑）', { route, runId, err: error });
  }
}

/** 组装一个可直接 run 的编排器：每次请求独立实例，避免事件与状态跨请求串台 */
function buildOrchestrator(
  config: Partial<ResearchConfig>,
  onEvent: (event: unknown) => void,
  signal?: AbortSignal,
  resume?: ResearchResumeState,
  onCheckpoint?: (snapshot: Parameters<typeof saveResearchCheckpoint>[0]['snapshot']) => void,
): ResearchOrchestrator {
  return new ResearchOrchestrator({
    llm: createLLMAdapter(),
    adapters: createDefaultSearchAdapters(),
    config,
    signal,
    resume,
    onCheckpoint,
    onEvent: (event) => {
      try {
        onEvent(event);
      } catch {
        // 事件旁路只用于可观测性，推送失败不得中断研究本身
      }
    },
  });
}

/**
 * 研究完成后落库（best-effort）。落盘失败不改变响应：研究结果已经产出，
 * 不该因为「历史没存上」把一次成功的研究报成失败。
 */
function archiveRun(
  route: string,
  parsed: ParsedRequest,
  result: Awaited<ReturnType<ResearchOrchestrator['run']>>,
): void {
  try {
    const summary = saveResearchRun({
      question: parsed.question,
      scope: parsed.scope,
      result,
    });
    if (!summary) logger.warn('深度研究结果未能写入研究库', { route });
  } catch (error) {
    logger.warn('深度研究结果写入研究库异常', { route, err: error });
  }
}

/* ------------------------------------------------------------- 同步接口 */

router.post(
  '/api/research/deep',
  analyzeLimiter,
  circuitBreakerGuard,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // 同步入口同样支持 runId 续跑（与 SSE 同一套解析：只传 runId 即以断点为准）
    const resolved = resolveResearchRequest({
      runId: body.runId,
      question: body.question,
      scope: body.scope,
      config: body.config,
    });
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { parsed, runId, resume } = resolved;

    if (!isLLMAvailable()) {
      return res.status(503).json({ error: LLM_REQUIRED_MESSAGE });
    }

    if (inFlight >= MAX_CONCURRENT_RUNS) {
      return res.status(429).json({
        error: '已有深度研究任务在运行，请稍后重试',
        retryAfterSeconds: 30,
      });
    }

    // 同一 runId 不允许被并发续跑：两路会各跑一遍剩余轮次（重复付费）
    if (!claimRun(runId)) {
      return res.status(409).json({
        error: '该研究仍在进行中（可能正在收尾），请稍后再续跑',
        retryAfterSeconds: 30,
      });
    }

    inFlight += 1;
    const startedAt = Date.now();
    // run promise 单独持有：同步响应有截止时间，但 run 本身不被截断——
    // 超时后 run 在后台继续跑完并归档（研究成果不因响应超时而丢弃），
    // 并发槽位按 run 真实结束时间归还（原先在响应 finally 里提前归还，
    // 超时的 run 变成无人认领的僵尸：槽位泄漏 + 结果丢弃 + 配额白烧）。
    let wallTimer: NodeJS.Timeout | undefined;
    const runPromise = (async () => {
      try {
        const orchestrator = buildOrchestrator(
          parsed.config,
          () => {
            /* 同步接口不透传事件：事件只在 SSE 通道消费 */
          },
          undefined,
          resume ? toResumeState(resume) : undefined,
          (snapshot) => persistCheckpoint(runId, parsed, snapshot, '/api/research/deep'),
        );
        const result = await orchestrator.run(parsed.question, parsed.scope);
        // 归档挂在 run 自身的完成点上（而不是响应成功之后）：响应超时后 run 仍会
        // 跑完，成果照常入库——不因为客户端等不及而整体丢弃一次分钟级研究。
        archiveRun('/api/research/deep', parsed, result);
        // 研究已完整落库，断点不再需要（避免「已完成的研究还能续跑」的歧义）
        clearResearchCheckpoint(runId);
        return result;
      } finally {
        inFlight -= 1;
        releaseRun(runId);
        clearTimeout(wallTimer);
      }
    })();

    try {
      const result = await Promise.race([
        runPromise,
        new Promise<never>((_, reject) => {
          wallTimer = setTimeout(
            () => reject(new Error(`研究超时（超过 ${Math.round(SYNC_TIMEOUT_MS / 1000)} 秒）`)),
            SYNC_TIMEOUT_MS,
          );
          wallTimer.unref?.();
        }),
      ]);

      logger.info('Deep research 完成', {
        route: '/api/research/deep',
        runId,
        resumed: Boolean(resume),
        rounds: result.stats.rounds,
        evidence: result.stats.evidenceCount,
        durationMs: Date.now() - startedAt,
      });

      // 归档已在 runPromise 内完成（超时/正常同一条路径）
      res.json(result);
    } catch (error) {
      // 超时分支：runPromise 已有 race 订阅（无 unhandled rejection），
      // 其后台完成时会走 archiveRun 并清理断点；此处只负责把超时如实告知调用方
      logger.error('Deep research error', { route: '/api/research/deep', err: error });
      res.status(500).json({ error: '深度研究失败', detail: errorDetail(error) });
    }
  },
);

/* ----------------------------------------------------------- 流式接口（SSE） */

router.get(
  '/api/research/deep/stream',
  analyzeLimiter,
  circuitBreakerGuard,
  async (req: Request, res: Response) => {
    // query string 里嵌套对象没法直接传，scope/config 统一走 JSON 字符串，
    // 与 POST 用同一个 parseRequest，保证两个入口的校验口径完全一致。
    // 注意区分「未传」与「传了但解析失败」：都当成 undefined 会让非法参数被静默忽略。
    const parseJsonParam = (raw: unknown): { ok: true; value: unknown } | { ok: false } => {
      // 重复 query 参数（?scope=a&scope=b）在 Express 里是数组——按「非法」显式
      // 拒绝而不是静默当 undefined（与下方「传了但解析失败」同口径）
      if (Array.isArray(raw)) return { ok: false };
      if (typeof raw !== 'string' || raw.trim() === '') return { ok: true, value: undefined };
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return { ok: false };
      }
    };

    const scopeParam = parseJsonParam(req.query.scope);
    const configParam = parseJsonParam(req.query.config);
    if (!scopeParam.ok || !configParam.ok) {
      return res.status(400).json({ error: 'scope/config 必须是合法的 JSON 字符串' });
    }

    // runId：断点续跑入口。只传 runId 即可（问题/范围/参数以断点为准），
    // 同时传了与原研究不一致的 question/scope/config 会被显式拒绝。
    const resolved = resolveResearchRequest({
      runId: req.query.runId,
      question: req.query.question,
      scope: scopeParam.value,
      config: configParam.value,
    });
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { parsed, runId, resume } = resolved;

    if (!isLLMAvailable()) {
      return res.status(503).json({ error: LLM_REQUIRED_MESSAGE });
    }

    if (inFlight >= MAX_CONCURRENT_RUNS) {
      return res.status(429).json({
        error: '已有深度研究任务在运行，请稍后重试',
        retryAfterSeconds: 30,
      });
    }

    if (!claimRun(runId)) {
      return res.status(409).json({
        error: '该研究仍在进行中（可能正在收尾），请稍后再续跑',
        retryAfterSeconds: 30,
      });
    }

    inFlight += 1;
    const sse = createSseChannel(req, res);
    // 第一帧就把 runId 交给客户端：断线后客户端凭它续跑（旧客户端忽略该帧）
    sse.trySend({
      phase: 'run_meta',
      runId,
      resumed: Boolean(resume),
      resumedFromRound: resume?.snapshot.roundsCompleted ?? 0,
    });
    // 取消级联：客户端断开（关页/前端「取消研究」关闭 EventSource）→ res 'close'
    // → abort → 编排器在阶段边界抛 ResearchAbortedError，在途 LLM/检索请求一并中止
    const abort = abortOnClientClose(res);
    // 运行墙钟上限：内部四重终止门之外的最后保险（病态场景下逐 LLM 调用 90s ×
    // 重试 × 多任务多轮可挂数小时）。超时取消同样走 abort 通道。
    const RUN_MAX_MS = Number(process.env.RESEARCH_RUN_MAX_MS) || 30 * 60_000;
    const wallTimer = setTimeout(
      () =>
        abort.abort(
          new Error(`研究超过最大时长（${Math.round(RUN_MAX_MS / 60_000)} 分钟），已中止`),
        ),
      RUN_MAX_MS,
    );
    wallTimer.unref?.();

    try {
      const orchestrator = buildOrchestrator(
        parsed.config,
        (event) => {
          // 客户端已断开就不必再推：继续写会抛错并打断编排
          if (sse.isClosed()) return;
          sse.trySend({ phase: 'agent_event', event });
        },
        abort.signal,
        resume ? toResumeState(resume) : undefined,
        (snapshot) => persistCheckpoint(runId, parsed, snapshot, '/api/research/deep/stream'),
      );

      const result = await orchestrator.run(parsed.question, parsed.scope);
      archiveRun('/api/research/deep/stream', parsed, result);
      clearResearchCheckpoint(runId);
      sse.trySend({ phase: 'done', result });
    } catch (error) {
      if (sse.isClosed()) {
        logger.info('SSE 客户端已断开，研究已取消（断点保留，可凭 runId 续跑）', {
          route: '/api/research/deep/stream',
          runId,
        });
      } else {
        logger.error('Deep research stream error', {
          route: '/api/research/deep/stream',
          runId,
          err: error,
        });
        sse.trySend({ phase: 'error', message: errorDetail(error) || '深度研究失败' });
      }
    } finally {
      clearTimeout(wallTimer);
      sse.stopHeartbeat();
      inFlight -= 1;
      releaseRun(runId);
      if (!res.writableEnded) res.end();
    }
  },
);

/* ------------------------------------------------------ 可续跑断点（入口） */

/**
 * 列出可续跑的未完成研究（新 -> 旧）。前端刷新页面后凭此恢复「继续研究」入口；
 * 正在跑的 run 不出现在列表里（它们不是「断了」，而是「还没跑完」）。
 */
router.get('/api/research/deep/resumable', metaLimiter, (req: Request, res: Response) => {
  const raw = req.query.limit;
  let limit = 20;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return res.status(400).json({ error: 'limit 必须是 1-50 的整数' });
    }
    limit = n;
  }
  const items = listResearchCheckpoints(limit).filter((item) => !activeRunIds.has(item.runId));
  res.json({ items });
});

/* --------------------------------------------------------- 研究库（历史研究） */

/**
 * 研究库是「跑完即丢」的补丁：深度研究贵且慢，结论需要能被复查。
 * 列表只返回摘要（问题/标题/置信度/统计），回看某次研究才读完整结果。
 */

router.get('/api/research/runs', metaLimiter, (req: Request, res: Response) => {
  const raw = req.query.limit;
  let limit = 20;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return res.status(400).json({ error: 'limit 必须是 1-50 的整数' });
    }
    limit = n;
  }
  res.json({ items: listResearchRuns(limit) });
});

router.get('/api/research/runs/:id', metaLimiter, (req: Request, res: Response) => {
  const run = getResearchRun(req.params.id);
  if (!run) return res.status(404).json({ error: '研究记录不存在' });
  res.json(run);
});

router.delete('/api/research/runs/:id', writeLimiter, (req: Request, res: Response) => {
  if (!deleteResearchRun(req.params.id)) {
    return res.status(404).json({ error: '研究记录不存在' });
  }
  res.json({ ok: true });
});

export default router;

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
  type ScopeConstraints,
} from '../research-agent/index.js';
import {
  deleteResearchRun,
  getResearchRun,
  listResearchRuns,
  saveResearchRun,
} from '../services/researchLibrary.js';
import { errorDetail } from '../utils/errorDetail.js';
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
}

/** 同步与流式共用一套入参校验：两个入口的口径必须一致，否则用户会看到"同一个问题两种行为" */
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

/** 组装一个可直接 run 的编排器：每次请求独立实例，避免事件与状态跨请求串台 */
function buildOrchestrator(
  config: Partial<ResearchConfig>,
  onEvent: (event: unknown) => void,
): ResearchOrchestrator {
  return new ResearchOrchestrator({
    llm: createLLMAdapter(),
    adapters: createDefaultSearchAdapters(),
    config,
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
    const parsed = parseRequest((req.body ?? {}) as Record<string, unknown>);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    if (!isLLMAvailable()) {
      return res.status(503).json({ error: LLM_REQUIRED_MESSAGE });
    }

    if (inFlight >= MAX_CONCURRENT_RUNS) {
      return res.status(429).json({
        error: '已有深度研究任务在运行，请稍后重试',
        retryAfterSeconds: 30,
      });
    }

    inFlight += 1;
    const startedAt = Date.now();
    try {
      const orchestrator = buildOrchestrator(parsed.config, () => {
        /* 同步接口不透传事件：事件只在 SSE 通道消费 */
      });

      const result = await Promise.race([
        orchestrator.run(parsed.question, parsed.scope),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`研究超时（超过 ${Math.round(SYNC_TIMEOUT_MS / 1000)} 秒）`)),
            SYNC_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);

      logger.info('Deep research 完成', {
        route: '/api/research/deep',
        rounds: result.stats.rounds,
        evidence: result.stats.evidenceCount,
        durationMs: Date.now() - startedAt,
      });

      archiveRun('/api/research/deep', parsed, result);
      res.json(result);
    } catch (error) {
      logger.error('Deep research error', { route: '/api/research/deep', err: error });
      res.status(500).json({ error: '深度研究失败', detail: errorDetail(error) });
    } finally {
      inFlight -= 1;
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

    const parsed = parseRequest({
      question: req.query.question,
      scope: scopeParam.value,
      config: configParam.value,
    });
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    if (!isLLMAvailable()) {
      return res.status(503).json({ error: LLM_REQUIRED_MESSAGE });
    }

    if (inFlight >= MAX_CONCURRENT_RUNS) {
      return res.status(429).json({
        error: '已有深度研究任务在运行，请稍后重试',
        retryAfterSeconds: 30,
      });
    }

    inFlight += 1;
    const sse = createSseChannel(req, res);

    try {
      const orchestrator = buildOrchestrator(parsed.config, (event) => {
        // 客户端已断开就不必再推：继续写会抛错并打断编排
        if (sse.isClosed()) return;
        sse.trySend({ phase: 'agent_event', event });
      });

      const result = await orchestrator.run(parsed.question, parsed.scope);
      archiveRun('/api/research/deep/stream', parsed, result);
      sse.trySend({ phase: 'done', result });
    } catch (error) {
      if (sse.isClosed()) {
        logger.info('SSE 客户端已断开，深度研究提前中止', {
          route: '/api/research/deep/stream',
        });
      } else {
        logger.error('Deep research stream error', {
          route: '/api/research/deep/stream',
          err: error,
        });
        sse.trySend({ phase: 'error', message: errorDetail(error) || '深度研究失败' });
      }
    } finally {
      sse.stopHeartbeat();
      inFlight -= 1;
      if (!res.writableEnded) res.end();
    }
  },
);

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

/**
 * 共享中间件：路由级限流器 + 合规熔断守卫 + LLM 闸门超时的统一响应。
 * app 级中间件（CORS / 安全头 / 请求 ID / 日志 / 指标 / 追踪）留在 index.ts 组装，
 * 路由模块只从这里取限流器与熔断守卫。
 */
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { auditLogger } from './services/auditLog.js';
import { isQueueTimeoutError } from './utils/limitGate.js';
import { errorDetail } from './utils/errorDetail.js';
import logger from './utils/logger.js';

/** 限流窗口（毫秒） */
export const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;

/**
 * 限流上限的解析：`Number(env) || dflt` 对「配成负数或 0」完全不设防——
 * `Number('-5')` 得到 -5（不是 NaN），`||` 不会兜底，而 express-rate-limit
 * 把 max <= 0 视为「永不放行」，会让该类请求 100% 429，且启动时没有任何提示。
 * 因此统一要求「≥1 的整数」，否则回落默认值。
 */
function rateLimitMax(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : dflt;
}

export const analyzeLimiter = rateLimit({
  windowMs,
  max: rateLimitMax(process.env.RATE_LIMIT_MAX_ANALYZE, 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试', retryAfter: Math.ceil(windowMs / 1000) },
});

export const searchLimiter = rateLimit({
  windowMs,
  max: rateLimitMax(process.env.RATE_LIMIT_MAX_SEARCH, 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '搜索请求过于频繁，请稍后再试', retryAfter: Math.ceil(windowMs / 1000) },
});

/** 股票对比（3 req/min） */
export const compareLimiter = rateLimit({
  windowMs: 60000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '对比请求过于频繁（限制：每分钟3次），请稍后再试', retryAfter: 60 },
});

/** 量化分析（5 req/min） */
export const quantLimiter = rateLimit({
  windowMs: 60000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '量化分析请求过于频繁（限制：每分钟5次），请稍后再试', retryAfter: 60 },
});

/**
 * 只读元数据（板块列表等）：前端页面挂载即请求，且多个面板会共享同一份数据。
 * 这类请求廉价且有 TTL 缓存，不应与分钟级的量化重计算共用 5 req/min 的配额
 * （否则打开量化页就可能连吃 429，实测过），故单独放宽到 30 req/min。
 */
export const metaLimiter = rateLimit({
  windowMs,
  max: rateLimitMax(process.env.RATE_LIMIT_MAX_META, 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '元数据请求过于频繁，请稍后再试', retryAfter: Math.ceil(windowMs / 1000) },
});

/** 自选股批量回测 / 监控（默认 3 req/min） */
export const watchlistLimiter = rateLimit({
  windowMs: 60000,
  max: rateLimitMax(process.env.RATE_LIMIT_MAX_WATCHLIST, 3),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '自选股批量回测过于频繁（限制：每分钟3次），请稍后再试', retryAfter: 60 },
});

/** 对话（10 req/min） */
export const chatLimiter = rateLimit({
  windowMs,
  max: rateLimitMax(process.env.RATE_LIMIT_MAX_CHAT, 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '对话请求过于频繁（限制：每分钟10次），请稍后再试', retryAfter: 60 },
});

/**
 * 健康 / 指标 / 契约等「监控系统自动拉取」的端点（默认 120 req/min）。
 *
 * 阈值刻意远高于常规抓取频率：监控通常 10~60 秒拉一次（≤6 req/min），而健康探针一旦
 * 被限流，在监控侧就表现为「服务返回 429」——把探针的频率问题伪装成故障告警。
 * 故这里只做单 IP 洪泛兜底：即便 1 秒探一次（60 req/min）也照样通过，成倍刷才会 429。
 *
 * 注意 /api/health 的外呼另有 memo（见 routes/health.ts），所以探针频率不会 1:1
 * 传到上游（eastmoney）；限流只是第二道闸。
 */
export const healthLimiter = rateLimit({
  windowMs,
  max: rateLimitMax(process.env.RATE_LIMIT_MAX_HEALTH, 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '健康探针请求过于频繁，请稍后再试', retryAfter: Math.ceil(windowMs / 1000) },
});

/**
 * 轻量状态变更（如重置成本统计 /api/cost/reset）：10 req/min。
 * 这类写操作本身廉价，但被刷会抹掉观测数据（成本/用量面板失真），
 * 故与只读元数据分开配额，避免脚本连点把统计打空。
 */
export const writeLimiter = rateLimit({
  windowMs,
  max: rateLimitMax(process.env.RATE_LIMIT_MAX_WRITE, 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '写操作过于频繁（限制：每分钟10次），请稍后再试', retryAfter: 60 },
});

/**
 * 运行时熔断（金融监管 8 号文合规）：窗口内高风险审计条目超阈值时拒绝分析类请求。
 * 熔断由 auditLog 的 high/critical 条目计数驱动（默认 5 分钟窗口内 >3 critical 或 >10 high 即触发）。
 */
export function circuitBreakerGuard(req: Request, res: Response, next: NextFunction) {
  const cb = auditLogger.checkCircuitBreaker();
  if (cb.tripped) {
    logger.warn('[circuit-breaker] 熔断触发，拒绝分析请求', { reason: cb.reason });
    res
      .status(503)
      .set('Retry-After', String(Math.ceil(cb.windowMs / 1000)))
      .json({
        error: '合规熔断触发：高风险操作数超过阈值，请稍后再试',
        // cb.reason 形如「时间窗口(300000ms)内 critical 级审计条目 N 条，超过阈值 3」，
        // 属内部度量口径：与 utils/errorDetail 的「内部细节只进日志」保持同一收口
        detail: errorDetail(new Error(cb.reason)),
      });
    return;
  }
  next();
}

/**
 * LLM 并发闸门排队超时（QueueTimeoutError）的统一响应：429 + Retry-After。
 *
 * 为什么单独抽成公共函数：闸门超时的语义是"系统繁忙，可退避重试"，既不是
 * 上游失败（502）也不是服务端错误（500）；只有返回 429 客户端才会按
 * Retry-After 退避。与 express-rate-limit 的 429、circuitBreakerGuard 的
 * 503 保持同一套"限流/熔断 → 明确状态码 + Retry-After"的既有风格。
 *
 * @returns true 表示已写出响应，调用方应立刻 return（不要再写第二个响应）
 */
export function respondIfQueueTimeout(res: Response, error: unknown, route?: string): boolean {
  if (!isQueueTimeoutError(error)) return false;
  const retryAfter = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
  logger.warn('[llm-gate] LLM 排队超时，返回 429 并提示退避', {
    route,
    code: error.code,
    retryAfter,
    detail: error.message,
  });
  res.status(429).set('Retry-After', String(retryAfter)).json({
    error: 'LLM 调用排队超时（系统繁忙），请稍后重试',
    code: error.code,
    retryAfter,
  });
  return true;
}

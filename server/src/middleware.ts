/**
 * 共享中间件：路由级限流器 + 合规熔断守卫。
 * app 级中间件（CORS / 安全头 / 请求 ID / 日志 / 指标 / 追踪）留在 index.ts 组装，
 * 路由模块只从这里取限流器与熔断守卫。
 */
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { auditLogger } from './services/auditLog.js';
import logger from './utils/logger.js';

/** 限流窗口（毫秒） */
export const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;

export const analyzeLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_ANALYZE) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试', retryAfter: Math.ceil(windowMs / 1000) },
});

export const searchLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_SEARCH) || 30,
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

/** 自选股批量回测 / 监控（默认 3 req/min） */
export const watchlistLimiter = rateLimit({
  windowMs: 60000,
  max: Number(process.env.RATE_LIMIT_MAX_WATCHLIST) || 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '自选股批量回测过于频繁（限制：每分钟3次），请稍后再试', retryAfter: 60 },
});

/** 对话（10 req/min） */
export const chatLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_CHAT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '对话请求过于频繁（限制：每分钟10次），请稍后再试', retryAfter: 60 },
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
      .json({ error: '合规熔断触发：高风险操作数超过阈值，请稍后再试', detail: cb.reason });
    return;
  }
  next();
}

/**
 * 共享中间件：路由级限流器 + 合规熔断守卫 + LLM 闸门超时的统一响应 + API 访问令牌鉴权。
 * app 级中间件（CORS / 安全头 / 请求 ID / 日志 / 指标 / 追踪）留在 index.ts 组装，
 * 路由模块只从这里取限流器与熔断守卫。
 */
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
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

/**
 * API 访问令牌鉴权（**默认关闭**）。
 *
 * 为什么默认关闭：这是单机自托管工具，开发与本机使用时前端同源直连，
 * 强制令牌会让「clone 下来就能跑」这件事立刻变复杂。但**一旦把它暴露到
 * localhost 之外**（内网穿透 / 公网 / 团队共享），当前形态等于**完全开放**：
 * 系统能读自选股、跑分析、调 LLM（真金白银）、读写模拟盘与历史，还带
 * 文件读写的文档检索接口。所以这里补一个显式开关，把这件事变成「有意识的选择」
 * 而不是「忘了加」。
 *
 * 启用方式：`API_AUTH_TOKEN=<随机长串>`。未设置 → 中间件完全放行，行为与之前逐字相同
 * （因此不会影响既有 3300+ 用例，也不会影响本地开发体验）。
 *
 * 为什么用 `timingSafeEqual` 而不是 `===`：逐字符比较会因首个不同字节的耗时差泄露
 * token 前缀，逐字符计时攻击在公网可自动化。长度不同则直接判否（timingSafeEqual
 * 要求等长输入）。
 *
 * 豁免范围（刻意保持极小）：
 *  - `OPTIONS` 预检：不带 Authorization 头是 CORS 的正常行为，拦下来只会造成假故障；
 *  - `/api/health`：供负载均衡/容器探针探活，带令牌才能探活等于探针失效。
 * 静态资源与 SPA 不走这里——本中间件只挂在 `/api` 前缀下（见 index.ts）。
 */

/** 读取令牌；未设置/空白视为未启用 */
export function getApiAuthToken(): string | null {
  const raw = process.env.API_AUTH_TOKEN;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/** 恒定时间比较；长度不等直接判否（timingSafeEqual 要求等长） */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 从请求里取令牌：`Authorization: Bearer <t>` 优先，其次 `x-api-token` 头，
 * 最后是 `?token=` query。
 *
 * 为什么需要 query 这一档：浏览器的 `EventSource`（消费 text/event-stream 的原生 API）
 * **不允许自定义请求头**，没有别的办法让流式请求带上凭据。前端因此对 SSE 端点
 * 只能用 query 传令牌，见 client/src/api/auth.ts。
 *
 * query 令牌只接受 **GET**：两个 SSE 端点（/api/analyze/stream、/api/chat/stream）
 * 都是 GET，而把凭据塞进写操作的 query 只会徒增泄漏面（浏览器历史、代理日志、
 * Referer 头），没有对应的收益。
 *
 * 泄漏面控制：`token` 不在 logSanitize 的白名单内，因此请求日志与 telemetry span
 * 都会把它的值替换成 `[redacted]`（见 server/src/utils/logSanitize.ts）。
 */
export function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const h = req.headers['x-api-token'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  // query 仅限 GET（见上方注释）
  if (req.method === 'GET') {
    const q = req.query?.token;
    if (typeof q === 'string' && q.trim()) return q.trim();
  }
  return null;
}

/** 免鉴权路径前缀（与探活、跨域预检对齐） */
const EXEMPT_PREFIXES = ['/api/health'];

/**
 * 取**完整**请求路径（去掉 query）。
 *
 * 为什么要用 originalUrl 而不是 req.path：本中间件挂在 `app.use('/api', ...)` 上，
 * 而 Express 会把 req.path 改写成**相对挂载点**的路径（`/api/health` → `/health`）。
 * 早先按 req.path 匹配豁免前缀时永远匹配不上，探活因此被 401 拦掉——
 * 而这正是「免鉴权豁免」最不能失效的地方（容器/负载均衡探针会直接判定服务挂了）。
 * originalUrl 始终是客户端请求的原始路径，不受挂载点影响。
 */
function fullPath(req: Request): string {
  const url = req.originalUrl || req.url || '';
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function isExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function apiAuthGuard(req: Request, res: Response, next: NextFunction): void {
  const expected = getApiAuthToken();
  // 未启用：完全放行（保持本地开发与既有测试的行为不变）
  if (!expected) return next();

  if (req.method === 'OPTIONS' || isExempt(fullPath(req))) return next();

  const provided = extractToken(req);
  if (provided && tokenMatches(provided, expected)) return next();

  // 缺失与错误一律 401，但**措辞区分**：缺失说"需要令牌"，错误只说"无效"，
  // 不回显"期望的 token 是什么"，也不因为缺失/错误走不同分支而产生计时差。
  //
  // 文案要同时照顾两类调用方：浏览器（页面会显示这条并弹出解锁条，填入 localStorage
  // 后由前端自动带上）与脚本（curl / CI，可用 Authorization 头或 x-api-token）。
  // 因此既给出前端路径也给出 header 形式，不只说其中一种。
  logger.warn('[auth] 拒绝未授权请求', {
    reqId: (req as Request & { reqId?: string }).reqId,
    path: fullPath(req),
    method: req.method,
    hasToken: Boolean(provided),
  });
  res.set('WWW-Authenticate', 'Bearer realm="stock-research"');
  res.status(401).json({
    error: provided
      ? '访问令牌无效'
      : '需要访问令牌：浏览器请在页面解锁条中填入；脚本请传 Authorization: Bearer <API_AUTH_TOKEN> 或 x-api-token 头',
    code: 'UNAUTHORIZED',
  });
}

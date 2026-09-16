/**
 * Prometheus 指标采集与导出（零依赖，内存态）
 * ----------------------------------------------------------------------------
 * 以 Prometheus 文本格式（0.0.4）导出运行时指标：
 *  - http_requests_total{method,route,status}      请求计数（counter）
 *  - http_request_duration_ms{method,route}        请求耗时直方图（histogram）
 *  - process_uptime_seconds / process_*_bytes      进程运行状态（gauge）
 *  - llm_calls_total / llm_tokens_total / llm_cost_total   LLM 成本治理数据（gauge）
 *  - circuit_breaker_tripped                       合规熔断器当前状态（gauge）
 *
 * 设计要点：
 *  - 路由标签做归一化（/api/watchlist/600519 → /api/watchlist/:code），防止标签基数爆炸；
 *  - 无外部依赖（不引入 prom-client），指标面小而准，重启清零；
 *  - 测试可调用 resetMetrics() 隔离。
 */
import type { Request, Response, NextFunction } from 'express';
import { getCostReport } from '../llm/cost.js';
import { buildOpenApiDocument } from './openapi.js';
import { auditLogger } from './auditLog.js';

/** 请求耗时直方图桶边界（毫秒） */
const DURATION_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

/**
 * 历史静态路由表（兜底）。
 * 保留既有标签集：即使 OpenAPI 契约与运行时路由发现都拿不到（如单测直接调用
 * normalizeRoute），已有标签也不会退化成 /api/:other。
 */
const LEGACY_STATIC_ROUTES = [
  '/api/health',
  '/api/metrics',
  '/api/openapi.json',
  '/api/analyze',
  '/api/analyze/stream',
  '/api/compare',
  '/api/stocks',
  '/api/stocks/search',
  '/api/watchlist',
  '/api/watchlist/news-backtest',
  '/api/watchlist/monitor',
  '/api/backtest/evaluate',
  '/api/chat',
  '/api/chat/stream',
  '/api/chat/history/clear',
  '/api/paper/portfolio',
  '/api/paper/order',
  '/api/paper/settle',
  '/api/paper/stats',
  '/api/audit',
  '/api/intl/fundamentals',
  '/api/ingest',
  '/api/documents',
  '/api/models',
  '/api/cost',
  '/api/cost/reset',
  '/api/autonomous/start',
  '/api/autonomous/stop',
  '/api/autonomous/status',
  '/api/quant/analyze',
  '/api/quant/factor/evaluate',
];

/** OpenAPI 契约里的路径（`/api/watchlist/{code}`）→ Express 形态（`/api/watchlist/:code`） */
function toExpressPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1');
}

/** 由 Express 路由路径编译匹配器：静态段精确匹配，:param 段匹配单段任意值 */
function compileRoutePattern(routePath: string): RegExp {
  const escaped = routePath
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}

interface RouteLabelTable {
  /** 无路径参数的静态路由 */
  exact: Set<string>;
  /** 带路径参数的路由（标签用模式本身，基数有界） */
  patterns: { re: RegExp; label: string }[];
}

/**
 * 从已注册路由自动发现路径（Express 5：`app.router.stack`，挂载的子路由在
 * `layer.handle.stack` 里递归展开）。任何结构不符都静默放弃——自动发现只是
 * 「新增路由不必手工补表」的主路径，兜底表始终有效。
 */
function collectRegisteredPaths(app: unknown): string[] {
  const out: string[] = [];
  const visited = new Set<unknown>();
  const walk = (stack: unknown, depth: number): void => {
    if (!Array.isArray(stack) || depth > 5) return;
    for (const layer of stack as Array<Record<string, unknown>>) {
      const routePath = (layer?.route as { path?: unknown } | undefined)?.path;
      const candidates = Array.isArray(routePath) ? routePath : [routePath];
      for (const p of candidates) {
        if (typeof p === 'string' && p.startsWith('/api')) out.push(p);
      }
      const handle = layer?.handle as { stack?: unknown } | undefined;
      if (handle && !visited.has(handle)) {
        visited.add(handle);
        walk(handle.stack, depth + 1);
      }
    }
  };
  walk((app as { router?: { stack?: unknown } } | undefined)?.router?.stack, 0);
  return out;
}

/**
 * 构建路由标签表：OpenAPI 契约（机器可读、与路由同步维护）+ 运行时自动发现
 * （已注册路由，含未写入契约的）+ 历史静态兜底。三者在标签层面等价，只增不减。
 */
export function buildRouteLabelTable(app?: unknown): RouteLabelTable {
  const paths = new Set<string>(LEGACY_STATIC_ROUTES);
  try {
    for (const p of Object.keys(buildOpenApiDocument().paths)) paths.add(toExpressPath(p));
  } catch {
    /* 契约不可用时保留兜底表 */
  }
  for (const p of collectRegisteredPaths(app)) paths.add(p);

  const exact = new Set<string>();
  const patterns: RouteLabelTable['patterns'] = [];
  for (const p of paths) {
    if (p.includes(':')) patterns.push({ re: compileRoutePattern(p), label: p });
    else exact.add(p);
  }
  return { exact, patterns };
}

let routeTable = buildRouteLabelTable();
let routeTableApp: unknown = null;

/** 首次请求时用真实 app 补全自动发现的路由表（同一 app 只重建一次） */
function ensureRouteTableFor(app: unknown): void {
  if (app === undefined || app === null || app === routeTableApp) return;
  routeTableApp = app;
  routeTable = buildRouteLabelTable(app);
}

/** 测试用：按指定 app 重建路由表（不传则只保留契约 + 兜底表） */
export function resetRouteTable(app?: unknown): void {
  routeTableApp = app ?? null;
  routeTable = buildRouteLabelTable(app);
}

/**
 * 路由标签归一化：有界标签集，防止 Prometheus 标签基数爆炸。
 * 表由 OpenAPI 契约 + 已注册路由自动生成（新增路由无需手工补表）；
 * 仍无匹配的 /api 路径归为 /api/:other，非 API 路径（生产 SPA 静态资源）归为 static_assets。
 */
export function normalizeRoute(path: string): string {
  if (routeTable.exact.has(path)) return path;
  for (const { re, label } of routeTable.patterns) {
    if (re.test(path)) return label;
  }
  if (path.startsWith('/api/')) return '/api/:other';
  return 'static_assets';
}

interface HistogramState {
  /** 与 DURATION_BUCKETS_MS 对应的各桶累计计数（≤ 边界） */
  buckets: number[];
  sum: number;
  count: number;
}

const requestCounts = new Map<string, number>(); // key: method|route|status
const histograms = new Map<string, HistogramState>(); // key: method|route

/** 请求结束形态：finished=响应已写出（含 4xx/5xx）；aborted=客户端中途断开（未 finish） */
export type HttpRequestOutcome = 'finished' | 'aborted';

/**
 * 记录一次 HTTP 请求（由中间件在响应完成或连接断开时调用）。
 *
 * aborted 用 `status="aborted"` 计入同一 counter，并进入同一耗时直方图：
 * SSE 长请求被客户端取消时最需要看到的正是「这轮分析了多久才被放弃」——
 * 原先只监听 finish，这类请求在指标里完全不存在。
 */
export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationMs: number,
  outcome: HttpRequestOutcome = 'finished',
): void {
  const statusLabel = outcome === 'aborted' ? 'aborted' : String(status);
  const countKey = `${method}|${route}|${statusLabel}`;
  requestCounts.set(countKey, (requestCounts.get(countKey) ?? 0) + 1);

  const histKey = `${method}|${route}`;
  let hist = histograms.get(histKey);
  if (!hist) {
    hist = { buckets: DURATION_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
    histograms.set(histKey, hist);
  }
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
    if (durationMs <= DURATION_BUCKETS_MS[i]) hist.buckets[i] += 1;
  }
  hist.sum += durationMs;
  hist.count += 1;
}

/** HTTP 指标采集中间件：挂在路由之前，响应 finish / 连接 close 时记录（二者只计一次） */
export function httpMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    // 用真实 app 补全路由表（含未写入 OpenAPI 契约的运行时路由）
    ensureRouteTableFor((req as Request & { app?: unknown }).app);

    let recorded = false;
    const record = (outcome: HttpRequestOutcome) => {
      if (recorded) return; // finish 与 close 都会触发，保证一次请求只计一次
      recorded = true;
      recordHttpRequest(
        req.method,
        normalizeRoute(req.path),
        res.statusCode,
        Date.now() - start,
        outcome,
      );
    };

    res.on('finish', () => record('finished'));
    // 客户端中途断开（页面关闭、SSE 被取消）只有 close 没有 finish：
    // 必须在这里补记 aborted，否则最需要监控的 1~3 分钟分析被取消后完全不可见。
    res.on('close', () => {
      if (!res.writableEnded) record('aborted');
    });

    next();
  };
}

/** 转义 Prometheus 标签值中的特殊字符（\ " \n） */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * 渲染 Prometheus 文本格式（0.0.4）指标快照。
 */
export function renderPrometheus(): string {
  const lines: string[] = [];

  // === HTTP 请求计数 ===
  lines.push('# HELP http_requests_total Total number of HTTP requests processed.');
  lines.push('# TYPE http_requests_total counter');
  for (const [key, value] of [...requestCounts.entries()].sort()) {
    const [method, route, status] = key.split('|');
    lines.push(
      `http_requests_total{method="${method}",route="${escapeLabelValue(route)}",status="${status}"} ${value}`,
    );
  }

  // === HTTP 耗时直方图 ===
  lines.push('# HELP http_request_duration_ms HTTP request duration in milliseconds.');
  lines.push('# TYPE http_request_duration_ms histogram');
  for (const [key, hist] of [...histograms.entries()].sort()) {
    const [method, route] = key.split('|');
    const labelPrefix = `method="${method}",route="${escapeLabelValue(route)}"`;
    for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
      lines.push(
        `http_request_duration_ms_bucket{${labelPrefix},le="${DURATION_BUCKETS_MS[i]}"} ${hist.buckets[i]}`,
      );
    }
    lines.push(`http_request_duration_ms_bucket{${labelPrefix},le="+Inf"} ${hist.count}`);
    lines.push(`http_request_duration_ms_sum{${labelPrefix}} ${Math.round(hist.sum * 100) / 100}`);
    lines.push(`http_request_duration_ms_count{${labelPrefix}} ${hist.count}`);
  }

  // === 进程指标 ===
  lines.push('# HELP process_uptime_seconds Process uptime in seconds.');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${Math.round(process.uptime() * 100) / 100}`);

  const mem = process.memoryUsage();
  lines.push('# HELP process_heap_used_bytes Heap memory used in bytes.');
  lines.push('# TYPE process_heap_used_bytes gauge');
  lines.push(`process_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# HELP process_rss_bytes Resident set size in bytes.');
  lines.push('# TYPE process_rss_bytes gauge');
  lines.push(`process_rss_bytes ${mem.rss}`);

  // === LLM 成本治理（来自 llm/cost 内存账本） ===
  const cost = getCostReport();
  lines.push('# HELP llm_calls_total Total number of LLM calls recorded.');
  lines.push('# TYPE llm_calls_total gauge');
  lines.push(`llm_calls_total ${cost.callCount}`);
  lines.push('# HELP llm_tokens_total Total tokens (prompt + completion) consumed.');
  lines.push('# TYPE llm_tokens_total gauge');
  lines.push(`llm_tokens_total ${cost.totalPromptTokens + cost.totalCompletionTokens}`);
  lines.push('# HELP llm_cost_total Estimated LLM cost in USD.');
  lines.push('# TYPE llm_cost_total gauge');
  lines.push(`llm_cost_total ${cost.totalCost}`);

  // === 合规熔断器状态（8 号文运行时即时熔断） ===
  lines.push(
    '# HELP circuit_breaker_tripped Whether the compliance circuit breaker is currently tripped.',
  );
  lines.push('# TYPE circuit_breaker_tripped gauge');
  lines.push(`circuit_breaker_tripped ${auditLogger.checkCircuitBreaker().tripped ? 1 : 0}`);

  return lines.join('\n') + '\n';
}

/** 测试用：清空 HTTP 指标（进程/LLM/熔断指标为实时读取，无需重置） */
export function resetMetrics(): void {
  requestCounts.clear();
  histograms.clear();
}

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
import { auditLogger } from './auditLog.js';

/** 请求耗时直方图桶边界（毫秒） */
const DURATION_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

/** 已知静态路由（精确匹配） */
const KNOWN_ROUTES = new Set([
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
]);

/** 自选股删除路由带路径参数：/api/watchlist/600519 → /api/watchlist/:code */
const WATCHLIST_CODE_RE = /^\/api\/watchlist\/\d{6}$/;

/**
 * 路由标签归一化：有界标签集，防止 Prometheus 标签基数爆炸。
 * 未匹配的 /api 路径归为 /api/:other，非 API 路径（生产 SPA 静态资源）归为 static_assets。
 */
export function normalizeRoute(path: string): string {
  if (KNOWN_ROUTES.has(path)) return path;
  if (WATCHLIST_CODE_RE.test(path)) return '/api/watchlist/:code';
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

/** 记录一次 HTTP 请求（由中间件在响应完成时调用） */
export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationMs: number,
): void {
  const countKey = `${method}|${route}|${status}`;
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

/** HTTP 指标采集中间件：挂在路由之前，响应 finish 时记录 */
export function httpMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      recordHttpRequest(req.method, normalizeRoute(req.path), res.statusCode, Date.now() - start);
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

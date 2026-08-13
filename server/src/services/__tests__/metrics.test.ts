import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeRoute,
  recordHttpRequest,
  renderPrometheus,
  resetMetrics,
  httpMetricsMiddleware,
} from '../metrics.js';

describe('metrics — normalizeRoute 路由标签归一化', () => {
  it('已知静态路由原样返回', () => {
    expect(normalizeRoute('/api/health')).toBe('/api/health');
    expect(normalizeRoute('/api/analyze')).toBe('/api/analyze');
    expect(normalizeRoute('/api/watchlist')).toBe('/api/watchlist');
  });

  it('自选股删除路径归一为 :code，防止标签基数爆炸', () => {
    expect(normalizeRoute('/api/watchlist/600519')).toBe('/api/watchlist/:code');
    expect(normalizeRoute('/api/watchlist/000858')).toBe('/api/watchlist/:code');
  });

  it('未知 /api 路径归为 /api/:other', () => {
    expect(normalizeRoute('/api/unknown-thing')).toBe('/api/:other');
    expect(normalizeRoute('/api/foo/bar/baz')).toBe('/api/:other');
  });

  it('非 API 路径（生产 SPA 静态资源）归为 static_assets', () => {
    expect(normalizeRoute('/')).toBe('static_assets');
    expect(normalizeRoute('/assets/index-abc.js')).toBe('static_assets');
  });
});

describe('metrics — recordHttpRequest + renderPrometheus', () => {
  beforeEach(() => resetMetrics());

  it('记录请求计数与耗时直方图，渲染为 Prometheus 文本格式', () => {
    recordHttpRequest('GET', '/api/health', 200, 15);
    recordHttpRequest('GET', '/api/health', 200, 320);
    recordHttpRequest('POST', '/api/analyze', 503, 42);

    const out = renderPrometheus();

    // counter：按 method/route/status 聚合
    expect(out).toContain('http_requests_total{method="GET",route="/api/health",status="200"} 2');
    expect(out).toContain('http_requests_total{method="POST",route="/api/analyze",status="503"} 1');

    // histogram：桶累计、+Inf、sum、count
    expect(out).toContain(
      'http_request_duration_ms_bucket{method="GET",route="/api/health",le="25"} 1',
    );
    expect(out).toContain(
      'http_request_duration_ms_bucket{method="GET",route="/api/health",le="+Inf"} 2',
    );
    expect(out).toContain('http_request_duration_ms_sum{method="GET",route="/api/health"} 335');
    expect(out).toContain('http_request_duration_ms_count{method="GET",route="/api/health"} 2');

    // 元信息行
    expect(out).toContain('# TYPE http_requests_total counter');
    expect(out).toContain('# TYPE http_request_duration_ms histogram');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('进程与熔断指标始终存在', () => {
    const out = renderPrometheus();
    expect(out).toMatch(/process_uptime_seconds [\d.]+/);
    expect(out).toMatch(/process_heap_used_bytes \d+/);
    expect(out).toMatch(/circuit_breaker_tripped [01]/);
    expect(out).toMatch(/llm_calls_total \d+/);
  });

  it('标签值中的特殊字符被转义', () => {
    recordHttpRequest('GET', '/api/x"y', 200, 5);
    const out = renderPrometheus();
    expect(out).toContain('route="/api/x\\"y"');
  });

  it('resetMetrics 清空 HTTP 指标', () => {
    recordHttpRequest('GET', '/api/health', 200, 10);
    resetMetrics();
    const out = renderPrometheus();
    expect(out).not.toContain('http_requests_total{');
    expect(out).not.toContain('http_request_duration_ms_bucket{');
  });
});

describe('metrics — httpMetricsMiddleware', () => {
  beforeEach(() => resetMetrics());

  it('响应 finish 时记录请求', () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const req = { method: 'GET', path: '/api/watchlist/600519' };
    const res = {
      statusCode: 200,
      on(event: string, cb: (...args: unknown[]) => void) {
        (listeners[event] ||= []).push(cb);
      },
    };
    let nextCalled = false;
    httpMetricsMiddleware()(req as never, res as never, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    listeners['finish'].forEach((cb) => cb());

    const out = renderPrometheus();
    expect(out).toContain(
      'http_requests_total{method="GET",route="/api/watchlist/:code",status="200"} 1',
    );
  });
});

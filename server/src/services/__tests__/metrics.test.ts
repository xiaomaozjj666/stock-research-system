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

  it('新增路由自动进表（取自 OpenAPI 契约），不再被打成 /api/:other', () => {
    // 这些路由此前不在手工维护的 KNOWN_ROUTES 里，全部退化成 /api/:other
    expect(normalizeRoute('/api/quant/factor/composite')).toBe('/api/quant/factor/composite');
    expect(normalizeRoute('/api/quant/factor/composite/batch')).toBe(
      '/api/quant/factor/composite/batch',
    );
    expect(normalizeRoute('/api/history')).toBe('/api/history');
  });

  it('契约里的路径参数按 Express 形态归一（标签基数仍有界）', () => {
    expect(normalizeRoute('/api/history/abc-123')).toBe('/api/history/:id');
    expect(normalizeRoute('/api/watchlist/600519')).toBe('/api/watchlist/:code');
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

  /** 造一个可手动触发 finish/close 的极简 res */
  function mockRes(statusCode = 200, writableEnded = false) {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const res = {
      statusCode,
      writableEnded,
      on(event: string, cb: (...args: unknown[]) => void) {
        (listeners[event] ||= []).push(cb);
      },
    };
    return { res, listeners };
  }

  it('响应 finish 时记录请求', () => {
    const { res, listeners } = mockRes(200);
    const req = { method: 'GET', path: '/api/watchlist/600519' };
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

  it('客户端中途断开（只有 close、没有 finish）记为 status="aborted"', () => {
    const { res, listeners } = mockRes(200, false);
    const req = { method: 'GET', path: '/api/analyze/stream' };
    httpMetricsMiddleware()(req as never, res as never, () => {});

    listeners['close'].forEach((cb) => cb()); // 断开：没有 finish

    const out = renderPrometheus();
    // SSE 长请求被取消必须可见（原实现只监听 finish，这类请求在指标里完全不存在）
    expect(out).toContain(
      'http_requests_total{method="GET",route="/api/analyze/stream",status="aborted"} 1',
    );
    // 耗时同样入直方图：能看到「分析了多久才被放弃」
    expect(out).toContain(
      'http_request_duration_ms_count{method="GET",route="/api/analyze/stream"} 1',
    );
  });

  it('finish 之后的 close 不重复计数，也不产生 aborted', () => {
    const { res, listeners } = mockRes(200, true); // 正常结束：writableEnded=true
    const req = { method: 'GET', path: '/api/analyze/stream' };
    httpMetricsMiddleware()(req as never, res as never, () => {});

    listeners['finish'].forEach((cb) => cb());
    listeners['close'].forEach((cb) => cb());

    const out = renderPrometheus();
    expect(out).toContain(
      'http_requests_total{method="GET",route="/api/analyze/stream",status="200"} 1',
    );
    expect(out).not.toContain('status="aborted"');
    expect(out).toContain(
      'http_request_duration_ms_count{method="GET",route="/api/analyze/stream"} 1',
    );
  });

  it('finish 与 close 同时到达也只计一次（幂等）', () => {
    const { res, listeners } = mockRes(200, false); // 极端时序：close 先到
    const req = { method: 'GET', path: '/api/health' };
    httpMetricsMiddleware()(req as never, res as never, () => {});

    listeners['close'].forEach((cb) => cb());
    listeners['finish'].forEach((cb) => cb());

    const out = renderPrometheus();
    expect(out).toContain(
      'http_requests_total{method="GET",route="/api/health",status="aborted"} 1',
    );
    expect(out).not.toContain('route="/api/health",status="200"');
    expect(out).toContain('http_request_duration_ms_count{method="GET",route="/api/health"} 1');
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';

describe('GET /api/metrics 路由', () => {
  it('返回 200、Prometheus 文本格式与核心指标', async () => {
    // 先打一个请求，确保指标非空（中间件在 finish 时记录）
    await request(app).get('/api/health');

    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const body = res.text;
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('# TYPE http_request_duration_ms histogram');
    expect(body).toMatch(/process_uptime_seconds [\d.]+/);
    expect(body).toMatch(/circuit_breaker_tripped [01]/);
    // 上面那次 /api/health 请求本身应已被计入
    expect(body).toContain('route="/api/health"');
  });
});

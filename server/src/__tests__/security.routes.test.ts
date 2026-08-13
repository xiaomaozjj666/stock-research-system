import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';

describe('安全中间件', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('安全响应头', () => {
    it('响应包含 X-Content-Type-Options: nosniff', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('响应包含 X-Frame-Options: DENY', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('响应包含 Referrer-Policy', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['referrer-policy']).toBeTruthy();
    });

    it('响应包含 Permissions-Policy', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['permissions-policy']).toBeTruthy();
    });

    it('响应包含 Content-Security-Policy', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['content-security-policy']).toBeTruthy();
    });

    it('响应包含 X-Download-Options', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-download-options']).toBe('noopen');
    });

    it('响应包含 X-Request-ID', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(typeof res.headers['x-request-id']).toBe('string');
    });

    it('请求携带 X-Request-ID 时透传', async () => {
      const customId = 'test-request-id-123';
      const res = await request(app).get('/api/health').set('X-Request-ID', customId);
      expect(res.headers['x-request-id']).toBe(customId);
    });
  });

  describe('CORS', () => {
    it('开发环境允许所有来源', async () => {
      process.env.NODE_ENV = 'development';
      const origin = 'http://any-origin.com';
      const res = await request(app).get('/api/health').set('Origin', origin);
      // cors 包在 origin=true 时会回显请求的 Origin（而非返回 *）
      // 只要返回了该 origin 就表示允许
      const acao = res.headers['access-control-allow-origin'];
      expect(acao === '*' || acao === origin).toBe(true);
    });

    it('预检请求返回 204', async () => {
      const res = await request(app)
        .options('/api/health')
        .set('Origin', 'http://localhost:5173')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBe(204);
    });

    it('响应包含 Vary: Origin 头', async () => {
      const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
      // Vary 头可能包含多个值，检查是否包含 Origin
      const vary = res.headers['vary'];
      expect(vary).toBeTruthy();
      if (typeof vary === 'string') {
        expect(vary.toLowerCase()).toContain('origin');
      }
    });
  });

  describe('请求体大小限制', () => {
    it('正常大小的 JSON 请求正常处理', async () => {
      const res = await request(app).post('/api/watchlist').send({ code: '600519' });
      // 不关心业务结果，只要不是 413 就行
      expect(res.status).not.toBe(413);
    });

    it('超大请求体返回 413', async () => {
      // 构造一个超过 100kb 的 JSON body
      const largePayload = { data: 'x'.repeat(150 * 1024) };
      const res = await request(app).post('/api/watchlist').send(largePayload);
      expect(res.status).toBe(413);
    });
  });

  describe('错误处理', () => {
    it('404 返回结构化 JSON', async () => {
      const res = await request(app).get('/api/nonexistent-route');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('path');
    });

    it('404 响应包含 requestId', async () => {
      const res = await request(app).get('/api/nonexistent-route');
      expect(res.headers['x-request-id']).toBeTruthy();
    });
  });
});

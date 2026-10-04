import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiAuthGuard, extractToken, getApiAuthToken } from '../middleware.js';

/**
 * API 访问令牌鉴权的契约。
 *
 * 最要紧的两条不变量：
 *  1. **未配置 API_AUTH_TOKEN 时行为与加这个中间件之前逐字相同**（完全放行）——
 *     本地开发与 3300+ 既有用例都依赖这一点，回归了就是破坏性变更。
 *  2. 启用后不能有绕过路径：只有 OPTIONS 预检与 /api/health 免鉴权。
 */

const origToken = process.env.API_AUTH_TOKEN;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiAuthGuard);
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/watchlist', (_req, res) => {
    res.json({ items: [] });
  });
  app.get('/api/quant/ledger', (_req, res) => {
    res.json({ entries: [] });
  });
  app.post('/api/chat', (_req, res) => {
    res.json({ reply: 'ok' });
  });
  return app;
}

beforeEach(() => {
  delete process.env.API_AUTH_TOKEN;
});
afterEach(() => {
  if (origToken === undefined) delete process.env.API_AUTH_TOKEN;
  else process.env.API_AUTH_TOKEN = origToken;
});

describe('apiAuthGuard — 未启用时（默认）', () => {
  it('未设置 API_AUTH_TOKEN → 所有请求照常放行', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/watchlist')).status).toBe(200);
    expect((await request(app).post('/api/chat').send({ message: 'x' })).status).toBe(200);
  });

  it('空串/纯空白视为未启用（不是"配了个空令牌"）', () => {
    process.env.API_AUTH_TOKEN = '   ';
    expect(getApiAuthToken()).toBeNull();
    process.env.API_AUTH_TOKEN = '';
    expect(getApiAuthToken()).toBeNull();
  });

  it('getApiAuthToken 会 trim 前后空白', () => {
    process.env.API_AUTH_TOKEN = '  secret-abc  ';
    expect(getApiAuthToken()).toBe('secret-abc');
  });
});

describe('apiAuthGuard — 启用后', () => {
  const TOKEN = 'a-very-long-random-token-value-0123456789';

  beforeEach(() => {
    process.env.API_AUTH_TOKEN = TOKEN;
  });

  it('缺令牌 → 401 + WWW-Authenticate，且提示浏览器与脚本两条取得方式', async () => {
    const r = await request(buildApp()).get('/api/watchlist');
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('Bearer');
    expect(r.body.code).toBe('UNAUTHORIZED');
    // 浏览器用户走页面解锁条，脚本走 header —— 两条都要在文案里出现
    expect(r.body.error).toContain('解锁条');
    expect(r.body.error).toContain('Authorization: Bearer');
  });

  it('令牌错误 → 401，且**不回显**期望值', async () => {
    const r = await request(buildApp())
      .get('/api/watchlist')
      .set('Authorization', 'Bearer wrong-token');
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it('Bearer 令牌正确 → 放行', async () => {
    const r = await request(buildApp())
      .get('/api/watchlist')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
  });

  it('bearer 小写也应放行（HTTP 认证 scheme 大小写不敏感）', async () => {
    const r = await request(buildApp())
      .get('/api/watchlist')
      .set('Authorization', `bearer ${TOKEN}`);
    expect(r.status).toBe(200);
  });

  it('x-api-token 头同样可用（curl 场景）', async () => {
    const r = await request(buildApp()).get('/api/watchlist').set('x-api-token', TOKEN);
    expect(r.status).toBe(200);
  });

  it('token 是正确前缀但不等 → 仍 401（长度/内容都要对上）', async () => {
    const r = await request(buildApp())
      .get('/api/watchlist')
      .set('Authorization', `Bearer ${TOKEN.slice(0, -1)}`);
    expect(r.status).toBe(401);
  });

  it('所有业务路由都被覆盖到，不只是第一条', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/watchlist')).status).toBe(401);
    expect((await request(app).get('/api/quant/ledger')).status).toBe(401);
    expect((await request(app).post('/api/chat').send({ message: 'x' })).status).toBe(401);
  });

  it('/api/health 免鉴权（探针不能要求令牌）', async () => {
    expect((await request(buildApp()).get('/api/health')).status).toBe(200);
  });

  it('/api/health 的子路径同样免鉴权', async () => {
    const app = buildApp();
    app.get('/api/health/live', (_req, res) => {
      res.json({ ok: true });
    });
    expect((await request(app).get('/api/health/live')).status).toBe(200);
  });

  it('名字相近的路径**不**豁免（避免 /api/healthz 之类被顺手放行）', async () => {
    const app = buildApp();
    app.get('/api/healthz', (_req, res) => {
      res.json({ ok: true });
    });
    expect((await request(app).get('/api/healthz')).status).toBe(401);
  });
});

describe('extractToken', () => {
  it('Authorization: Bearer <t> → 取 t', () => {
    expect(extractToken({ headers: { authorization: 'Bearer abc123' } } as never)).toBe('abc123');
  });

  it('非 Bearer 方案 → 不从中取值', () => {
    expect(extractToken({ headers: { authorization: 'Basic abc123' } } as never)).toBeNull();
  });

  it('只有 x-api-token → 取该值', () => {
    expect(extractToken({ headers: { 'x-api-token': 'abc123' } } as never)).toBe('abc123');
  });

  it('两者都有时优先 Authorization', () => {
    expect(
      extractToken({
        headers: { authorization: 'Bearer from-auth', 'x-api-token': 'from-header' },
      } as never),
    ).toBe('from-auth');
  });

  it('空 Bearer 值不算有效令牌', () => {
    expect(extractToken({ headers: { authorization: 'Bearer    ' } } as never)).toBeNull();
  });

  it('无任何令牌头 → null', () => {
    expect(extractToken({ headers: {} } as never)).toBeNull();
  });

  /* === query 令牌：只给 SSE 用（EventSource 无法自定义请求头） === */
  it('GET + ?token= → 取该值', () => {
    expect(extractToken({ method: 'GET', headers: {}, query: { token: 'abc123' } } as never)).toBe(
      'abc123',
    );
  });

  it('非 GET 的 query token 一律不认（限制凭据进 URL 的泄漏面）', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(extractToken({ method, headers: {}, query: { token: 'abc123' } } as never)).toBeNull();
    }
  });

  it('query 里 token 缺失/为空串 → null', () => {
    expect(extractToken({ method: 'GET', headers: {}, query: {} } as never)).toBeNull();
    expect(
      extractToken({ method: 'GET', headers: {}, query: { token: '   ' } } as never),
    ).toBeNull();
  });

  it('请求头优先于 query（两者都给出时用 Authorization）', () => {
    expect(
      extractToken({
        method: 'GET',
        headers: { 'x-api-token': 'from-header' },
        query: { token: 'from-query' },
      } as never),
    ).toBe('from-header');
  });
});

/**
 * SSE 端点在启用鉴权后的真实可达性。
 *
 * 这条契约来自一个真实约束：浏览器 EventSource **不能**自定义请求头，因此前端
 * 只能用 `?token=`。若这里 401，SSE 功能的失败方式会是「连接即断」，且用户
 * 完全看不出是鉴权问题——所以必须用 supertest 钉住。
 */
describe('SSE 端点与鉴权', () => {
  const TOKEN = 'a-very-long-random-token-value-0123456789';

  beforeEach(() => {
    process.env.API_AUTH_TOKEN = TOKEN;
  });

  function buildStreamApp() {
    const app = express();
    app.use('/api', apiAuthGuard);
    // 与真实端点同形：GET + text/event-stream
    app.get('/api/analyze/stream', (_req, res) => {
      res.set('Content-Type', 'text/event-stream').json({ phase: 'data' });
    });
    app.get('/api/chat/stream', (_req, res) => {
      res.set('Content-Type', 'text/event-stream').json({ phase: 'planning' });
    });
    return app;
  }

  it('SSE 端点无令牌 → 401（EventSource 不会自动带凭据）', async () => {
    const app = buildStreamApp();
    expect((await request(app).get('/api/analyze/stream')).status).toBe(401);
    expect((await request(app).get('/api/chat/stream')).status).toBe(401);
  });

  it('SSE 端点带 ?token= → 放行（前端走的就是这条路）', async () => {
    const app = buildStreamApp();
    expect((await request(app).get(`/api/analyze/stream?token=${TOKEN}`)).status).toBe(200);
    expect((await request(app).get(`/api/chat/stream?token=${TOKEN}`)).status).toBe(200);
  });

  it('SSE 端点带错误 ?token= → 401', async () => {
    expect((await request(buildStreamApp()).get('/api/analyze/stream?token=wrong')).status).toBe(
      401,
    );
  });

  it('SSE 端点在未启用鉴权时照常放行（默认路径不变）', async () => {
    delete process.env.API_AUTH_TOKEN;
    expect((await request(buildStreamApp()).get('/api/analyze/stream')).status).toBe(200);
  });
});

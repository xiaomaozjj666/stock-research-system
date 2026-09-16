import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';

/**
 * 新增限流器的 429 分支（P1：部分网络型/只读端点无限流）
 * ----------------------------------------------------------------------------
 * 背景（审计）：/api/health、/api/intl/*、/api/history、/api/stocks、/api/audit、
 * /api/documents、/api/models、/api/cost 等端点此前完全没有限流，脚本可以无限刷
 * （每个请求都可能触发上游外呼或全量读盘）。本文件验证这些端点确实挂上了限流器、
 * 且超阈值走 429 + Retry-After。
 *
 * 为什么每个用例都用 vi.resetModules() 重新加载 app：
 * 限流计数存在 middleware.ts 的模块级实例里，同一文件内多个用例会共享配额，
 * 无法确定性断言「第 N 次 429」。vitest 默认按文件隔离，但文件内共享，
 * 故这里用「重置模块注册表 + 重新 import index.js」为每个用例拿一份干净的限流状态。
 *
 * 被限流端点本身都取本地数据（audit/cost/documents）或已打桩（health 外呼），不触真实网络。
 */

const ORIGINAL_ENV = { ...process.env };

/** 重置模块注册表 → 设 env → 重新加载 app（限流阈值在 middleware.ts 加载期求值） */
async function freshApp(env: Record<string, string>): Promise<import('express').Express> {
  vi.resetModules();
  Object.assign(process.env, env);
  const mod = await import('../index.js');
  // 重新加载会连带重置 logger 的级别（setup.ts 的静音只作用于原注册表），这里再压一次，
  // 否则每个用例都会刷一屏 HTTP request 日志
  const { setLogLevel } = await import('../utils/logger.js');
  setLogLevel('error');
  return mod.app;
}

afterEach(() => {
  // env 复原：不同用例通过 freshApp 覆盖过阈值/开关
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('metaLimiter —— 只读元数据端点', () => {
  it('阈值 2：/api/audit 前两次 200，第三次 429（带中文提示与 Retry-After）', async () => {
    const app = await freshApp({ RATE_LIMIT_MAX_META: '2' });

    const first = await request(app).get('/api/audit');
    const second = await request(app).get('/api/audit');
    const third = await request(app).get('/api/audit');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.error).toContain('元数据请求过于频繁');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('同一 metaLimiter 覆盖多个端点：配额共享，跨端点累计后同样 429', async () => {
    const app = await freshApp({ RATE_LIMIT_MAX_META: '2' });

    // 三个不同端点（audit / documents / cost），共享同一份额度
    const a = await request(app).get('/api/audit');
    const b = await request(app).get('/api/documents');
    const c = await request(app).get('/api/cost');

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(429);
  });

  it('被限流时不得触达业务逻辑（429 由中间件短路）', async () => {
    const app = await freshApp({ RATE_LIMIT_MAX_META: '1' });

    const first = await request(app).get('/api/audit');
    const second = await request(app).get('/api/audit');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    // 429 响应体是限流器自己的结构，不是路由的 { count, entries }
    expect(second.body.entries).toBeUndefined();
    expect(second.body.count).toBeUndefined();
  });
});

describe('healthLimiter —— 监控拉取端点', () => {
  it('阈值 3：/api/health 前三次放行、第四次 429', async () => {
    // 外呼打桩 + memo 关闭：本用例只验证限流，健康检查本身不触网
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const app = await freshApp({ RATE_LIMIT_MAX_HEALTH: '3', HEALTH_PROBE_MEMO_MS: '0' });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await request(app).get('/api/health')).status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  it('默认阈值足够高：常规探针频率（1 秒 1 次 = 60 req/min）不会误报 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    // 不覆盖 RATE_LIMIT_MAX_HEALTH，用默认 120
    const app = await freshApp({ HEALTH_PROBE_MEMO_MS: '0' });

    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      statuses.push((await request(app).get('/api/health')).status);
    }

    expect(statuses.every((s) => s === 200)).toBe(true);
  });
});

describe('writeLimiter —— 轻量状态变更端点', () => {
  it('阈值 1：POST /api/cost/reset 第二次即 429（读接口的宽松配额不覆盖写接口）', async () => {
    const app = await freshApp({ RATE_LIMIT_MAX_WRITE: '1' });

    const first = await request(app).post('/api/cost/reset');
    const second = await request(app).post('/api/cost/reset');

    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(second.status).toBe(429);
    expect(second.body.error).toContain('写操作过于频繁');
  });

  it('写配额与读配额相互独立：写接口被限流不影响只读接口', async () => {
    const app = await freshApp({ RATE_LIMIT_MAX_WRITE: '1', RATE_LIMIT_MAX_META: '5' });

    await request(app).post('/api/cost/reset');
    const blocked = await request(app).post('/api/cost/reset');
    const read = await request(app).get('/api/cost');

    expect(blocked.status).toBe(429);
    expect(read.status).toBe(200);
  });
});

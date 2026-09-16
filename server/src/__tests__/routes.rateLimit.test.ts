/**
 * ============================================================================
 * 限流 429 分支测试（searchLimiter / analyzeLimiter）—— 防的是「限流器形同虚设」。
 *
 * 背景（审计）：middleware.ts 的六个限流器与 429 分支此前零断言，而 vitest.config.mts
 * 反而把 RATE_LIMIT_MAX_WATCHLIST 放大到 100 来规避限流。于是「阈值被改成 0 / 限流器
 * 被从路由摘掉 / 中文提示与 retryAfter 字段被删 / RateLimit-* 与 Retry-After 响应头
 * 消失」这类回归不会有任何测试变红。
 *
 * 做法：用 env 把两个限流器的阈值压到极小（search=2、analyze=1）。middleware.ts 的
 * `Number(process.env.RATE_LIMIT_MAX_*)` 是**模块加载期求值**，而 ESM import 会被提升到
 * 模块体之前——直接写 `process.env.X = ...` + 静态 import 无效（实测仍读到默认 30），
 * 必须放在 vi.hoisted 回调里（见下方注释）。不修改 vitest.config.mts（其他会话可能正在改）。
 *
 * 隔离：/api/stocks/search 的服务层打桩，不触真实网络；/api/analyze 只用"非法代码"
 * 请求打限流计数，不会进入 runAnalysis（真实分析需要 LLM，本文件绝不触发）。
 * ============================================================================
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// 关键：env 必须在 middleware.ts 求值之前生效。ESM 的 import 会被提升到模块体之前，
// 直接写 `process.env.X = ...` 再 import 是无效的（实测限流阈值仍是默认 30）。
// vi.hoisted 的回调会先于所有 import 执行，故在此设置阈值。
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX_SEARCH = '2';
  process.env.RATE_LIMIT_MAX_ANALYZE = '1';
});

const mocks = vi.hoisted(() => ({ searchStocks: vi.fn() }));

vi.mock('../services/dataService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dataService.js')>();
  return { ...actual, searchStocks: mocks.searchStocks };
});

import { app } from '../index.js';

/** 限流窗口 60s（RATE_LIMIT_WINDOW_MS 未覆盖），Retry-After 应落在 (0, 60] */
const MAX_EXPECTED_RETRY_AFTER = 60;

beforeEach(() => {
  mocks.searchStocks.mockReset();
  mocks.searchStocks.mockResolvedValue([{ code: '600519', name: '贵州茅台' }]);
});

describe('searchLimiter：/api/stocks/search 超过阈值 → 429', () => {
  it('前 2 次放行、第 3 次 429，响应体含中文提示与 retryAfter，且带标准限流响应头', async () => {
    const first = await request(app).get('/api/stocks/search').query({ keyword: '茅台' });
    const second = await request(app).get('/api/stocks/search').query({ keyword: '茅台' });
    const third = await request(app).get('/api/stocks/search').query({ keyword: '茅台' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);

    // 429 响应体：中文提示 + retryAfter（前端据此提示"稍后再试"）
    expect(third.body.error).toBe('搜索请求过于频繁，请稍后再试');
    expect(third.body.retryAfter).toBeGreaterThan(0);
    expect(third.body.retryAfter).toBeLessThanOrEqual(MAX_EXPECTED_RETRY_AFTER);

    // 标准响应头（standardHeaders: true）：供客户端/网关读取配额与退避时间
    expect(third.headers['retry-after']).toBeDefined();
    const retryAfterSec = Number(third.headers['retry-after']);
    expect(Number.isInteger(retryAfterSec)).toBe(true);
    expect(retryAfterSec).toBeGreaterThan(0);
    expect(retryAfterSec).toBeLessThanOrEqual(MAX_EXPECTED_RETRY_AFTER);
    expect(third.headers['ratelimit-limit']).toBe('2');
    expect(third.headers['ratelimit-remaining']).toBe('0');

    // 放行的那两次也应带配额头，且不出现 429
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect(second.headers['ratelimit-remaining']).toBe('0');
    // 被限流的请求不得触达业务逻辑（限流中间件在路由处理之前短路）
    expect(mocks.searchStocks).toHaveBeenCalledTimes(2);
  });

  it('429 后同一窗口内继续请求仍被拒（计数不回退）', async () => {
    await request(app).get('/api/stocks/search').query({ keyword: '茅台' });
    await request(app).get('/api/stocks/search').query({ keyword: '茅台' });
    const blocked = await request(app).get('/api/stocks/search').query({ keyword: '茅台' });
    const again = await request(app).get('/api/stocks/search').query({ keyword: '茅台' });

    expect(blocked.status).toBe(429);
    expect(again.status).toBe(429);
  });
});

describe('analyzeLimiter：/api/analyze 超过阈值 → 429', () => {
  it('阈值 1：第 1 次进入业务校验（400），第 2 次即 429 并带中文提示与响应头', async () => {
    // 用非法代码请求：只消耗限流计数，不进入 runAnalysis（不触发真实 LLM）
    const first = await request(app).post('/api/analyze').send({ stockCode: 'abc' });
    const second = await request(app).post('/api/analyze').send({ stockCode: 'abc' });

    expect(first.status).toBe(400);
    expect(first.body.error).toBe('请提供有效的6位股票代码');
    expect(second.status).toBe(429);

    expect(second.body.error).toBe('请求过于频繁，请稍后再试');
    expect(second.body.retryAfter).toBeGreaterThan(0);
    expect(second.body.retryAfter).toBeLessThanOrEqual(MAX_EXPECTED_RETRY_AFTER);
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.headers['ratelimit-limit']).toBe('1');
    expect(second.headers['ratelimit-remaining']).toBe('0');
  });
});

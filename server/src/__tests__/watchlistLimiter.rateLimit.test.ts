/**
 * ============================================================================
 * watchlistLimiter 的 429 分支测试 —— 防的是「该限流器的 429 从未被测过」。
 *
 * 背景（审计）：vitest.config.mts 把 RATE_LIMIT_MAX_WATCHLIST 放大到 100
 * （为的是让批量回测的集成测试不撞限流），于是这个限流器的 429 分支在既有套件里
 * **零断言**：阈值被误配成 0、限流器被从路由上摘掉、中文提示或 Retry-After 被删，
 * 都不会有测试变红。
 *
 * 做法（与 routes.rateLimit.test.ts 同一坑、同一解法）：middleware.ts 的
 * `Number(process.env.RATE_LIMIT_MAX_WATCHLIST)` 是**模块加载期求值**，而 ESM import
 * 会被提升到模块体之前——把 `process.env.X = ...` 写在文件体里无效（实测仍读到 100），
 * 必须放进 vi.hoisted 回调（它先于所有 import 执行）。不修改 vitest.config.mts。
 *
 * 隔离（与 networkEndpoints.rateLimit.test.ts 同一做法）：限流计数存在 middleware.ts
 * 的模块级实例里，同文件多个用例会共享配额；故每个用例都 vi.resetModules() 后重新
 * import app，拿一份干净的限流状态，避免断言依赖用例执行顺序。
 * 业务侧：watchlistBacktest 打桩（不触真实行情/新闻网络），第 2 次请求应在限流
 * 中间件处短路、不进入业务逻辑。
 * ============================================================================
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// 每个用例都要 resetModules 后重新 import 整个应用（限流计数在模块级实例里）。
// 全量套件（180+ 文件并行）时这一步可能超过 vitest 默认的 5s 用例超时——
// 那是加载竞争导致的假失败，不是逻辑错误，故给本文件放宽到 30s。
vi.setConfig({ testTimeout: 30_000 });

// 关键：阈值必须在 middleware.ts 求值之前生效（见文件头注释）。
// vitest.config.mts 会先把 RATE_LIMIT_MAX_WATCHLIST 设为 100，这里在 import 之前压回 1。
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX_WATCHLIST = '1';
});

const mocks = vi.hoisted(() => ({ runWatchlistNewsBacktest: vi.fn() }));

vi.mock('../services/watchlistBacktest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/watchlistBacktest.js')>();
  return { ...actual, runWatchlistNewsBacktest: mocks.runWatchlistNewsBacktest };
});

/** 重置模块注册表 → 重新加载 app（限流阈值与计数都在模块加载期建立） */
async function freshApp(): Promise<import('express').Express> {
  vi.resetModules();
  process.env.RATE_LIMIT_MAX_WATCHLIST = '1';
  const mod = await import('../index.js');
  // 重新加载会连带重置 logger 级别（setup.ts 的静音只作用于原注册表），这里再压一次，
  // 否则每个用例都会刷一屏 HTTP request 日志
  const { setLogLevel } = await import('../utils/logger.js');
  setLogLevel('error');
  return mod.app;
}

/** 限流窗口 60s（RATE_LIMIT_WINDOW_MS 未覆盖），Retry-After 应落在 (0, 60] */
const MAX_EXPECTED_RETRY_AFTER = 60;

const OK_REPORT = {
  generatedAt: '2026-09-17T00:00:00.000Z',
  count: 1,
  withNewsCount: 0,
  results: [],
  requested: 1,
  skipped: 0,
};

beforeEach(() => {
  mocks.runWatchlistNewsBacktest.mockReset();
  mocks.runWatchlistNewsBacktest.mockResolvedValue(OK_REPORT);
});

describe('watchlistLimiter：超过阈值 → 429（RATE_LIMIT_MAX_WATCHLIST=1）', () => {
  it('第 1 次通过（200）、第 2 次 429，响应含中文提示与 Retry-After', async () => {
    const app = await freshApp();
    const body = { codes: ['600519'] };

    const first = await request(app).post('/api/watchlist/news-backtest').send(body);
    const second = await request(app).post('/api/watchlist/news-backtest').send(body);

    // 第 1 次确实走通了业务路径（不是被别的分支短路）
    expect(first.status).toBe(200);
    expect(first.body.count).toBe(1);
    expect(mocks.runWatchlistNewsBacktest).toHaveBeenCalledTimes(1);

    // 第 2 次：429 + 中文提示 + retryAfter + 标准限流响应头
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('自选股批量回测过于频繁（限制：每分钟3次），请稍后再试');
    expect(second.body.retryAfter).toBeGreaterThan(0);
    expect(second.body.retryAfter).toBeLessThanOrEqual(MAX_EXPECTED_RETRY_AFTER);
    expect(second.headers['retry-after']).toBeDefined();
    const retryAfterSec = Number(second.headers['retry-after']);
    expect(Number.isInteger(retryAfterSec)).toBe(true);
    expect(retryAfterSec).toBeGreaterThan(0);
    expect(retryAfterSec).toBeLessThanOrEqual(MAX_EXPECTED_RETRY_AFTER);
    expect(second.headers['ratelimit-limit']).toBe('1');
    expect(second.headers['ratelimit-remaining']).toBe('0');

    // 被限流的请求不得触达业务逻辑（限流中间件在路由处理之前短路）
    expect(mocks.runWatchlistNewsBacktest).toHaveBeenCalledTimes(1);
    // 放行的那一次带配额头
    expect(first.headers['ratelimit-remaining']).toBe('0');
  });

  it('/api/watchlist/monitor 与 news-backtest 共用同一配额（同一限流器实例）', async () => {
    const app = await freshApp();

    const first = await request(app)
      .post('/api/watchlist/news-backtest')
      .send({ codes: ['600519'] });
    expect(first.status).toBe(200);

    // 另一条挂同一限流器的路由：同一窗口内配额已耗尽 → 429
    const second = await request(app).post('/api/watchlist/monitor').send({});
    expect(second.status).toBe(429);
    expect(second.body.error).toContain('自选股批量回测过于频繁');
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    // 被拒的请求没有进入监控业务（否则会去拉整张清单）
    expect(mocks.runWatchlistNewsBacktest).toHaveBeenCalledTimes(1);
  });

  it('429 后同一窗口内继续请求仍被拒（计数不回退）', async () => {
    const app = await freshApp();
    const body = { codes: ['600519'] };

    expect((await request(app).post('/api/watchlist/news-backtest').send(body)).status).toBe(200);
    const blocked = await request(app).post('/api/watchlist/news-backtest').send(body);
    const again = await request(app).post('/api/watchlist/news-backtest').send(body);

    expect(blocked.status).toBe(429);
    expect(again.status).toBe(429);
    expect(mocks.runWatchlistNewsBacktest).toHaveBeenCalledTimes(1);
  });
});

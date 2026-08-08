import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';

// 用 vi.hoisted 预创建 mock，确保 vi.mock 工厂可引用（避免 TDZ）
const mocks = vi.hoisted(() => ({
  getWatchlist: vi.fn((): string[] => []),
  addToWatchlist: vi.fn((c: string) => [c]),
  removeFromWatchlist: vi.fn((): string[] => []),
}));

vi.mock('../services/watchlistService.js', () => ({
  getWatchlist: mocks.getWatchlist,
  addToWatchlist: mocks.addToWatchlist,
  removeFromWatchlist: mocks.removeFromWatchlist,
}));

beforeEach(() => {
  mocks.getWatchlist.mockReturnValue([]);
  mocks.addToWatchlist.mockImplementation((c: string) => [c]);
  mocks.removeFromWatchlist.mockReturnValue([]);
});

describe('API 路由集成（不触网）', () => {
  it('GET /api/watchlist → 200 且返回 codes 数组', async () => {
    mocks.getWatchlist.mockReturnValue(['600519']);
    const res = await request(app).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.codes)).toBe(true);
    expect(res.body.codes).toContain('600519');
  });

  it('POST /api/watchlist 合法代码 → 200，codes 含该代码', async () => {
    const res = await request(app).post('/api/watchlist').send({ code: '600519' });
    expect(res.status).toBe(200);
    expect(mocks.addToWatchlist).toHaveBeenCalledWith('600519');
    expect(res.body.codes).toContain('600519');
  });

  it('POST /api/watchlist 非法代码 → 400', async () => {
    const res = await request(app).post('/api/watchlist').send({ code: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('DELETE /api/watchlist/:code → 200，调用 removeFromWatchlist', async () => {
    const res = await request(app).delete('/api/watchlist/600519');
    expect(res.status).toBe(200);
    expect(mocks.removeFromWatchlist).toHaveBeenCalledWith('600519');
  });

  it('DELETE /api/watchlist/:code 非法代码 → 400', async () => {
    const res = await request(app).delete('/api/watchlist/abc');
    expect(res.status).toBe(400);
  });

  it('POST /api/watchlist/news-backtest 清单为空 → 400', async () => {
    mocks.getWatchlist.mockReturnValue([]);
    const res = await request(app).post('/api/watchlist/news-backtest').send({ codes: [] });
    expect(res.status).toBe(400);
  });

  it('POST /api/quant/analyze 缺少 strategy → 400', async () => {
    const res = await request(app).post('/api/quant/analyze').send({});
    expect(res.status).toBe(400);
  });

  it('未知路由 → 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it('telemetry 中间件已接线：每个响应都注入 X-Trace-Id', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    // expressTracerMiddleware 注册于 index.ts，为每个请求注入 X-Trace-Id 响应头
    expect(typeof res.headers['x-trace-id']).toBe('string');
    expect(String(res.headers['x-trace-id'])).toMatch(/^[0-9a-f]{32}$/);
  });

  it('telemetry 中间件已接线：GET /api/watchlist 同样带 X-Trace-Id', async () => {
    const res = await request(app).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(typeof res.headers['x-trace-id']).toBe('string');
  });
});

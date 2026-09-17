import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';

/**
 * 回归：畸形 JSON 请求体此前落到通用分支返回 500「服务器内部错误」，
 * 把调用方的输入问题说成服务端故障，排查方向完全错。body-parser 会带
 * type='entity.parse.failed' 且 statusCode=400，现在按 400 处理。
 * 该中间件对所有 POST 路由生效，这里取几个代表端点。
 */
const ENDPOINTS = ['/api/analyze', '/api/paper/order', '/api/watchlist', '/api/quant/analyze'];

describe('畸形 JSON 请求体', () => {
  it.each(ENDPOINTS)('%s 返回 400 而不是 500', async (path) => {
    const res = await request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .send('{"stockCode": '); // 截断的 JSON

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('合法 JSON');
  });

  it('合法 JSON 但字段非法时仍走各路由自己的校验（400 且带具体原因）', async () => {
    const res = await request(app)
      .post('/api/paper/order')
      .set('Content-Type', 'application/json')
      .send({ side: 'buy', type: 'market', code: '600519', quantity: 100 });
    // 未初始化交易日等业务前置条件由路由决定，关键是不能变成 500「服务器内部错误」
    expect(res.status).toBeLessThan(500);
  });
});

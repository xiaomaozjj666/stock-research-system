import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../index.js';
import { withContract, findContractPath, CONTRACT_VIOLATION_FIELD } from '../contractSupertest.js';
import { buildOpenApiDocument } from '../../services/openapi.js';

const doc = buildOpenApiDocument() as unknown as {
  paths: Record<
    string,
    Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>
  >;
};

/**
 * 契约 supertest 中间件的门禁
 * ============================================================================
 * 这个中间件会挂到 30 个既有路由测试上，所以它自己失效的代价极高 ——
 * 一旦它「看起来在工作、实际不校验」，30 个文件会一起给出假绿。
 * 故本文件专门验证三件事：它会红、它不误伤、模板匹配正确。
 */

describe('契约 supertest — 模板匹配', () => {
  it('把实际 URL 映射到契约 path（含 {param} 模板）', () => {
    expect(findContractPath('get', '/api/paper/portfolio')).toBe('/api/paper/portfolio');
    // 契约是模板，请求是具体值 —— 必须能匹配上
    expect(findContractPath('get', '/api/history/abc123')).toBe('/api/history/{id}');
    expect(findContractPath('delete', '/api/history/abc123')).toBe('/api/history/{id}');
    // 带查询串
    expect(findContractPath('get', '/api/audit?limit=10')).toBe('/api/audit');
  });

  it('方法不匹配时不误配（GET 不会匹配到 POST 的契约）', () => {
    expect(findContractPath('get', '/api/paper/order')).toBeNull();
    expect(findContractPath('post', '/api/paper/portfolio')).toBeNull();
  });

  it('契约里没有的端点返回 null（不因契约未收录就让既有测试变红）', () => {
    expect(findContractPath('get', '/api/definitely-not-in-spec')).toBeNull();
  });

  it('SSE 端点不参与 JSON 校验（响应是 text/event-stream，不是 JSON）', () => {
    // 这两个端点的响应体是 SSE 帧序列，由 components.schemas 里的
    // *StreamEvent 描述事件结构，不适用 JSON Schema 校验。
    // 它们与 apiAuth.middleware.test.ts（自建 express app 测中间件，不打真实端点）
    // 是**仅有的两个未接入** withContract 的路由测试文件 —— 刻意排除，不是遗漏。
    expect(findContractPath('get', '/api/analyze/stream')).toBe('/api/analyze/stream');
    const op = doc.paths['/api/analyze/stream']?.get;
    // 确认它确实没有 application/json（否则上面的排除就站不住）
    expect(
      op?.responses?.[Object.keys(op.responses ?? {}).find((c) => /^2\d\d$/.test(c)) ?? '200']
        ?.content?.['application/json'],
    ).toBeUndefined();
  });
});

describe('契约 supertest — 对真实 app 生效', () => {
  const wrapped = withContract(app);

  it('合法响应原样通过（不误伤既有断言）', async () => {
    const res = await request(wrapped).get('/api/paper/portfolio');
    // 状态码不该被中间件改动
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('initialCapital');
    expect(res.body[CONTRACT_VIOLATION_FIELD]).toBeUndefined();
  });

  it('SSE / 非 JSON 端点不被误伤', async () => {
    // /api/metrics 是 text/plain，不该进 JSON 校验
    const res = await request(wrapped).get('/api/metrics');
    expect(res.status).toBe(200);
  });

  it('错误响应不被校验（4xx/5xx 形状各端点差异大，已有专门断言）', async () => {
    // 非法股票代码 → 400
    const res = await request(wrapped).post('/api/paper/order').send({});
    expect(res.status).toBe(400);
  });
});

describe('契约 supertest — 反向验证：形状不符必须失败', () => {
  // 用一个「契约说 codes 是 string[]、但实际返回 number[]」的假 app 来验证。
  // 不改生产代码 —— 用一个临时的 express app 复用中间件逻辑。
  const express = async (): Promise<import('express').Express> => {
    const mod = await import('express');
    const e = mod.default();
    // 契约里 /api/watchlist 的 codes 是 string[]；这里故意回 number[]
    e.get('/api/watchlist', (_req, res) => {
      res.json({ codes: [123] });
    });
    return e;
  };

  it('响应与契约不符时，中间件把状态码改成 500 并注入违规详情', async () => {
    const e = await express();
    const res = await request(withContract(e)).get('/api/watchlist');
    expect(res.status).toBe(500);
    expect(res.body[CONTRACT_VIOLATION_FIELD]).toBeDefined();
    expect(res.body[CONTRACT_VIOLATION_FIELD][0]).toMatch(/期望 string/);
  });

  it('响应符合契约时不动状态码', async () => {
    const mod = await import('express');
    const e = mod.default();
    e.get('/api/watchlist', (_req, res) => {
      res.json({ codes: ['600519'] });
    });
    const res = await request(withContract(e)).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(res.body.codes).toEqual(['600519']);
    expect(res.body[CONTRACT_VIOLATION_FIELD]).toBeUndefined();
  });
});

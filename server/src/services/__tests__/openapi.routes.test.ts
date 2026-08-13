import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../index.js';
import { buildOpenApiDocument, OPENAPI_VERSION } from '../openapi.js';

/**
 * OpenAPI 契约结构性校验：
 *  - 版本/标题/paths 基础结构；
 *  - 每个 operation 至少一个响应、每个响应有 description；
 *  - 路径参数与 parameters 声明一致（{code} 必须在 path 里声明）；
 *  - README 表格中列出的核心端点全部有契约。
 */
describe('openapi — 文档结构', () => {
  const doc = buildOpenApiDocument();

  it('openapi 版本与 info 完整', () => {
    expect(doc.openapi).toBe(OPENAPI_VERSION);
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
  });

  it('每个 operation 至少有一个响应且含 description', () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(
        item as Record<string, { responses?: Record<string, { description?: string }> }>,
      )) {
        if (method === 'parameters') continue;
        expect(op.responses, `${method.toUpperCase()} ${path} 缺少 responses`).toBeTruthy();
        expect(
          Object.keys(op.responses!).length,
          `${method.toUpperCase()} ${path} responses 为空`,
        ).toBeGreaterThan(0);
        for (const [code, resp] of Object.entries(op.responses!)) {
          expect(
            resp.description,
            `${method.toUpperCase()} ${path} ${code} 缺少 description`,
          ).toBeTruthy();
        }
      }
    }
  });

  it('路径模板参数都在 parameters 中声明', () => {
    const tplRe = /\{([a-zA-Z0-9_]+)\}/g;
    for (const [path, item] of Object.entries(doc.paths)) {
      const tplNames = [...path.matchAll(tplRe)].map((m) => m[1]);
      if (tplNames.length === 0) continue;
      for (const [method, op] of Object.entries(
        item as Record<string, { parameters?: { name: string; in: string }[] }>,
      )) {
        if (method === 'parameters') continue;
        const declared = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
        for (const name of tplNames) {
          expect(declared, `${method.toUpperCase()} ${path} 路径参数 {${name}} 未声明`).toContain(
            name,
          );
        }
      }
    }
  });

  it('覆盖 README API 概览中的核心端点', () => {
    const core = [
      '/api/analyze',
      '/api/analyze/stream',
      '/api/compare',
      '/api/stocks',
      '/api/stocks/search',
      '/api/quant/analyze',
      '/api/backtest/evaluate',
      '/api/paper/portfolio',
      '/api/paper/order',
      '/api/paper/settle',
      '/api/paper/stats',
      '/api/audit',
      '/api/intl/fundamentals',
      '/api/chat',
      '/api/chat/stream',
      '/api/watchlist',
      '/api/watchlist/news-backtest',
      '/api/ingest',
      '/api/documents',
      '/api/models',
      '/api/cost',
      '/api/health',
      '/api/autonomous/start',
    ];
    const paths = doc.paths as Record<string, unknown>;
    for (const p of core) {
      expect(paths[p], `缺少端点契约: ${p}`).toBeTruthy();
    }
  });
});

describe('GET /api/openapi.json 路由', () => {
  it('返回 200 且为合法 OpenAPI 文档', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe(OPENAPI_VERSION); // 引常量而非硬编码 '3.1.0'
    expect(res.body.paths['/api/analyze']).toBeTruthy();
  });
});

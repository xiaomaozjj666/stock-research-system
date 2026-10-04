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

/**
 * 契约与实际路由**双向**一致（防漂移）。
 *
 * 为什么要这条：此前本文件只校验一份**硬编码的核心端点清单**，而规范本身也只覆盖
 * README 表格里那 24 条。实际上 app 挂了 64 个路由条目，规范只写了 37 个 ——
 * 缺口不会让任何测试变红，于是「规范是唯一权威来源」这句话长期与事实不符。
 * 靠人肉维护清单必然继续漏，因此改成**从 app 实际路由表反推**：
 * 任何新增路由而没写契约，测试立刻失败并报出是哪条。
 *
 * 双向都查：路由有而规范缺（漏写，如上）/ 规范有而路由不存在（写错或已删）。
 */
describe('openapi — 与实际挂载路由一致', () => {
  const doc = buildOpenApiDocument();

  /** 收集 express app 上所有路由（展开 router 嵌套），返回 "METHOD /path" */
  function collectRoutes(stack: unknown[], prefix = ''): string[] {
    const out: string[] = [];
    for (const layer of stack as {
      route?: { path: string; methods: Record<string, boolean> };
      name?: string;
      handle?: { stack?: unknown[] };
      regexp?: { source: string };
    }[]) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          if (m !== '_all') out.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // express 把挂载路径编码进 layer.regexp（如 /^\/api\/?(?=\/|$)/i）
        const seg = /^\^\\\/((?:[\w\-.~%]|\\.)*)/.exec(layer.regexp?.source ?? '');
        out.push(
          ...collectRoutes(
            layer.handle.stack,
            prefix + (seg ? '/' + seg[1].replace(/\\\//g, '/') : ''),
          ),
        );
      }
    }
    return out;
  }

  /** 路径归一：express 的 :code → OpenAPI 的 {code}；去掉尾斜杠 */
  const norm = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+$/, '') || '/';

  // Express 5 内部字段名与 4 不同（router / _router），两处都兜住
  const appAny = app as unknown as {
    router?: { stack: unknown[] };
    _router?: { stack: unknown[] };
  };
  const actual = collectRoutes(appAny.router?.stack ?? appAny._router?.stack ?? []);
  const specPaths = new Set(Object.keys(doc.paths as Record<string, unknown>).map(norm));

  it('实际路由数不为 0（枚举逻辑本身失效时要能被发现）', () => {
    expect(actual.length).toBeGreaterThan(0);
  });

  it('每条已挂载路由都有契约（新增路由漏写契约时这里失败）', () => {
    const missing = actual
      .filter((r) => !specPaths.has(norm(r.split(' ')[1])))
      .map((r) => `${r}  →  需在 services/openapi.ts 补 paths["${norm(r.split(' ')[1])}"]`);
    expect(missing, `以下路由缺少 OpenAPI 契约：\n${missing.join('\n')}`).toEqual([]);
  });

  it('契约里没有不存在的路由（写错或路由已删时这里失败）', () => {
    // :param 形式在契约侧已归一为 {param}，故按归一后的路径比对
    const actualNorm = new Set(actual.map((r) => norm(r.split(' ')[1])));
    const orphan = [...specPaths].filter((p) => !actualNorm.has(p));
    expect(orphan, `以下契约对应的路由不存在：\n${orphan.join('\n')}`).toEqual([]);
  });

  it('每个契约 path 至少声明一种方法（空 path 等价于没写）', () => {
    for (const [p, ops] of Object.entries(doc.paths as Record<string, unknown>)) {
      expect(Object.keys(ops as object).length, `契约 ${p} 没有任何 operation`).toBeGreaterThan(0);
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

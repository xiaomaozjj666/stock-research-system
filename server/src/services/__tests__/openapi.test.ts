import { describe, it, expect } from 'vitest';
import { buildOpenApiDocument } from '../openapi.js';

/**
 * /api/audit 分页契约（文档侧）
 * ----------------------------------------------------------------------------
 * routes/audit.ts 早已支持 limit/offset（两者都不传时保持旧的全量行为），
 * 但文档里一直没写，消费方（Swagger UI / 代码生成）无从发现分页能力；
 * `count` 是「匹配总数」而不是本页条数，也需要在契约里说清，否则前端容易
 * 把 count 当成当前页条数、把「共 N 条」显示成本页条数。
 * 这里直接调 buildOpenApiDocument()，不经过 HTTP。
 */

interface Param {
  name: string;
  in: string;
  schema?: { type?: string; minimum?: number; description?: string };
  description?: string;
}

interface Operation {
  parameters?: Param[];
  responses?: Record<string, { description?: string }>;
}

function auditGet(): Operation {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, { get?: Operation }>;
  const op = paths['/api/audit']?.get;
  expect(op, '/api/audit 缺少 GET 契约').toBeTruthy();
  return op as Operation;
}

function param(op: Operation, name: string): Param {
  const found = (op.parameters ?? []).find((p) => p.name === name);
  expect(found, `/api/audit 契约缺少参数 ${name}`).toBeTruthy();
  return found as Param;
}

describe('openapi — /api/audit 文档补 limit/offset', () => {
  it('limit 是 query 上的 integer 且最小值为 0', () => {
    const limit = param(auditGet(), 'limit');

    expect(limit.in).toBe('query');
    expect(limit.schema?.type).toBe('integer');
    expect(limit.schema?.minimum).toBe(0);
  });

  it('offset 是 query 上的 integer 且最小值为 0', () => {
    const offset = param(auditGet(), 'offset');

    expect(offset.in).toBe('query');
    expect(offset.schema?.type).toBe('integer');
    expect(offset.schema?.minimum).toBe(0);
  });

  it('两个参数的说明都写明「不传则返回全部/从第一条开始」的旧行为', () => {
    const op = auditGet();
    const limit = param(op, 'limit');
    const offset = param(op, 'offset');

    expect(limit.description).toMatch(/不传/);
    expect(limit.description).toMatch(/全部/);
    expect(offset.description).toMatch(/不传/);
    expect(offset.description).toMatch(/全部|第一条/);
  });

  it('limit/offset 均不传即全量，因此都不标 default、都不 required', () => {
    const op = auditGet();
    for (const name of ['limit', 'offset']) {
      const p = param(op, name);

      expect(p, `${name} 不该标 default（不传 ≠ 某个默认页大小）`).not.toHaveProperty('default');
      expect((p as { required?: boolean }).required).toBeUndefined();
    }
  });

  it('原有的过滤参数没有被分页参数挤掉', () => {
    const names = (auditGet().parameters ?? []).map((p) => p.name);

    expect(names).toEqual(
      expect.arrayContaining(['category', 'riskLevel', 'startTime', 'endTime', 'sessionId']),
    );
  });

  it('200 响应说明点明 count 是匹配总数、entries 是本页条目', () => {
    const desc = auditGet().responses?.['200']?.description ?? '';

    expect(desc).toContain('count');
    expect(desc).toContain('匹配总数');
    expect(desc).toContain('entries');
  });

  it('补齐了 400 非法参数响应（limit/offset 非法时路由确实返回 400）', () => {
    const resp = auditGet().responses?.['400'];

    expect(resp?.description).toBeTruthy();
    expect(resp?.description).toMatch(/limit|offset/);
  });
});

import { describe, it, expect } from 'vitest';
import { buildOpenApiDocument } from '../../services/openapi.js';
import {
  validateAgainstSchema,
  validateResponse,
  okSchemaOf,
  unsupportedKeywords,
  type ContractDoc,
} from '../contractSchema.js';

/**
 * 契约校验器自身的门禁
 * ============================================================================
 * 这个文件有两个职责，缺一不可：
 *
 * 1. **校验器正确性**：它被两处复用（真实进程冒烟 + 路由测试），一旦判据写错
 *    两处会一起给出错误的绿灯。所以校验器本身必须有反向验证的用例。
 * 2. **校验强度不退化**：本校验器只支持契约里实际用到的关键字。若日后有人在
 *    契约里加了本校验器不认识的构造，它会「静默不报错」—— 契约与响应的一致性
 *    就出现了盲区。故 `unsupportedKeywords` 必须为空，否则要显式扩展校验器。
 *
 * 这两条都属于「守卫不能是假绿」的同类要求。
 */

const doc = buildOpenApiDocument() as unknown as ContractDoc;
const schemas = doc.components?.schemas ?? {};

describe('契约校验器 — 基本判据', () => {
  it('标量类型', () => {
    expect(validateAgainstSchema({ type: 'string' }, 'x', schemas)).toEqual([]);
    expect(validateAgainstSchema({ type: 'string' }, 1, schemas)[0]).toMatch(/期望 string/);
    expect(validateAgainstSchema({ type: 'number' }, 1, schemas)).toEqual([]);
    expect(validateAgainstSchema({ type: 'integer' }, 1.5, schemas)).toEqual([]); // integer 不查小数
    expect(validateAgainstSchema({ type: 'boolean' }, false, schemas)).toEqual([]);
  });

  it('必填字段缺失会报错，并指名字段', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(validateAgainstSchema(schema, { a: 'x' }, schemas)).toEqual([]);
    expect(validateAgainstSchema(schema, {}, schemas)[0]).toMatch(/\$\.a: 必填字段缺失/);
  });

  it('非 required 的字段缺失不算错', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(validateAgainstSchema(schema, {}, schemas)).toEqual([]);
  });

  it('数组与元素类型', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    expect(validateAgainstSchema(schema, ['a', 'b'], schemas)).toEqual([]);
    expect(validateAgainstSchema(schema, [1], schemas)[0]).toMatch(/\$\[0\]: 期望 string/);
    expect(validateAgainstSchema(schema, 'notarray', schemas)[0]).toMatch(/期望 array/);
  });

  it('$ref 能解析到 components.schemas', () => {
    expect(
      validateAgainstSchema(
        { $ref: '#/components/schemas/ErrorResponse' },
        { error: 'x' },
        schemas,
      ),
    ).toEqual([]);
    // 悬空 $ref 必须报错，不能静默放行
    expect(validateAgainstSchema({ $ref: '#/components/schemas/Nope' }, {}, schemas)[0]).toMatch(
      /悬空/,
    );
  });

  it('enum 不匹配会报错', () => {
    expect(validateAgainstSchema({ type: 'string', enum: ['a', 'b'] }, 'a', schemas)).toEqual([]);
    expect(validateAgainstSchema({ type: 'string', enum: ['a', 'b'] }, 'c', schemas)[0]).toMatch(
      /不在 enum/,
    );
  });

  it('可空：3.1 的 type 数组与 3.0 的 nullable 都认', () => {
    expect(validateAgainstSchema({ type: ['string', 'null'] }, null, schemas)).toEqual([]);
    expect(validateAgainstSchema({ type: 'string', nullable: true }, null, schemas)).toEqual([]);
    // 不可空的遇到 null 必须报错
    expect(validateAgainstSchema({ type: 'string' }, null, schemas)[0]).toMatch(/期望非 null/);
  });

  it('oneOf：任一分支通过即可', () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateAgainstSchema(schema, 'a', schemas)).toEqual([]);
    expect(validateAgainstSchema(schema, 1, schemas)).toEqual([]);
    expect(validateAgainstSchema(schema, true, schemas)[0]).toMatch(/oneOf 全不匹配/);
  });

  it('空 schema / undefined 一律放行（无约束即无话可说）', () => {
    expect(validateAgainstSchema({}, { anything: 1 }, schemas)).toEqual([]);
    expect(validateAgainstSchema(undefined, { anything: 1 }, schemas)).toEqual([]);
  });
});

describe('契约校验器 — 反向验证（证明它会红）', () => {
  it('每条判据都有一个「应当变红」的对照', () => {
    // 形状不符 → 报错。若这些都通过，说明校验器根本没在工作，
    // 那所有「通过」都是假绿（这正是本项目反复踩的坑）。
    const cases: [unknown, unknown][] = [
      [{ type: 'string' }, 42],
      [{ type: 'object', required: ['a'] }, {}],
      [{ type: 'array', items: { type: 'number' } }, ['x']],
      [{ type: 'string', enum: ['a'] }, 'z'],
      [{ type: 'string' }, null],
    ];
    for (const [schema, value] of cases) {
      expect(
        validateAgainstSchema(schema, value, schemas).length,
        `${JSON.stringify(schema)} 对 ${JSON.stringify(value)} 应当报错`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('契约校验强度不退化', () => {
  it('契约里没有本校验器不认识的 schema 关键字', () => {
    // 若这里红了：有人在契约里用了本校验器无法校验的构造，
    // 于是「契约 ↔ 响应」的一致性出现盲区，而校验器会**静默放行**。
    // 正确反应：扩展 server/src/test/contractSchema.ts 支持该关键字，
    // 而不是把这条测试删掉或放宽。
    // 只扫 **schema 节点**：整个文档还包含 paths / 属性名（'stock_code' 等），
    // 那些不是 schema 关键字，扫进去会产出几百个无意义的「未支持」。
    const found = new Set<string>();
    for (const s2 of Object.values(schemas)) unsupportedKeywords(s2, found);
    for (const item of Object.values(doc.paths)) {
      for (const op of Object.values(item)) {
        for (const code of ['200', '201', '400', '404', '409', '422', '429', '500', '502', '503']) {
          const resp = op.responses?.[code];
          if (resp?.content?.['application/json']?.schema) {
            unsupportedKeywords(resp.content['application/json'].schema, found);
          }
        }
        const rb = op.requestBody as
          { content?: Record<string, { schema?: unknown } | undefined> } | undefined;
        const bodySchema = rb?.content?.['application/json']?.schema;
        if (bodySchema) unsupportedKeywords(bodySchema, found);
      }
    }
    expect(
      [...found],
      `契约出现未支持的关键字：${[...found].join(', ')}。` +
        '本校验器会静默跳过它们 → 一致性校验出现盲区。请扩展 contractSchema.ts。',
    ).toEqual([]);
  });
});

describe('契约本身的覆盖度（复用同一份 schema 查找）', () => {
  it('okSchemaOf 能取到主要端点的 2xx schema', () => {
    const probes: [string, string][] = [
      ['/api/analyze', 'post'],
      ['/api/compare', 'post'],
      ['/api/paper/portfolio', 'get'],
      ['/api/watchlist', 'get'],
      ['/api/quant/factor/evaluate', 'post'],
      ['/api/history/{id}', 'delete'],
    ];
    for (const [p, m] of probes) {
      expect(okSchemaOf(doc, p, m), `${m.toUpperCase()} ${p} 应有 2xx schema`).toBeTruthy();
    }
  });

  it('validateResponse 是端到端便捷入口', () => {
    // 用一个真实端点的契约去校验「形状正确」与「形状错误」两种响应
    expect(validateResponse(doc, '/api/watchlist', 'get', { codes: ['600519'] })).toEqual([]);
    const bad = validateResponse(doc, '/api/watchlist', 'get', { codes: [123] });
    expect(bad[0]).toMatch(/期望 string/);
  });

  it('JSON 类端点全部有 2xx schema（SSE / text 类除外）', () => {
    let ops = 0;
    let withSchema = 0;
    const missing: string[] = [];
    // 这三个端点**正确地**没有 application/json schema：
    // 两个 SSE 回 text/event-stream，/api/metrics 回 Prometheus 文本。
    // 它们的响应体由事件结构（components.schemas 里的 *StreamEvent）描述。
    const NON_JSON = new Set(['/api/analyze/stream', '/api/chat/stream', '/api/metrics']);
    for (const [path, item] of Object.entries(doc.paths)) {
      // 只用到 method（判断是否存在 2xx schema），不需要 operation 本身
      for (const method of Object.keys(item)) {
        if (method === 'parameters') continue;
        ops++;
        if (okSchemaOf(doc, path, method)) withSchema++;
        else if (!NON_JSON.has(path)) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing, `这些 operation 没有 2xx JSON schema：\n${missing.join('\n')}`).toEqual([]);
    expect(withSchema).toBe(ops - NON_JSON.size);
  });
});

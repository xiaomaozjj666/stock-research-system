import { describe, it, expect } from 'vitest';
import { buildOpenApiDocument } from '../../services/openapi.js';

/**
 * 请求体契约的守门测试
 * ============================================================================
 * 为什么单独守**请求体**：契约校验（`contractSupertest.ts` 与契约冒烟）跑的全是
 * **响应方向** —— 「服务实际返回的字段」与「契约声明的字段」对齐。
 * 请求方向（「调用方能传什么」）此前**没有任何断言**，于是：
 *   - 新增端点时写 `requestBody: jsonBody({ type: 'object' })` 也不会有人发现
 *     —— 实测 26 个请求体里曾有 1 个完全无 properties（timeseries/analyze），已补；
 *   - 字段名写错、必填漏标，同样无人能发现。
 *
 * 判据是**下限**而非「必须写满」：契约的职责是「HTTP 层能收什么形状」，
 * 业务必填由服务层校验文案承担（如 timeseries 的 test/code 缺省为空串、
 * 由 analyzeTimeseries 回 400）。所以这里只要求「顶层有 properties」，
 * 不强制 required —— 强制了反而会让契约与「优雅降级」的实现口径冲突。
 */

type Body = {
  required?: unknown;
  content?: Record<string, { schema?: { type?: string; properties?: Record<string, unknown> } }>;
};
type Op = { requestBody?: Body; responses?: Record<string, unknown> };

const doc = buildOpenApiDocument() as unknown as {
  paths: Record<string, Record<string, Op>>;
};

const ops: { key: string; schema: NonNullable<NonNullable<Body['content']>[string]['schema']> }[] =
  [];
for (const [path, item] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (method === 'parameters') continue;
    const schema = op.requestBody?.content?.['application/json']?.schema;
    if (schema) ops.push({ key: `${method.toUpperCase()} ${path}`, schema });
  }
}

describe('请求体契约的完整度下限', () => {
  it('每个 POST/PUT 请求体都声明了顶层 properties（不接受空壳 object）', () => {
    const empty = ops.filter((o) => Object.keys(o.schema.properties ?? {}).length === 0);
    expect(
      empty.map((o) => o.key),
      '这些请求体只写了 `type: object` 而没有任何 properties —— 契约对调用方零信息量。\n' +
        '请按真实入参补齐字段（不知道该传什么就去看 handler 怎么读 body）。',
    ).toEqual([]);
  });

  it('properties 里的字段都有类型声明（避免再次出现 items: { type: object } 这类空壳）', () => {
    // 数组元素允许 additionalProperties: true（options 这类自由形状确实需要），
    // 但顶层字段必须给出 type，否则生成的 TS 类型退化成 unknown。
    const bad: string[] = [];
    for (const { key, schema } of ops) {
      for (const [name, raw] of Object.entries(schema.properties ?? {})) {
        const p = raw as { type?: string; enum?: unknown[]; oneOf?: unknown; $ref?: string };
        const hasShape =
          p?.type !== undefined ||
          p?.$ref !== undefined ||
          p?.enum !== undefined ||
          p?.oneOf !== undefined;
        if (!hasShape) bad.push(`${key}.${name}`);
      }
    }
    expect(
      bad,
      '这些请求体字段没有 type / $ref / enum / oneOf，生成出来是 unknown：\n' + bad.join('\n'),
    ).toEqual([]);
  });

  it('请求体的 content-type 统一是 application/json', () => {
    // 真正要守的是「每个 requestBody 只声明 application/json 一种 content-type」：
    // 混入 multipart/form-data 或 text/plain 会让生成器取不到 schema（它只读
    // application/json），表现为「该端点没有生成 RequestBody 类型」这种间接症状，
    // 排查时很难联想到是 content-type 的问题。
    const multi: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method === 'parameters') continue;
        const content = op.requestBody?.content;
        if (!content) continue;
        const types = Object.keys(content);
        if (types.length > 1 || (types[0] && types[0] !== 'application/json')) {
          multi.push(`${method.toUpperCase()} ${path} → ${types.join(', ')}`);
        }
      }
    }
    expect(
      multi,
      '这些请求体声明了非 application/json 的 content-type，生成器取不到 schema：\n' +
        multi.join('\n'),
    ).toEqual([]);
  });
});

describe('请求体契约与实现的一致性抽查', () => {
  /**
   * 这些断言是「契约里写了什么」与「handler 实际读什么」的对照。
   * 挑的是字段最容易漂移的几个（枚举、必填、可选性），全量对照需要
   * 逐个 handler 解析，超出本守卫职责。
   */
  it('audit 的 category/riskLevel 枚举与实现一致（上轮刚改过 400 行为）', () => {
    const params = doc.paths['/api/audit']?.get?.responses as
      Record<string, { description?: string }> | undefined;
    const desc400 = params?.['400']?.description ?? '';
    // 契约必须写明「枚举非法也 400」，否则调用方按旧契约传错值会得到 200 + 空结果
    expect(desc400).toMatch(/category/);
    expect(desc400).toMatch(/riskLevel/);
  });

  it('llm/ensemble 的 task 声明为枚举而非任意 string', () => {
    const body = doc.paths['/api/llm/ensemble']?.post?.requestBody?.content?.['application/json']
      ?.schema as { properties?: Record<string, { enum?: string[] }> };
    // 实现只接受 LLM_TASKS 的 6 个值，契约不能写 type: string 放行任意值
    expect(body?.properties?.task?.enum).toEqual([
      'chat',
      'analysis',
      'debate',
      'extract',
      'reasoning',
      'embedding',
    ]);
  });

  it('quant/factor/* 的 horizons 复用共用 schema（避免 5 处各写一遍又写错）', () => {
    // 上一轮修过这个 bug：5 处内联其中 3 处写成了 string[]
    const paths = [
      '/api/quant/factor/cross-section',
      '/api/quant/factor/expression',
      '/api/quant/factor/expression/batch',
      '/api/quant/factor/composite',
      '/api/quant/factor/composite/batch',
    ];
    for (const p of paths) {
      const body = doc.paths[p]?.post?.requestBody?.content?.['application/json']?.schema as
        { properties?: Record<string, { items?: { type?: string } }> } | undefined;
      expect(body?.properties?.horizons?.items?.type, `${p} 的 horizons 元素类型应为 integer`).toBe(
        'integer',
      );
    }
  });
});

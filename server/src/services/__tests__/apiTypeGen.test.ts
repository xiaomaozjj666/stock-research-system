import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import prettier from 'prettier';
import { buildOpenApiDocument } from '../openapi.js';
import {
  generateTypesModule,
  operationTypeName,
  schemaToType,
  type OpenApiDocumentLike,
  type SchemaLike,
} from '../apiTypeGen.js';

/**
 * 契约 → 前端类型的防漂移守卫
 * ============================================================================
 * 背景：本项目此前有两份互不校验的「API 形状」——契约（openapi.ts）与前端手写
 * 类型（client/src/types.ts 等）。它们必然分叉，且没有任何测试能发现。
 *
 * 这一轮把方向反过来：**契约是唯一权威来源，类型由它生成**。但只要生成物是
 * 「提交进仓库的静态文件」，漂移就会以两种形式回来：
 *   1. 改了契约忘了重新生成 → 生成物过期（`--check` 拦）
 *   2. 改契约时顺手把响应 schema 删了 → 覆盖率悄悄退回「只有 description」
 *      （本文件拦）
 *
 * 守卫必须**先证伪**：永远通过的守卫比没有守卫更危险，因为它给虚假安全感。
 * 文件末尾有对两条守卫的反向验证用例。
 */

const doc = buildOpenApiDocument() as unknown as OpenApiDocumentLike;
const generatedPath = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'client',
  'src',
  'api',
  'generated.ts',
);

type Op = {
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { content?: Record<string, unknown>; description?: string }>;
  parameters?: unknown;
};

describe('类型生成器 — 基本转换', () => {
  const emptyCtx = () => ({ refNames: new Map<string, string>(), declared: new Set<string>() });

  it('标量与数组', () => {
    expect(schemaToType({ type: 'string' }, emptyCtx())).toBe('string');
    expect(schemaToType({ type: 'integer' }, emptyCtx())).toBe('number');
    expect(schemaToType({ type: 'boolean' }, emptyCtx())).toBe('boolean');
    expect(schemaToType({ type: 'array', items: { type: 'number' } }, emptyCtx())).toBe('number[]');
  });

  it('必填与可选：未进 required 的属性带 ?', () => {
    const t = schemaToType(
      {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a'],
      },
      emptyCtx(),
    );
    expect(t).toContain('a: string;');
    expect(t).toContain('b?: number;');
  });

  it('enum 生成为字面量联合', () => {
    // 注意：schemaToType 是**格式化前**的原始输出，故此处是双引号；
    // 单引号统一由落盘前的 prettier 负责（见「生成物与当前契约一致」那条）。
    expect(schemaToType({ type: 'string', enum: ['a', 'b'] }, emptyCtx())).toBe('"a" | "b"');
  });

  it('可空：3.1 的 type 数组与 3.0 的 nullable 都支持', () => {
    expect(schemaToType({ type: ['string', 'null'] }, emptyCtx())).toBe('string | null');
    expect(schemaToType({ type: 'string', nullable: true }, emptyCtx())).toBe('string | null');
  });

  it('纯字典 additionalProperties → Record', () => {
    expect(
      schemaToType({ type: 'object', additionalProperties: { type: 'number' } }, emptyCtx()),
    ).toBe('Record<string, number>');
  });

  it('$ref 解析为组件名', () => {
    const ctx = emptyCtx();
    ctx.refNames.set('Foo', 'Foo');
    expect(schemaToType({ $ref: '#/components/schemas/Foo' }, ctx)).toBe('Foo');
  });

  it('$ref 指向未声明组件时抛错（不静默退化成 unknown）', () => {
    const ctx = emptyCtx();
    expect(() => schemaToType({ $ref: '#/components/schemas/Missing' }, ctx)).toThrow(
      /未声明的组件/,
    );
  });

  it('未知 type 关键字抛错', () => {
    expect(() => schemaToType({ type: 'wat' } as unknown as SchemaLike, emptyCtx())).toThrow(
      /未知的 schema type/,
    );
  });

  it('保留字与非标识符键名加引号', () => {
    const t = schemaToType(
      {
        type: 'object',
        properties: { class: { type: 'string' }, 'a-b': { type: 'number' } },
        required: ['class', 'a-b'],
      },
      emptyCtx(),
    );
    expect(t).toContain("'class': string;");
    expect(t).toContain("'a-b': number;");
  });

  it('description 与约束进入 JSDoc', () => {
    const t = schemaToType(
      {
        type: 'object',
        properties: { code: { type: 'string', pattern: '^\\d{6}$', description: '股票代码' } },
        required: ['code'],
      },
      emptyCtx(),
    );
    expect(t).toContain('股票代码');
    expect(t).toContain('\\d{6}');
  });

  it('operationTypeName 生成合法且可读的标识符', () => {
    expect(operationTypeName('/api/analyze', 'post')).toBe('POSTApiAnalyze');
    expect(operationTypeName('/api/quant/factor/composite/batch', 'get')).toBe(
      'GETApiQuantFactorCompositeBatch',
    );
    // 路径模板参数的花括号必须被去掉，否则不是合法标识符
    expect(operationTypeName('/api/watchlist/{code}', 'delete')).toBe('DELETEApiWatchlistCode');
  });

  it('同一份契约生成结果稳定（确定性：不因对象键序变化而抖动）', () => {
    const a = generateTypesModule(doc);
    const b = generateTypesModule(doc);
    expect(a).toBe(b);
  });

  it('契约里 paths 的键顺序变化不影响生成物', () => {
    const shuffled: OpenApiDocumentLike = { ...doc, paths: {} };
    for (const k of Object.keys(doc.paths).reverse()) shuffled.paths[k] = doc.paths[k];
    expect(generateTypesModule(shuffled)).toBe(generateTypesModule(doc));
  });
});

describe('契约 → 生成物：覆盖与一致性', () => {
  it('每个 operation 的 2xx 响应都带 schema（防止退回「只有 description」）', () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item as unknown as Record<string, Op>)) {
        if (method === 'parameters') continue;
        const codes = Object.keys(op.responses ?? {});
        const success = codes.find((c) => /^2\d\d$/.test(c));
        if (!success) {
          missing.push(`${method.toUpperCase()} ${path}：没有 2xx 响应`);
          continue;
        }
        const content = op.responses![success].content;
        if (!content || Object.keys(content).length === 0) {
          missing.push(`${method.toUpperCase()} ${path}：2xx 响应缺 content/schema`);
        }
      }
    }
    expect(
      missing,
      `以下 operation 的成功响应没有 schema：\n${missing.join('\n')}\n` +
        '请在 services/openapi.ts 补 content.application/json.schema（优先 $ref components.schemas 里的具名组件）。',
    ).toEqual([]);
  });

  it('契约里的 $ref 全部指向已声明的组件（悬空 $ref 会让生成器硬失败）', () => {
    const declared = new Set(Object.keys(doc.components?.schemas ?? {}));
    expect(declared.size, 'components.schemas 为空：$ref 将全部悬空').toBeGreaterThan(0);
    const dangling: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${where}[${i}]`));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string') {
          const m = /^#\/components\/schemas\/(.+)$/.exec(v);
          if (!m) dangling.push(`${where}: 不支持的 $ref ${v}`);
          else if (!declared.has(m[1])) dangling.push(`${where}: $ref 指向未声明组件 ${m[1]}`);
        } else {
          walk(v, `${where}.${k}`);
        }
      }
    };
    walk(doc, 'doc');
    expect(dangling, `悬空 $ref：\n${dangling.join('\n')}`).toEqual([]);
  });

  it('生成物与当前契约一致（改了契约必须重新生成）', async () => {
    const expectedRaw = generateTypesModule(doc);
    let actual = '';
    try {
      actual = readFileSync(generatedPath, 'utf8');
    } catch {
      throw new Error(`生成物不存在：${generatedPath}\n请运行：npm run generate:api-types`);
    }
    // 落盘前 CLI 会过一遍 prettier（引号统一成单引号、行宽重排），所以这里
    // 必须拿 **同样格式化之后** 的结果比对，否则会因纯排版差异误报——
    // 守卫一旦习惯性误报，人就会开始无视它，那比没有守卫更糟。
    // prettier v3 的 format 是 async，必须 await（漏了会拿到 Promise 而非字符串）。
    const expected = await prettier.format(expectedRaw, {
      parser: 'typescript',
      singleQuote: true,
      printWidth: 100,
    });
    if (actual !== expected) {
      const a = actual.split('\n');
      const b = expected.split('\n');
      const i = a.findIndex((line, idx) => line !== b[idx]);
      throw new Error(
        '生成物与契约不一致（契约已改，类型没重新生成）。请运行：npm run generate:api-types。\n' +
          `首个差异在第 ${i + 1} 行：\n` +
          `  现有：${a[i] ?? '<EOF>'}\n` +
          `  应为：${b[i] ?? '<EOF>'}`,
      );
    }
  });

  it('生成物里没有退化成 unknown 的成功响应', () => {
    const source = readFileSync(generatedPath, 'utf8');
    const bad = [...source.matchAll(/export type (\w+Response) = unknown;/g)].map((m) => m[1]);
    expect(
      bad,
      `以下响应类型退化为 unknown：${bad.join(', ')}\n` +
        '说明对应 operation 的成功响应没有可用 schema，契约等于没写。',
    ).toEqual([]);
  });
});

/**
 * 守卫的反向验证。
 *
 * 为什么必须做：一条永远绿的守卫不提供任何保证。这里对每条关键守卫构造
 * 「应当变红」的输入并断言它确实报错——只有这样，绿灯才有意义。
 */
describe('守卫自身的反向验证（证明它们真的会红）', () => {
  const emptyCtx = () => ({ refNames: new Map<string, string>(), declared: new Set<string>() });

  it('删掉一个组件后，引用它的 $ref 立刻变红', () => {
    const broken = JSON.parse(JSON.stringify(doc)) as OpenApiDocumentLike;
    delete broken.components!.schemas!.PaperPortfolio;
    expect(() => generateTypesModule(broken)).toThrow(/未声明的组件/);
  });

  it('把某个成功响应的 schema 删掉后，生成器立刻变红（而非静默跳过该端点）', () => {
    const broken = JSON.parse(JSON.stringify(doc)) as OpenApiDocumentLike;
    const item = broken.paths['/api/paper/portfolio'];
    delete item!.get!.responses!['200']!.content;
    expect(() => generateTypesModule(broken)).toThrow(/没有 content schema/);
  });

  it('把成功响应换成空 schema（生成 unknown）时也立刻变红', () => {
    const broken = JSON.parse(JSON.stringify(doc)) as OpenApiDocumentLike;
    const item = broken.paths['/api/paper/portfolio'];
    item!.get!.responses!['200']!.content = { 'application/json': { schema: {} } };
    expect(() => generateTypesModule(broken)).toThrow(/unknown/);
  });

  it('给契约引入生成器不认识的构造时，硬失败而非静默降级', () => {
    expect(() => schemaToType({ type: 'function' } as unknown as SchemaLike, emptyCtx())).toThrow();
  });
});

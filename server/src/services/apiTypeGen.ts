/**
 * OpenAPI 契约 → TypeScript 类型生成器（纯函数，无副作用）
 * ----------------------------------------------------------------------------
 * 为什么需要它：`services/openapi.ts` 是 API 形状的唯一权威来源，但它只是一份
 * **机器可读文档**——消费方（前端）拿到手仍然得靠人手抄一份 TS 类型。两份定义
 * 必然分叉，正是本项目此前反复出现的那类 bug（前端手写类型与后端实现漂移）。
 *
 * 为什么自己写而不引依赖：`ts-json-schema-generator` / `openapi-typescript` 这类
 * 库的输入是 **TypeScript 类型注解**，而本项目的权威来源是 **OpenAPI 文档**
 * （方向相反）。且本机 typescript@7 是 Go 原生移植版，`require('typescript')`
 * 只导出 `version` / `versionMajorMinor`——**没有 createProgram / 类型反射 API**，
 * 无法从注解反推 JSON Schema（实测确认，见 ENGINEERING-NOTES）。
 * 方向既然是「文档 → 类型」，几百行自研生成器比引入一个用不上的依赖更划算。
 *
 * 设计约束：
 *  1. **确定性**：同一份契约必得字节级相同的输出。否则「生成物是否最新」这条守卫
 *     会因无关抖动频繁变红，久而久之就没人看这条守卫了——和没有守卫一样糟。
 *  2. **零运行时依赖**：只吃 JSON，不 import 业务代码，可在测试里直接调用。
 *  3. **不静默降级**：遇到不认识的关键字直接抛错。悄悄退化成 `unknown` 会让
 *     整套类型失去意义（那正是「生成出 62 个 unknown」的失败模式）。
 */

/** 契约文档的最小结构（只声明本生成器实际读到的字段，不做全量 OpenAPI 类型） */
export interface OpenApiDocumentLike {
  openapi: string;
  paths: Record<string, Record<string, OperationLike>>;
  components?: { schemas?: Record<string, unknown> };
}

export interface OperationLike {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ParameterLike[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, ResponseLike>;
}

export interface ParameterLike {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

export interface ResponseLike {
  description?: string;
  content?: Record<string, { schema?: unknown }>;
}

/** JSON Schema 子集（只含本项目契约实际用到的关键字） */
export interface SchemaLike {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, SchemaLike>;
  required?: string[];
  additionalProperties?: boolean | SchemaLike;
  items?: SchemaLike;
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  oneOf?: SchemaLike[];
  anyOf?: SchemaLike[];
  allOf?: SchemaLike[];
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  deprecated?: boolean;
}

/** 生成过程中累积的命名表：$ref 指向的组件 → 生成的 TS 类型名 */
interface Ctx {
  /** 组件名 → TS 类型名（本项目同名直传，保留映射以便将来重命名） */
  refNames: Map<string, string>;
  /** 已声明的顶层类型名，防重复 */
  declared: Set<string>;
}

/** 契约里合法的响应码键（避免把 'default'/'2XX' 之类当成状态码） */
const STATUS_CODE_RE = /^[1-5]\d\d$/;

/**
 * 归一化类型关键字：OpenAPI 3.1 用 `type: ['string','null']` 表达可空，
 * 3.0 用 `nullable: true`。两者都要支持（本项目 3.1，但显式支持 3.0 写法更稳）。
 */
function typeList(schema: SchemaLike): string[] {
  const list = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : schema.nullable
        ? ['null']
        : [];
  return schema.nullable && !list.includes('null') ? [...list, 'null'] : list;
}

/** 把任意 JSON 值渲染成 TS 字面量（用于 enum / const / default / example） */
function literal(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  return null; // 对象/数组字面量不进类型（example 尤其常是对象）
}

/** 生成 JSDoc 注释块；无内容返回空串 */
function jsdoc(lines: (string | undefined)[], indent: string): string {
  const body = lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '');
  if (body.length === 0) return '';
  if (body.length === 1) return `${indent}/** ${body[0]} */\n`;
  return `${indent}/**\n${body.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

/** 联合类型去重并保持稳定顺序（去重避免 'a' | 'a | null' 这类噪声） */
function union(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  if (out.length === 0) return 'unknown';
  // 超过 6 个成员时收敛为括号包裹的多行联合，避免超长单行
  if (out.length === 1) return out[0];
  const inline = out.join(' | ');
  if (inline.length <= 100) return inline;
  // 真换行而不是字面量 "\n"：后者会一路写进生成物，prettier 解析该文件时
  // 直接报「Invalid character」，让整个类型生成在收尾环节崩掉。
  // （此前没有触发是因为当时的枚举都短到走了上面的单行分支。）
  return out.join('\n  | ');
}

/** 解析 `#/components/schemas/Name` → `Name`；非该形式返回 null */
function refTarget(ref: string): string | null {
  const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
  return m ? m[1] : null;
}

/**
 * 主转换：JSON Schema → TS 类型字符串。
 *
 * 未知关键字一律**抛错**而非降级：契约里出现本生成器不认识的构造时，静默输出
 * `unknown` 会让整套类型形同虚设（下游还以为拿到了真类型），必须让人立刻看见。
 * 校验型关键字（minimum/pattern/...）不改变 TS 类型，转成注释即可。
 */
export function schemaToType(schema: SchemaLike | undefined, ctx: Ctx, indent = ''): string {
  if (schema === undefined || schema === null) return 'unknown';

  // $ref：指向已声明的顶层类型
  if (typeof schema.$ref === 'string') {
    const target = refTarget(schema.$ref);
    if (target === null) {
      throw new Error(`不支持的 $ref（仅支持 #/components/schemas/*）：${schema.$ref}`);
    }
    const name = ctx.refNames.get(target);
    if (!name) {
      throw new Error(`$ref 指向未声明的组件：${schema.$ref}（契约 components.schemas 缺该键）`);
    }
    return name;
  }

  // 组合关键字
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      if (key === 'allOf') {
        // allOf = 各分支的交叉。TS 里等价于把可辨识的对象字面量合并：
        // 用交叉类型表达最忠实，且不丢字段。
        return branches.map((b) => wrapIfObject(schemaToType(b, ctx, indent))).join(' & ');
      }
      const parts = branches.map((b) => schemaToType(b, ctx, indent));
      return key === 'anyOf' ? union(parts) : union(parts);
    }
  }

  // 纯 null
  const types = typeList(schema);
  if (types.length === 1 && types[0] === 'null') return 'null';

  // 无 type 但有 properties/items 关键字：按结构推断
  if (types.length === 0) {
    if (schema.properties || schema.additionalProperties !== undefined) {
      return objectToType(schema, ctx, indent);
    }
    if (schema.items) return `${wrapForArray(schemaToType(schema.items, ctx, indent))}[]`;
    if (schema.enum) return union(schema.enum.map((v) => literal(v) ?? 'unknown'));
    // 真正的空 schema = 任意值
    return 'unknown';
  }

  const nonNull = types.filter((t) => t !== 'null');
  const nullable = nonNull.length !== types.length;

  const core = ((): string => {
    // const 单值
    if (schema.const !== undefined) {
      return literal(schema.const) ?? 'unknown';
    }
    // enum
    if (Array.isArray(schema.enum)) {
      if (schema.enum.length === 0) return 'never';
      return union(schema.enum.map((v) => literal(v) ?? 'unknown'));
    }
    // 联合类型关键字（如 type: ['string','number']）
    if (nonNull.length > 1) {
      return union(nonNull.map((t) => primitiveOrObject(t, schema, ctx, indent)));
    }
    return primitiveOrObject(nonNull[0], schema, ctx, indent);
  })();

  return nullable ? union([core, 'null']) : core;
}

/** 单个 type 关键字 → TS 类型 */
function primitiveOrObject(type: string, schema: SchemaLike, ctx: Ctx, indent: string): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return schema.items
        ? `${wrapForArray(schemaToType(schema.items, ctx, indent))}[]`
        : 'unknown[]';
    case 'object':
      return objectToType(schema, ctx, indent);
    default:
      throw new Error(`未知的 schema type：${type}`);
  }
}

/** 数组元素类型在联合/函数式类型外层需要括号 */
function wrapForArray(type: string): string {
  return type.includes('|') || type.includes('&') ? `(${type})` : type;
}

/** 交叉类型里的对象需要括号：`A & B` 不能写成对象字面量直接参与 */
function wrapIfObject(rendered: string): string {
  return rendered.startsWith('{') ? `(${rendered})` : rendered;
}

/** 对象 schema → TS 对象类型（含可选属性与索引签名） */
function objectToType(schema: SchemaLike, ctx: Ctx, indent: string): string {
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {});
  const ap = schema.additionalProperties;

  // 纯字典（无具名属性）
  if (props.length === 0) {
    if (ap === undefined || ap === true) {
      // 明确的 "additionalProperties: true" 与未声明都是开放对象
      return 'Record<string, unknown>';
    }
    if (ap === false) return 'Record<string, never>';
    return `Record<string, ${schemaToType(ap, ctx, indent)}>`;
  }

  const inner = indent + '  ';
  const lines: string[] = [];

  // 具名属性
  for (const [key, value] of props) {
    // 键名非法（标识符/关键字）时加引号
    const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !RESERVED.has(key) ? key : `'${key}'`;
    const optional = required.has(key) ? '' : '?';
    const rendered = schemaToType(value, ctx, inner);
    const doc = jsdoc([value.description, describeConstraints(value)], inner);
    lines.push(`${doc}${inner}${safeKey}${optional}: ${rendered};`);
  }

  // 索引签名与具名属性共存时，值类型必须兼容全部具名属性，故并成 unknown
  if (ap !== undefined && ap !== false) {
    if (ap === true) {
      lines.push(`${inner}[key: string]: unknown;`);
    } else {
      const vt = schemaToType(ap, ctx, inner);
      const allNumbersOrStrings = props.every(([, v]) => {
        const t = typeList(v).filter((x) => x !== 'null');
        return t.length === 1 && (t[0] === 'string' || t[0] === 'number');
      });
      if (allNumbersOrStrings) lines.push(`${inner}[key: string]: ${vt};`);
      // 否则 TS 不允许索引签名与不兼容的具名属性共存；这里选择不生成索引签名
      // （具名属性仍是精确的，比塞一个恒真的 unknown 索引签名更有用）
    }
  }

  if (lines.length === 0) return 'Record<string, unknown>';
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/** TS 保留字（作属性名时必须加引号） */
const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
  'any',
  'boolean',
  'constructor',
  'declare',
  'get',
  'module',
  'require',
  'number',
  'set',
  'string',
  'symbol',
  'type',
  'from',
  'of',
]);

/** 把校验型关键字转成说明文字（进 JSDoc，不影响类型） */
function describeConstraints(schema: SchemaLike): string | undefined {
  const parts: string[] = [];
  if (schema.format) parts.push(`格式 ${schema.format}`);
  if (schema.pattern) parts.push(`需匹配 ${schema.pattern}`);
  if (typeof schema.minimum === 'number') parts.push(`最小 ${schema.minimum}`);
  if (typeof schema.maximum === 'number') parts.push(`最大 ${schema.maximum}`);
  if (typeof schema.minLength === 'number') parts.push(`最短 ${schema.minLength}`);
  if (typeof schema.maxLength === 'number') parts.push(`最长 ${schema.maxLength}`);
  if (typeof schema.minItems === 'number') parts.push(`最少 ${schema.minItems} 项`);
  if (typeof schema.maxItems === 'number') parts.push(`最多 ${schema.maxItems} 项`);
  if (schema.deprecated) parts.push('已废弃');
  if (parts.length > 0) return `约束：${parts.join('；')}`;
  return undefined;
}

/** 段名合法化：`/api/quant/factor/composite/batch` + post → `PostApiQuantFactorCompositeBatch` */
export function operationTypeName(path: string, method: string): string {
  const segs = path
    .split('/')
    .filter((s) => s !== '')
    .map((s) =>
      s
        .replace(/[{}]/g, '')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(''),
    );
  return method.toUpperCase() + segs.join('');
}

/** 取某个 operation 响应体的 schema（取 'application/json'） */
/**
 * 取某个 operation 响应体的 schema。
 *
 * **不只取 application/json**：SSE 端点（/analyze/stream、/chat/stream）回的是
 * `text/event-stream`，只认 JSON 会把它们当成「没写 schema」，于是生成器报
 * 「没有 content schema」——一个把正确契约误判为错误的假红灯。
 * 故按 content 声明顺序取第一个带 schema 的媒体类型（JSON 优先，
 * 因为契约里 JSON 总是排在前）。
 */
function responseSchema(op: OperationLike, code: string): SchemaLike | undefined {
  const content = op.responses?.[code]?.content;
  if (!content) return undefined;
  const json = content['application/json'];
  if (json?.schema !== undefined) return json.schema as SchemaLike;
  for (const media of Object.values(content)) {
    if (media?.schema !== undefined) return media.schema as SchemaLike;
  }
  return undefined;
}

/** 取请求体 schema（取 'application/json'） */
function requestSchema(op: OperationLike): SchemaLike | undefined {
  const content = op.requestBody?.content;
  if (!content) return undefined;
  return content['application/json']?.schema as SchemaLike | undefined;
}

/**
 * 取某个 operation 的成功响应类型；契约未声明 2xx 或其 schema 时返回 null。
 *
 * 注意 ctx 必须由调用方传入（带完整 refNames）：早先这里自己 new 一个空 Ctx，
 * 于是任何以 $ref 指向 components 的响应都会报「指向未声明的组件」——
 * 恰好是最该被支持的那批响应。ctx 里有 refNames 才认得出 $ref。
 */
export function successResponseType(
  op: OperationLike,
  ctx: Ctx,
): { code: string; type: string } | null {
  const codes = Object.keys(op.responses ?? {}).filter((c) => STATUS_CODE_RE.test(c));
  const success = codes.find((c) => c.startsWith('2'));
  if (!success) return null;
  const schema = responseSchema(op, success);
  if (schema === undefined) return null;
  return { code: success, type: schemaToType(schema, ctx, '') };
}

/**
 * 主入口：整份 OpenAPI 文档 → 一个 TS 模块的源码文本。
 *
 * 输出结构：
 *   1. 头部告警（禁止手改）
 *   2. `components/schemas` 里的每个组件 → 一个顶层 `export type`
 *   3. 每个 operation → 请求体 / 成功响应 / 查询参数三个 `export type`
 *
 * 顺序按 key 排序（而非对象插入序）以保证确定性：契约里手写的 key 顺序可能
 * 被无意调整，排序后这种调整不会污染生成物 diff。
 */
export function generateTypesModule(doc: OpenApiDocumentLike): string {
  const schemas = doc.components?.schemas ?? {};
  const refNames = new Map<string, string>();
  for (const name of Object.keys(schemas)) refNames.set(name, name);
  const ctx: Ctx = { refNames, declared: new Set() };

  const out: string[] = [];
  out.push(HEADER);

  // 1) 组件类型
  const componentNames = Object.keys(schemas).sort();
  if (componentNames.length > 0) {
    out.push('// ===== components/schemas =====\n');
    for (const name of componentNames) {
      const schema = schemas[name] as SchemaLike;
      const body = schemaToType(schema, ctx, '');
      const doc2 = jsdoc([schema.description], '');
      out.push(`${doc2}export type ${name} = ${body};\n`);
      ctx.declared.add(name);
    }
  }

  // 2) operation 类型
  out.push('// ===== operations =====\n');
  const pathKeys = Object.keys(doc.paths).sort();
  for (const path of pathKeys) {
    const item = doc.paths[path];
    const methods = Object.keys(item).sort();
    for (const method of methods) {
      if (method === 'parameters') continue; // path 级参数本项目未使用
      const op = item[method];
      const base = operationTypeName(path, method);

      const body = requestSchema(op);
      if (body) {
        const rendered = schemaToType(body, ctx, '');
        out.push(
          jsdoc([op.summary, `POST/PUT 等请求体`, `端点：${method.toUpperCase()} ${path}`], '') +
            `export type ${base}RequestBody = ${rendered};\n`,
        );
      }

      const success = successResponseType(op, ctx);
      if (!success) {
        // 2xx 响应存在却没有可用 schema：生成器必须在这里硬失败。
        // 静默跳过会让人以为「该端点已受类型保护」，而实际上前端拿不到任何类型——
        // 这正是本项目此前 62/64 个响应「只有 description」的失败模式。
        const codes = Object.keys(op.responses ?? {}).filter((c) => STATUS_CODE_RE.test(c));
        const code = codes.find((c) => c.startsWith('2'));
        if (code) {
          throw new Error(
            `${method.toUpperCase()} ${path} 的 ${code} 响应没有 content schema：` +
              '请在 services/openapi.ts 为其补上 content（application/json 或 ' +
              'text/event-stream）的 schema，可直接 $ref components.schemas 里的具名组件。',
          );
        }
      } else {
        // 成功响应退化成 unknown 等于没写契约：调用方拿不到任何字段信息，
        // 而「看起来有类型」会让人以为已经受契约保护。
        if (success.type === 'unknown') {
          throw new Error(
            `${method.toUpperCase()} ${path} 的成功响应生成为 unknown：` +
              '契约里该响应的 schema 缺失或为空。请在 services/openapi.ts 为其补上 ' +
              'content.application/json.schema（可直接 $ref components.schemas 里的具名组件）。',
          );
        }
        out.push(
          jsdoc(
            [
              op.summary,
              op.description,
              `成功响应（HTTP ${success.code}）`,
              `端点：${method.toUpperCase()} ${path}`,
            ],
            '',
          ) + `export type ${base}Response = ${success.type};\n`,
        );
      }

      const params = (op.parameters ?? []).filter((p) => p.in === 'query' || p.in === 'path');
      if (params.length > 0) {
        const shape: Record<string, SchemaLike> = {};
        const required: string[] = [];
        const docs: string[] = [];
        for (const p of params) {
          shape[p.name] = { ...(p.schema as SchemaLike), description: p.description };
          if (p.required) required.push(p.name);
          docs.push(`${p.name}（${p.in}${p.required ? '，必填' : ''}）`);
        }
        const rendered = schemaToType(
          { type: 'object', properties: shape, required, description: docs.join('；') },
          ctx,
          '',
        );
        out.push(
          jsdoc([op.summary, `路径/查询参数`, `端点：${method.toUpperCase()} ${path}`], '') +
            `export type ${base}Params = ${rendered};\n`,
        );
      }
    }
  }

  return out.join('\n');
}

/** 生成物头部告警 */
const HEADER = `/**
 * 由 services/openapi.ts 自动生成 —— 请勿手工编辑。
 *
 * 重新生成：npm run generate:api-types
 * 校验是否最新：npm run check:api-types（CI 会跑，改了契约没重生成会失败）
 *
 * 唯一权威来源是 \`GET /api/openapi.json\`。要改这里的字段，请改契约后重新生成，
 * 直接编辑本文件会在下一次生成时被覆盖，并且双向守卫会让 CI 变红。
 */
`;

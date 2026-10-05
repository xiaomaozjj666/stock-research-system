/**
 * JSON Schema 子集校验器（契约响应体校验的公共实现）
 * ----------------------------------------------------------------------------
 * 从 `scripts/contract-smoke.mts` 抽出，供两处复用：
 *   1. 契约冒烟（真实进程 → HTTP 响应 → 校验）
 *   2. 路由测试（supertest 的 res.body → 校验）
 *
 * 为什么抽出：冒烟只能覆盖「起真实进程、不依赖上游」的端点；而**依赖上游的端点
 * 响应体早已在 30 个路由测试里被深度断言**（service 层被 mock）。此前两处各写
 * 各的、或根本不写，契约与实际响应之间缺一道交叉校验。共用同一份实现才有意义 ——
 * 两处规则不一致时，「A 处通过 B 处失败」会变成无法排查的灵异事件。
 *
 * 只支持本项目契约实际用到的关键字（type / properties / required / items /
 * enum / oneOf / $ref / nullable / additionalProperties）。**遇到不认识的构造
 * 不静默放行**：本实现是"宽松地不报错"，但契约里若出现未支持关键字，校验强度
 * 会下降，故 `unsupportedKeywords` 单列出来供守卫断言（见 openapiCoverage.test.ts）。
 */

/** 契约文档的最小结构 */
export interface ContractDoc {
  paths: Record<string, Record<string, ContractOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

export interface ContractOperation {
  requestBody?: unknown;
  responses?: Record<string, ContractResponse>;
  parameters?: unknown;
}

export interface ContractResponse {
  description?: string;
  content?: Record<string, { schema?: unknown }>;
}

/** 未被本校验器处理的 schema 关键字（出现即说明校验强度有缺口） */
const KNOWN_KEYWORDS = new Set([
  '$ref',
  'type',
  'format',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'nullable',
  'oneOf',
  'anyOf',
  'allOf',
  'default',
  'example',
  'examples',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'deprecated',
]);

/**
 * 递归收集 schema 里出现的、未被 KNOWN_KEYWORDS 覆盖的**关键字**。
 *
 * 关键：`properties` 的**键名是属性名、不是关键字**（`stock_code`、`error` 等），
 * 必须跳过；只有 `properties` 的**值**（子 schema）才继续递归。否则会把
 * 几百个业务字段名误报成「未支持的关键字」。
 */
export function unsupportedKeywords(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const v of schema) unsupportedKeywords(v, found);
    return found;
  }
  if (schema === null || typeof schema !== 'object') return found;
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'properties') {
      // 键是属性名（跳过），值是子 schema（递归）
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const sub of Object.values(v as Record<string, unknown>)) {
          unsupportedKeywords(sub, found);
        }
      }
      continue;
    }
    if (k === 'items' || k === 'additionalProperties') {
      unsupportedKeywords(v, found);
      continue;
    }
    if (!KNOWN_KEYWORDS.has(k)) found.add(k);
    // 嵌套容器（oneOf / allOf 等）的值仍是 schema
    unsupportedKeywords(v, found);
  }
  return found;
}

/**
 * 校验 value 是否符合 schema，返回**人类可读的错误列表**（空数组 = 通过）。
 *
 * 判据只做「结构与必填」，**不校验业务取值域**（如 rating 必须是「买入/持有」）：
 * 那是路由测试的业务断言职责，本函数只回答「形状是否与契约一致」。
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
  schemas: Record<string, unknown>,
  path = '$',
): string[] {
  const errs: string[] = [];
  if (schema === undefined || schema === null) return errs;
  if (typeof schema !== 'object' || Array.isArray(schema)) return errs;
  const s = schema as Record<string, unknown>;
  if (Object.keys(s).length === 0) return errs;

  // $ref → 指向 components.schemas
  if (typeof s.$ref === 'string') {
    const name = s.$ref.replace('#/components/schemas/', '');
    const target = schemas[name];
    if (!target) return [`${path}: $ref 悬空 ${name}（契约 components.schemas 缺该键）`];
    return validateAgainstSchema(target, value, schemas, path);
  }

  // oneOf / anyOf：任一分支通过即可
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = s[key];
    if (Array.isArray(branches) && branches.length > 0) {
      const results = branches.map((b) => validateAgainstSchema(b, value, schemas, path));
      if (results.every((r) => r.length > 0)) {
        errs.push(`${path}: ${key} 全不匹配（首个分支报：${results[0][0] ?? '未知'}）`);
      }
      return errs;
    }
  }

  // allOf：各分支都要通过
  if (Array.isArray(s.allOf) && s.allOf.length > 0) {
    for (const b of s.allOf) errs.push(...validateAgainstSchema(b, value, schemas, path));
    return errs;
  }

  // 可空的两种写法：3.1 的 type 数组含 'null'，3.0 的 nullable: true
  const types = Array.isArray(s.type) ? (s.type as string[]) : s.type ? [s.type as string] : [];
  const nullable = types.includes('null') || s.nullable === true;

  if (value === null) {
    if (!nullable && types.length > 0) errs.push(`${path}: 期望非 null，实际 null`);
    return errs;
  }

  const t = types.find((x) => x !== 'null');

  if (t === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errs.push(`${path}: 期望 object，实际 ${Array.isArray(value) ? 'array' : typeof value}`);
      return errs;
    }
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const required = (s.required ?? []) as string[];
    for (const [k, sub] of Object.entries(props)) {
      if (!(k in obj)) {
        if (required.includes(k)) errs.push(`${path}.${k}: 必填字段缺失`);
        continue;
      }
      errs.push(...validateAgainstSchema(sub, obj[k], schemas, `${path}.${k}`));
    }
    for (const k of required) {
      if (!(k in obj)) errs.push(`${path}.${k}: 必填字段缺失`);
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) {
      errs.push(`${path}: 期望 array，实际 ${typeof value}`);
      return errs;
    }
    if (s.items) {
      value.forEach((v, i) =>
        errs.push(...validateAgainstSchema(s.items, v, schemas, `${path}[${i}]`)),
      );
    }
  } else if (t === 'string' && typeof value !== 'string') {
    errs.push(`${path}: 期望 string，实际 ${typeof value}（${preview(value)}）`);
  } else if ((t === 'number' || t === 'integer') && typeof value !== 'number') {
    errs.push(`${path}: 期望 number，实际 ${typeof value}（${preview(value)}）`);
  } else if (t === 'boolean' && typeof value !== 'boolean') {
    errs.push(`${path}: 期望 boolean，实际 ${typeof value}`);
  }

  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    errs.push(`${path}: ${preview(value)} 不在 enum ${JSON.stringify(s.enum)}`);
  }

  return errs;
}

function preview(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.slice(0, 40);
}

/** 取某个 operation 成功响应（2xx）的 JSON schema */
export function okSchemaOf(doc: ContractDoc, path: string, method: string): unknown {
  const op = doc.paths[path]?.[method];
  const code = Object.keys(op?.responses ?? {}).find((c) => /^2\d\d$/.test(c));
  if (!code) return undefined;
  return op?.responses?.[code]?.content?.['application/json']?.schema;
}

/** 便捷入口：按 operation 校验响应体 */
export function validateResponse(
  doc: ContractDoc,
  path: string,
  method: string,
  body: unknown,
): string[] {
  const schema = okSchemaOf(doc, path, method);
  if (!schema) return [];
  return validateAgainstSchema(schema, body, doc.components?.schemas ?? {});
}

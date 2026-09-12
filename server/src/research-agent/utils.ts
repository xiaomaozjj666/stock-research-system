/**
 * 研究 Agent 通用工具
 * ------------------------------------------------------------------
 * 只依赖 Node 内置能力，不引入外部校验库：
 * - parseJsonLoose：容忍 LLM 输出中的 markdown 围栏与前后杂质；
 * - validateSchema：覆盖本项目提示词所用的 JSON Schema 子集
 *   （object/array/string/number/boolean + properties/required/items/enum），
 *   足以完成「LLM 输出必须结构合规」的门禁，超出子集的字段不校验。
 */
import { randomUUID } from 'node:crypto';

let idCounter = 0;

/** 生成形如 EV-3f2a81c4 的短 ID；前缀用于区分实体类型 */
export function newId(prefix: string): string {
  idCounter += 1;
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${prefix}-${rand}${idCounter.toString(36)}`;
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 去掉 markdown 围栏并截取最外层大括号之间的 JSON 文本 */
export function parseJsonLoose(raw: string): unknown {
  let text = String(raw ?? '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM 输出中未找到 JSON 对象');
  }
  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------- 极简 JSON Schema 校验

export interface MiniSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, MiniSchema>;
  required?: string[];
  items?: MiniSchema;
  enum?: (string | number)[];
  /** 数组最小长度（用于 required 语义更强的场景） */
  minItems?: number;
}

function typeOf(value: unknown): MiniSchema['type'] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return undefined;
}

/** 返回错误列表；空数组表示校验通过 */
export function validateSchema(value: unknown, schema: MiniSchema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.type) {
    const actual = typeOf(value);
    if (actual !== schema.type) {
      return [`${path}: 期望 ${schema.type}，实际为 ${actual ?? 'null'}`];
    }
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在枚举 ${schema.enum.join('/')} 内`);
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === null) {
        errors.push(`${path}.${key}: 必填字段缺失`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined || obj[key] === null) continue;
      errors.push(...validateSchema(obj[key], sub, `${path}.${key}`));
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: 数组长度 ${value.length} 小于最小要求 ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) =>
        errors.push(...validateSchema(item, schema.items!, `${path}[${i}]`)),
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------- 时效衰减

/**
 * 指数时效衰减：halfLifeDays 天后可信度减半，下限 0.3。
 * 无日期（或不可解析）按 1 处理——缺失信息不惩罚，由来源层级兜底。
 */
export function recencyDecay(publishedAt: string | undefined, halfLifeDays = 730): number {
  if (!publishedAt) return 1;
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return 1;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  const decay = Math.pow(0.5, ageDays / halfLifeDays);
  return Math.max(0.3, decay);
}

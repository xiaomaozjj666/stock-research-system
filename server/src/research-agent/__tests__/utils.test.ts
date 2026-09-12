/**
 * utils 单元测试：宽松 JSON 解析 / 极简 Schema 校验 / 时效衰减 / 数值钳制
 */
import { describe, it, expect } from 'vitest';
import { parseJsonLoose, validateSchema, recencyDecay, clamp01 } from '../utils.js';
import type { MiniSchema } from '../utils.js';

describe('parseJsonLoose', () => {
  it('容忍围栏与前后杂质', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('好的，结果如下：{"a":{"b":2}} 请查收')).toEqual({ a: { b: 2 } });
  });

  it('无 JSON 或非法 JSON 抛错', () => {
    expect(() => parseJsonLoose('没有结构化内容')).toThrow();
    expect(() => parseJsonLoose('{bad json}')).toThrow();
    expect(() => parseJsonLoose(null as unknown as string)).toThrow();
    expect(() => parseJsonLoose(undefined as unknown as string)).toThrow();
  });
});

describe('validateSchema', () => {
  const schema: MiniSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      level: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', minItems: 2, items: { type: 'string' } },
    },
    required: ['name'],
  };

  it('合法对象通过', () => {
    expect(validateSchema({ name: 'x', level: 'a', tags: ['p', 'q'] }, schema)).toEqual([]);
  });

  it('缺失必填 / 枚举违规 / 数组过短均报错', () => {
    const errors = validateSchema({ level: 'c', tags: ['p'] }, schema);
    expect(errors).toHaveLength(3);
    expect(errors.some((e) => e.includes('$.name'))).toBe(true);
    expect(errors.some((e) => e.includes('枚举'))).toBe(true);
    expect(errors.some((e) => e.includes('minItems') || e.includes('最小要求'))).toBe(true);
  });

  it('类型错误快速失败', () => {
    const errors = validateSchema({ name: 123 }, schema);
    expect(errors.some((e) => e.includes('$.name'))).toBe(true);
  });

  it('类型快速失败路径：null 值与 boolean 校验', () => {
    expect(validateSchema(null, { type: 'object' })).toHaveLength(1);
    expect(validateSchema(true, { type: 'boolean' })).toEqual([]);
    expect(validateSchema('x', { type: 'boolean' })).toHaveLength(1);
  });

  it('无 type/required/properties/items 的 schema 不误报', () => {
    expect(validateSchema({ anything: 1 }, { properties: {} })).toEqual([]);
    expect(validateSchema(['a'], { type: 'array' })).toEqual([]);
    expect(validateSchema('x', { enum: ['x', 'y'] })).toEqual([]);
  });
});

describe('recencyDecay', () => {
  it('缺失或非法日期不惩罚', () => {
    expect(recencyDecay(undefined)).toBe(1);
    expect(recencyDecay('not-a-date')).toBe(1);
  });

  it('近期轻微衰减，过期衰减触底，未来日期不奖励', () => {
    const day = 86_400_000;
    expect(recencyDecay(new Date(Date.now() - 10 * day).toISOString())).toBeGreaterThan(0.95);
    expect(recencyDecay(new Date(Date.now() - 3000 * day).toISOString())).toBe(0.3);
    expect(recencyDecay(new Date(Date.now() + day).toISOString())).toBe(1);
  });
});

describe('clamp01', () => {
  it('边界钳制', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });
});

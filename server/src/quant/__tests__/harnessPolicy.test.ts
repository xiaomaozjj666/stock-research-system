/**
 * harnessPolicy：可调判据的存储、校验与回落
 * ----------------------------------------------------------------------------
 * 本文件不读运行时数据文件：HARNESS_POLICY_FILE 指向进程专属临时目录。
 * 重点覆盖三类容易被忽略的路径：
 *   - 越界/类型错误一律**拒绝**（不静默夹紧）——静默改值会让改进循环以为
 *     自己保留了一个策略，实际生效的是另一个；
 *   - 文件损坏/字段越界 → 回落出厂值，且**不写缓存**（一次瞬时读失败不该
 *     把默认值钉在内存里）；
 *   - 写盘失败 → 返回失败（内存生效而盘上没有＝假保留，重启即丢）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_HARNESS_POLICY,
  POLICY_BOUNDS,
  applyHarnessPolicy,
  getHarnessPolicy,
  getHarnessPolicyState,
  resetHarnessPolicy,
  resetHarnessPolicyCache,
  validateHarnessPolicy,
  type HarnessPolicy,
} from '../harnessPolicy.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-policy-'));
const policyFile = path.join(tmpDir, 'policy.json');
const origFile = process.env.HARNESS_POLICY_FILE;

const CUSTOM: HarnessPolicy = {
  minIcSamples: 10,
  significanceLevel: 0.02,
  minMonotonicity: 0.5,
  requirePositiveSpread: false,
};

beforeAll(() => {
  process.env.HARNESS_POLICY_FILE = policyFile;
});
afterAll(() => {
  if (origFile === undefined) delete process.env.HARNESS_POLICY_FILE;
  else process.env.HARNESS_POLICY_FILE = origFile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(policyFile, { force: true });
  resetHarnessPolicy();
});
afterEach(() => {
  // 写失败用例可能把 env 改到别处；每个用例结束后恢复
  process.env.HARNESS_POLICY_FILE = policyFile;
  resetHarnessPolicyCache();
});

describe('出厂判据', () => {
  it('与改造前 judgeFactor 的硬编码值逐字一致', () => {
    expect(DEFAULT_HARNESS_POLICY.minIcSamples).toBe(5);
    expect(DEFAULT_HARNESS_POLICY.significanceLevel).toBe(0.05);
    expect(DEFAULT_HARNESS_POLICY.minMonotonicity).toBe(0.6);
    expect(DEFAULT_HARNESS_POLICY.requirePositiveSpread).toBe(true);
  });

  it('是冻结对象：外部改动不会污染全局默认值', () => {
    expect(Object.isFrozen(DEFAULT_HARNESS_POLICY)).toBe(true);
  });
});

describe('validateHarnessPolicy', () => {
  it('合法策略通过', () => {
    expect(validateHarnessPolicy(CUSTOM)).toEqual({ ok: true, errors: [] });
    expect(validateHarnessPolicy({ ...DEFAULT_HARNESS_POLICY }).ok).toBe(true);
  });

  it('非对象被拒', () => {
    expect(validateHarnessPolicy(null).ok).toBe(false);
    expect(validateHarnessPolicy('x').ok).toBe(false);
    expect(validateHarnessPolicy(undefined).errors).toContain('策略必须是对象');
  });

  it('非有限数值被拒（NaN / Infinity / 字符串）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.05', null]) {
      const r = validateHarnessPolicy({ ...CUSTOM, significanceLevel: bad });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('显著性水平'))).toBe(true);
    }
  });

  it('越界被拒且说明里带出当前值（不静默夹紧）', () => {
    const r = validateHarnessPolicy({ ...CUSTOM, significanceLevel: 0.9 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('0.9'))).toBe(true);
    expect(validateHarnessPolicy({ ...CUSTOM, minMonotonicity: -0.1 }).ok).toBe(false);
    expect(validateHarnessPolicy({ ...CUSTOM, minIcSamples: 2 }).ok).toBe(false);
    expect(validateHarnessPolicy({ ...CUSTOM, minIcSamples: 61 }).ok).toBe(false);
  });

  it('边界值本身合法（闭区间）', () => {
    expect(
      validateHarnessPolicy({
        minIcSamples: POLICY_BOUNDS.minIcSamples.min,
        significanceLevel: POLICY_BOUNDS.significanceLevel.max,
        minMonotonicity: POLICY_BOUNDS.minMonotonicity.max,
        requirePositiveSpread: true,
      }).ok,
    ).toBe(true);
  });

  it('IC 样本期数必须为整数', () => {
    const r = validateHarnessPolicy({ ...CUSTOM, minIcSamples: 5.5 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('整数'))).toBe(true);
  });

  it('requirePositiveSpread 必须是布尔值', () => {
    const r = validateHarnessPolicy({ ...CUSTOM, requirePositiveSpread: 'yes' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('布尔'))).toBe(true);
  });
});

describe('读取与回落', () => {
  it('无文件时为出厂策略，source=default、revision=0', () => {
    const st = getHarnessPolicyState();
    expect(st.source).toBe('default');
    expect(st.revision).toBe(0);
    expect(st.updatedAt).toBeNull();
    expect(st.lastChange).toBeNull();
    expect(st.policy).toEqual({ ...DEFAULT_HARNESS_POLICY });
  });

  it('JSON 损坏 → 回落出厂值，且失败结果不进缓存（下次重读）', () => {
    fs.writeFileSync(policyFile, '{ 这不是 JSON', 'utf-8');
    expect(getHarnessPolicyState().source).toBe('default');
    // 修好文件后无需手动清缓存即可读到（读失败不写缓存的意义所在）
    fs.writeFileSync(
      policyFile,
      JSON.stringify({ policy: CUSTOM, updatedAt: '2026-01-01T00:00:00.000Z', revision: 3 }),
      'utf-8',
    );
    const st = getHarnessPolicyState();
    expect(st.source).toBe('stored');
    expect(st.policy).toEqual(CUSTOM);
    expect(st.revision).toBe(3);
  });

  it('文件里策略越界 → 视为损坏，回落出厂值', () => {
    fs.writeFileSync(
      policyFile,
      JSON.stringify({ policy: { ...CUSTOM, significanceLevel: 5 }, revision: 1 }),
      'utf-8',
    );
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('缺失可选字段时按缺省补全，不抛错', () => {
    fs.writeFileSync(policyFile, JSON.stringify({ policy: CUSTOM }), 'utf-8');
    const st = getHarnessPolicyState();
    expect(st.revision).toBe(0);
    expect(st.updatedAt).toBeNull();
    expect(st.lastChange).toBeNull();
  });

  it('缓存命中：外部改文件不影响已缓存状态，resetHarnessPolicyCache 后可重读', () => {
    applyHarnessPolicy(CUSTOM);
    fs.writeFileSync(
      policyFile,
      JSON.stringify({ policy: { ...CUSTOM, minIcSamples: 7 } }),
      'utf-8',
    );
    expect(getHarnessPolicy().minIcSamples).toBe(10); // 仍是缓存里的
    resetHarnessPolicyCache();
    expect(getHarnessPolicy().minIcSamples).toBe(7); // 重读后生效
  });

  it('getHarnessPolicy 返回副本：调用方改动不外泄', () => {
    const a = getHarnessPolicy();
    a.minIcSamples = 999;
    expect(getHarnessPolicy().minIcSamples).toBe(DEFAULT_HARNESS_POLICY.minIcSamples);
  });
});

describe('applyHarnessPolicy', () => {
  it('合法策略落盘生效，revision 递增，来源变为 stored', () => {
    const r1 = applyHarnessPolicy(CUSTOM, { lastChange: '第一次改动' });
    expect(r1.ok).toBe(true);
    expect(r1.state?.source).toBe('stored');
    expect(r1.state?.revision).toBe(1);
    expect(r1.state?.lastChange).toBe('第一次改动');
    expect(fs.existsSync(policyFile)).toBe(true);

    const r2 = applyHarnessPolicy({ ...CUSTOM, minIcSamples: 12 });
    expect(r2.state?.revision).toBe(2);
    // 未传 lastChange 时沿用上一次的说明，不把留痕清空
    expect(r2.state?.lastChange).toBe('第一次改动');
    expect(getHarnessPolicy().minIcSamples).toBe(12);
  });

  it('非法策略被拒，且不落盘、不改内存状态', () => {
    const r = applyHarnessPolicy({ ...CUSTOM, significanceLevel: 99 });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(fs.existsSync(policyFile)).toBe(false);
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('写盘失败返回 ok=false（假保留会让重启后判据悄悄回退）', () => {
    // 父路径是普通文件 → mkdirSync 必抛，两端平台都确定性失败
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf-8');
    process.env.HARNESS_POLICY_FILE = path.join(blocker, 'policy.json');
    resetHarnessPolicyCache();
    const r = applyHarnessPolicy(CUSTOM);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('写入失败'))).toBe(true);
  });
});

describe('resetHarnessPolicy', () => {
  it('恢复出厂判据：删文件并回到 default', () => {
    applyHarnessPolicy(CUSTOM);
    expect(getHarnessPolicyState().source).toBe('stored');
    resetHarnessPolicy();
    const st = getHarnessPolicyState();
    expect(st.source).toBe('default');
    expect(st.policy).toEqual({ ...DEFAULT_HARNESS_POLICY });
    expect(fs.existsSync(policyFile)).toBe(false);
  });

  it('文件本就不存在时也不抛错', () => {
    expect(() => resetHarnessPolicy()).not.toThrow();
  });
});

/**
 * ============================================================================
 * /api/improvement/* 路由级测试 —— 改进循环的对外契约。
 *
 * 隔离：三个落盘路径（因子台账 / 改进台账 / 策略）全部指向进程专属临时目录；
 * writeLimiter 替换为直通中间件（本文件请求数会超过 10 req/min，
 * 限流分支本身另有专门覆盖）。
 *
 * 重点断言"诚实披露"这一条：刚上线时判据证据为零，状态接口必须如实说
 * `ready: false` 并给出还差多少——把这一点藏起来，用户会以为循环在干活。
 * ============================================================================
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware.js')>();
  return {
    ...actual,
    writeLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { app } from '../index.js';
import { clearFactorExperiments, recordFactorExperiments } from '../quant/factorLedger.js';
import { clearImprovements, resetImprovementLedgerCache } from '../quant/improvementLedger.js';
import {
  DEFAULT_HARNESS_POLICY,
  resetHarnessPolicy,
  resetHarnessPolicyCache,
} from '../quant/harnessPolicy.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-improvement-'));
const saved = {
  factor: process.env.FACTOR_LEDGER_FILE,
  improvement: process.env.IMPROVEMENT_LEDGER_FILE,
  policy: process.env.HARNESS_POLICY_FILE,
};
const policyFile = path.join(tmpDir, 'policy.json');

/** 灌 n 条"强因子"记录（单调性 0.8、样本外稳定） */
function seed(n: number): void {
  recordFactorExperiments(
    Array.from({ length: n }, (_, i) => ({
      source: 'cross-section' as const,
      name: `f${i}`,
      universe: { requested: 10, included: 10 },
      horizon: 21,
      sampleSize: 100,
      icMean: 0.05,
      pValue: 0.001,
      oosStable: true,
      kept: false,
      evidence: { icN: 20, quantileRows: 5, monotonicity: 0.8, spread: 0.02 },
    })),
  );
}

/**
 * 灌一批"强 + 弱且不稳"混合记录：收紧单调性下限可把弱因子剔掉，
 * 于是存在一个真正更优的候选，循环会保留改动（用于验证"改了之后的状态"）。
 */
function seedMixed(): void {
  recordFactorExperiments(
    Array.from({ length: 40 }, (_, i) => {
      const strong = i % 2 === 0;
      return {
        source: 'cross-section' as const,
        name: `m${i}`,
        universe: { requested: 10, included: 10 },
        horizon: 21,
        sampleSize: 100,
        icMean: 0.05,
        pValue: 0.001,
        oosStable: strong,
        kept: false,
        evidence: {
          icN: 20,
          quantileRows: 5,
          monotonicity: strong ? 0.8 : 0.65,
          spread: 0.02,
        },
      };
    }),
  );
}

beforeAll(() => {
  process.env.FACTOR_LEDGER_FILE = path.join(tmpDir, 'factors.json');
  process.env.IMPROVEMENT_LEDGER_FILE = path.join(tmpDir, 'improvements.json');
  process.env.HARNESS_POLICY_FILE = policyFile;
});
afterAll(() => {
  if (saved.factor === undefined) delete process.env.FACTOR_LEDGER_FILE;
  else process.env.FACTOR_LEDGER_FILE = saved.factor;
  if (saved.improvement === undefined) delete process.env.IMPROVEMENT_LEDGER_FILE;
  else process.env.IMPROVEMENT_LEDGER_FILE = saved.improvement;
  if (saved.policy === undefined) delete process.env.HARNESS_POLICY_FILE;
  else process.env.HARNESS_POLICY_FILE = saved.policy;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(policyFile, { force: true });
  resetHarnessPolicy();
  resetHarnessPolicyCache();
  clearImprovements();
  resetImprovementLedgerCache();
  clearFactorExperiments();
});

describe('GET /api/improvement/status', () => {
  it('无历史证据时如实说明"还差多少"，不假装循环在干活', async () => {
    const res = await request(app).get('/api/improvement/status');
    expect(res.status).toBe(200);
    expect(res.body.target).toBe('factor-verdict-policy');
    expect(res.body.policy).toEqual({ ...DEFAULT_HARNESS_POLICY });
    expect(res.body.policySource).toBe('default');
    expect(res.body.isFactoryPolicy).toBe(true);
    expect(res.body.replay.available).toBe(0);
    expect(res.body.replay.ready).toBe(false);
    expect(res.body.replay.required).toBeGreaterThan(0);
    expect(res.body.replay.note).toContain('evidence');
    expect(res.body.ledger).toMatchObject({ total: 0, kept: 0, reverted: 0, lastAt: null });
  });

  it('证据够时 ready 为 true（切分口径与循环同源）', async () => {
    seed(30); // 30 条 → 训练 21 / 验证 9 ≥ 8
    const res = await request(app).get('/api/improvement/status');
    expect(res.body.replay.available).toBe(30);
    expect(res.body.replay.validationAvailable).toBe(9);
    expect(res.body.replay.ready).toBe(true);
  });

  it('保留过改动后来源变为 stored 并带出改动说明', async () => {
    seedMixed();
    await request(app).post('/api/improvement/run').send({});
    const res = await request(app).get('/api/improvement/status');
    expect(res.body.policyRevision).toBeGreaterThan(0);
    expect(res.body.policySource).toBe('stored');
    expect(res.body.lastChange).toBeTruthy();
    expect(res.body.isFactoryPolicy).toBe(false);
  });
});

describe('POST /api/improvement/run', () => {
  it('证据不足 → changed=false 且给出原因（不是 500，也不是静默成功）', async () => {
    const res = await request(app).post('/api/improvement/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.reason).toContain('可回放');
    expect(res.body.record).toBeNull();
  });

  it('证据充足且现任已最优 → 回滚并留痕，策略仍未改动', async () => {
    seed(40);
    const res = await request(app).post('/api/improvement/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.record).toBeTruthy();
    expect(res.body.record.outcome).toBe('reverted');
    expect(res.body.policySource).toBe('default');
  });

  it('演练模式：不回传记录（"有记录=已生效"是最容易被误读的地方）', async () => {
    seed(40);
    const res = await request(app).post('/api/improvement/run').send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.record).toBeNull();
    expect(res.body.reason).toContain('演练');
  });
});

describe('GET /api/improvement/history', () => {
  it('默认 limit 20，非法值回落，上限夹到 200', async () => {
    seed(40);
    await request(app).post('/api/improvement/run').send({});

    const def = await request(app).get('/api/improvement/history');
    expect(def.status).toBe(200);
    expect(def.body.limit).toBe(20);
    expect(def.body.items.length).toBe(1);

    const big = await request(app).get('/api/improvement/history?limit=99999');
    expect(big.body.limit).toBe(200);

    const bad = await request(app).get('/api/improvement/history?limit=abc');
    expect(bad.body.limit).toBe(20);

    const neg = await request(app).get('/api/improvement/history?limit=-5');
    expect(neg.body.limit).toBe(20);
  });

  it('记录结构可直接复核：改动前后、依据、指标、试过的候选都在', async () => {
    seed(40);
    await request(app).post('/api/improvement/run').send({});
    const res = await request(app).get('/api/improvement/history');
    const rec = res.body.items[0];
    expect(rec.before).toBeTruthy();
    expect(rec.after).toBeTruthy();
    expect(rec.basis.evidenceCount).toBe(40);
    expect(rec.basis.split).toContain('训练');
    expect(rec.metric.name).toBe('oos-precision');
    expect(Array.isArray(rec.tried)).toBe(true);
    expect(rec.tried.length).toBeGreaterThan(0);
  });
});

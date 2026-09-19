/**
 * improvementLedger：harness 改动的留痕
 * ----------------------------------------------------------------------------
 * 本文件不读运行时数据文件：IMPROVEMENT_LEDGER_FILE 指向进程专属临时目录。
 * 重点：
 *   - 每条记录必须能独立回答「改了什么/凭什么改/好了多少/谁被否了」；
 *   - triedValues 是负结果复用的抓手，去重口径必须稳定（浮点按固定精度归一）；
 *   - 容量淘汰、损坏回落、写失败返回 null（不抛）——台账是研究资产，不是数据源。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_IMPROVEMENT_ITEMS,
  clearImprovements,
  listImprovements,
  policyKey,
  recordImprovement,
  recordImprovementAsync,
  resetImprovementLedgerCache,
  summarizeImprovements,
  withImprovementStoreLock,
  type ImprovementRecordInput,
} from '../improvementLedger.js';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../harnessPolicy.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'improvement-ledger-'));
const ledgerFile = path.join(tmpDir, 'improvements.json');
const origFile = process.env.IMPROVEMENT_LEDGER_FILE;

const POLICY_A: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY };
const POLICY_B: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY, minMonotonicity: 0.3 };

function makeInput(over: Partial<ImprovementRecordInput> = {}): ImprovementRecordInput {
  return {
    target: 'factor-verdict-policy',
    basis: {
      evidenceCount: 40,
      trainCount: 28,
      validationCount: 12,
      split: '前 70% 训练 / 后 30% 验证',
    },
    before: POLICY_A,
    after: POLICY_B,
    metric: {
      name: 'oos-precision',
      before: 0.5,
      after: 0.7,
      delta: 0.2,
      keptBefore: 10,
      keptAfter: 8,
    },
    outcome: 'kept',
    verdict: '验证集精度 50.0% → 70.0%，保留改动',
    tried: [{ policy: POLICY_A, trainScore: 0.5, validationScore: 0.5 }],
    ...over,
  };
}

beforeAll(() => {
  process.env.IMPROVEMENT_LEDGER_FILE = ledgerFile;
});
afterAll(() => {
  if (origFile === undefined) delete process.env.IMPROVEMENT_LEDGER_FILE;
  else process.env.IMPROVEMENT_LEDGER_FILE = origFile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  clearImprovements();
});

describe('写入与查询', () => {
  it('记录后可按时间倒序查回，且补齐 id 与 createdAt', () => {
    const a = recordImprovement(makeInput({ verdict: '第一条' }));
    const b = recordImprovement(makeInput({ verdict: '第二条' }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBeTruthy();
    expect(a!.createdAt).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);

    const items = listImprovements();
    expect(items.length).toBe(2);
    // 倒序：后写的在前
    expect(items[0].verdict).toBe('第二条');
  });

  it('limit 生效且被夹到合法范围', () => {
    for (let i = 0; i < 5; i += 1) recordImprovement(makeInput({ verdict: `v${i}` }));
    expect(listImprovements(2).length).toBe(2);
    // 与 factorLedger 同约定：下限夹到 1（0/负数不该变成"返回空"这种误导性结果）
    expect(listImprovements(0).length).toBe(1);
    expect(listImprovements(-3).length).toBe(1);
    expect(listImprovements(Number.NaN).length).toBe(5); // 非有限值回落默认 50
  });

  it('异步写入与串行锁：并发记录不丢更新', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordImprovementAsync(makeInput({ verdict: `async-${i}` })),
      ),
    );
    expect(listImprovements().length).toBe(8);
    // withImprovementStoreLock 串行执行：注入的读-改-写不会交错
    const order: number[] = [];
    await Promise.all([
      withImprovementStoreLock(async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 5));
        order.push(2);
      }),
      withImprovementStoreLock(() => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('容量上限：超出后淘汰最旧记录', () => {
    // 直接落一份满额台账（避免 MAX 次真实写入拖慢用例），再记一条。
    // 顺序按台账不变量排：数组**新在前**，故 old-0 最新、old-{MAX-1} 最旧。
    const base = Date.UTC(2026, 0, 1);
    const items = Array.from({ length: MAX_IMPROVEMENT_ITEMS }, (_, i) => ({
      ...makeInput({ verdict: `old-${i}` }),
      id: `id-${i}`,
      createdAt: new Date(base - i * 1000).toISOString(),
    }));
    fs.writeFileSync(ledgerFile, JSON.stringify({ items }), 'utf-8');
    resetImprovementLedgerCache();

    recordImprovement(makeInput({ verdict: 'newest' }));
    const after = listImprovements(MAX_IMPROVEMENT_ITEMS + 5);
    expect(after.length).toBe(MAX_IMPROVEMENT_ITEMS);
    expect(after[0].verdict).toBe('newest');
    // 被挤掉的是最旧那条；次新的 old-0 仍在
    expect(after.some((r) => r.verdict === `old-${MAX_IMPROVEMENT_ITEMS - 1}`)).toBe(false);
    expect(after.some((r) => r.verdict === 'old-0')).toBe(true);
  });

  it('文件损坏时视为空台账，不抛错', () => {
    fs.writeFileSync(ledgerFile, 'not json at all', 'utf-8');
    resetImprovementLedgerCache();
    expect(listImprovements()).toEqual([]);
    expect(summarizeImprovements().total).toBe(0);
  });

  it('写盘失败返回 null（调用方据此知道"没记下"，而不是以为记下了）', () => {
    const blocker = path.join(tmpDir, 'blocker-file');
    fs.writeFileSync(blocker, 'x', 'utf-8');
    process.env.IMPROVEMENT_LEDGER_FILE = path.join(blocker, 'x.json');
    resetImprovementLedgerCache();
    expect(recordImprovement(makeInput())).toBeNull();
    process.env.IMPROVEMENT_LEDGER_FILE = ledgerFile;
    resetImprovementLedgerCache();
  });
});

describe('summarizeImprovements', () => {
  it('统计保留/回滚数与最近保留时间', () => {
    recordImprovement(makeInput({ outcome: 'reverted', verdict: 'r1' }));
    recordImprovement(makeInput({ outcome: 'kept', verdict: 'k1' }));
    recordImprovement(makeInput({ outcome: 'kept', verdict: 'k2' }));
    const s = summarizeImprovements();
    expect(s.total).toBe(3);
    expect(s.kept).toBe(2);
    expect(s.reverted).toBe(1);
    expect(s.lastAt).toBeTruthy();
    expect(s.lastKeptAt).toBeTruthy();
  });

  it('空台账：各项为 0 / null，不抛错', () => {
    const s = summarizeImprovements();
    expect(s).toMatchObject({ total: 0, kept: 0, reverted: 0, lastAt: null, lastKeptAt: null });
    expect(s.triedValues).toEqual([]);
  });

  it('triedValues 跨记录去重：同一候选在 N 轮里只算一个', () => {
    recordImprovement(
      makeInput({
        tried: [
          { policy: POLICY_A, trainScore: 0.5, validationScore: null },
          { policy: POLICY_B, trainScore: 0.6, validationScore: null },
        ],
      }),
    );
    recordImprovement(
      makeInput({
        tried: [
          { policy: POLICY_A, trainScore: 0.5, validationScore: null },
          { policy: { ...POLICY_B, minIcSamples: 10 }, trainScore: 0.4, validationScore: null },
        ],
      }),
    );
    expect(summarizeImprovements().triedValues.length).toBe(3);
  });
});

describe('policyKey', () => {
  it('同值不同书写归一为同一个键（浮点按 4 位小数）', () => {
    expect(policyKey({ ...POLICY_A, significanceLevel: 0.05 })).toBe(
      policyKey({ ...POLICY_A, significanceLevel: 0.050000001 }),
    );
  });

  it('四项中任一不同即为不同键（含布尔项）', () => {
    const base = policyKey(POLICY_A);
    expect(policyKey({ ...POLICY_A, minIcSamples: 6 })).not.toBe(base);
    expect(policyKey({ ...POLICY_A, significanceLevel: 0.01 })).not.toBe(base);
    expect(policyKey({ ...POLICY_A, minMonotonicity: 0.5 })).not.toBe(base);
    expect(policyKey({ ...POLICY_A, requirePositiveSpread: false })).not.toBe(base);
  });
});

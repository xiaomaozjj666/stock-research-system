/**
 * improvementLoop：用历史经验调判据的闭环
 * ----------------------------------------------------------------------------
 * 本文件不读运行时数据文件：三个落盘路径（因子台账 / 改进台账 / 策略）全部
 * 指向进程专属临时目录。
 *
 * 数据构造原则：**同构重复**。同一组模式重复 N 次，使「较早 70% 训练 / 较新 30% 验证」
 * 两段的成分一致，于是断言不依赖具体哪一条落在哪一段——切分口径变了用例仍然成立。
 *
 * 覆盖的四类结局：保留、因未更优而回滚、因牺牲稳定条数而回滚、因无新候选而不动；
 * 外加证据不足 / 验证集不足 / 全候选不可行 / 演练 / 落盘失败五条早退路径。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MIN_EVIDENCE_COUNT,
  MIN_VALIDATION_COUNT,
  buildCandidates,
  collectReplayRows,
  exploredKeys,
  isFactoryPolicy,
  isFeasible,
  policyDistance,
  runImprovementRound,
  scorePolicy,
  splitCounts,
  type ReplayRow,
} from '../improvementLoop.js';
import { clearFactorExperiments, recordFactorExperiments } from '../factorLedger.js';
import {
  clearImprovements,
  listImprovements,
  recordImprovement,
  type ImprovementRecordInput,
} from '../improvementLedger.js';
import {
  DEFAULT_HARNESS_POLICY,
  getHarnessPolicyState,
  resetHarnessPolicy,
  resetHarnessPolicyCache,
  type HarnessPolicy,
} from '../harnessPolicy.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'improvement-loop-'));
const factorFile = path.join(tmpDir, 'factors.json');
const improvementFile = path.join(tmpDir, 'improvements.json');
const policyFile = path.join(tmpDir, 'policy.json');
const saved = {
  factor: process.env.FACTOR_LEDGER_FILE,
  improvement: process.env.IMPROVEMENT_LEDGER_FILE,
  policy: process.env.HARNESS_POLICY_FILE,
};

interface RowSpec {
  mono: number;
  p?: number;
  icN?: number;
  spread?: number;
  stable: boolean;
}

/** 往因子台账灌一批带判据证据的实验记录（数组顺序即写入顺序） */
function seedLedger(rows: RowSpec[]): void {
  recordFactorExperiments(
    rows.map((r, i) => ({
      source: 'cross-section' as const,
      name: `factor-${i}`,
      universe: { requested: 100, included: 100 },
      horizon: 21,
      sampleSize: 100,
      icMean: 0.05,
      pValue: r.p ?? 0.001,
      oosStable: r.stable,
      kept: false,
      evidence: {
        icN: r.icN ?? 20,
        quantileRows: 5,
        monotonicity: r.mono,
        spread: r.spread ?? 0.02,
      },
    })),
  );
}

/** 把一个模式重复 n 次 */
function repeat(specs: RowSpec[], n: number): RowSpec[] {
  const out: RowSpec[] = [];
  for (let i = 0; i < n; i += 1) out.push(...specs);
  return out;
}

/** 涨势良好、扛得住样本外的因子 */
const GOOD: RowSpec = { mono: 0.8, stable: true };
/** 单调性偏弱、样本外不稳的因子（现任判据会采信它，收紧单调性可剔除） */
const WEAK_UNSTABLE: RowSpec = { mono: 0.65, stable: false };

beforeAll(() => {
  process.env.FACTOR_LEDGER_FILE = factorFile;
  process.env.IMPROVEMENT_LEDGER_FILE = improvementFile;
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
  process.env.FACTOR_LEDGER_FILE = factorFile;
  process.env.IMPROVEMENT_LEDGER_FILE = improvementFile;
  process.env.HARNESS_POLICY_FILE = policyFile;
  fs.rmSync(policyFile, { force: true });
  resetHarnessPolicyCache();
  clearImprovements();
  clearFactorExperiments();
});
afterEach(() => {
  resetHarnessPolicy();
});

// ============================================================
// 纯函数
// ============================================================

describe('buildCandidates', () => {
  it('包含现任判据；现任本身就是网格点时去重（4×4×2=32 个唯一点）', () => {
    // 出厂判据 (5, 0.05, 0.6) 恰好落在网格上，故总数是 32 而不是 33
    const c = buildCandidates({ ...DEFAULT_HARNESS_POLICY });
    expect(c.length).toBe(32);
    expect(c).toContainEqual({ ...DEFAULT_HARNESS_POLICY });
  });

  it('现任不在网格点上时额外占一个位置（保证"不改"永远是合法选项）', () => {
    const incumbent: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY, minMonotonicity: 0.66 };
    const c = buildCandidates(incumbent);
    expect(c.length).toBe(33);
    expect(c[0]).toEqual(incumbent);
  });

  it('沿用现任的 requirePositiveSpread，不擅自改这一维', () => {
    const incumbent: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY, requirePositiveSpread: false };
    expect(buildCandidates(incumbent).every((p) => p.requirePositiveSpread === false)).toBe(true);
  });

  it('去重：同一策略键只出现一次', () => {
    const c = buildCandidates({ ...DEFAULT_HARNESS_POLICY });
    expect(new Set(c.map((p) => JSON.stringify(p))).size).toBe(c.length);
  });
});

describe('scorePolicy', () => {
  const rows: ReplayRow[] = [
    {
      evidence: { icN: 20, pValue: 0.001, quantileRows: 5, monotonicity: 0.8, spread: 0.02 },
      oosStable: true,
    },
    {
      evidence: { icN: 20, pValue: 0.001, quantileRows: 5, monotonicity: 0.65, spread: 0.02 },
      oosStable: false,
    },
  ];

  it('精度 = 采信集里样本外稳定的占比', () => {
    const s = scorePolicy({ ...DEFAULT_HARNESS_POLICY }, rows);
    expect(s.kept).toBe(2);
    expect(s.keptStable).toBe(1);
    expect(s.precision).toBe(0.5);
    expect(s.keptShare).toBe(1);
  });

  it('收紧单调性下限后只留强因子，精度升到 1', () => {
    const s = scorePolicy({ ...DEFAULT_HARNESS_POLICY, minMonotonicity: 0.7 }, rows);
    expect(s.kept).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.keptShare).toBe(0.5);
  });

  it('空记录集：precision 为 null（不是 0——「没得判」与「判出来是 0」不是一回事）', () => {
    const s = scorePolicy({ ...DEFAULT_HARNESS_POLICY }, []);
    expect(s.precision).toBeNull();
    expect(s.kept).toBe(0);
    expect(s.keptShare).toBe(0);
  });

  it('没有采信任何条目时 precision 为 null', () => {
    const s = scorePolicy({ ...DEFAULT_HARNESS_POLICY, minMonotonicity: 0.9 }, rows);
    expect(s.kept).toBe(0);
    expect(s.precision).toBeNull();
  });
});

describe('isFeasible / splitCounts / policyDistance', () => {
  it('必须真的采信了东西，且采信率不低于下限', () => {
    expect(isFeasible({ kept: 0, keptStable: 0, precision: null, keptShare: 0, total: 10 })).toBe(
      false,
    );
    expect(isFeasible({ kept: 1, keptStable: 1, precision: 1, keptShare: 0.05, total: 20 })).toBe(
      false,
    );
    expect(isFeasible({ kept: 2, keptStable: 2, precision: 1, keptShare: 0.1, total: 20 })).toBe(
      true,
    );
  });

  it('splitCounts 与循环实际切分一致（状态接口据此预告）', () => {
    expect(splitCounts(0)).toEqual({ train: 0, validation: 0 });
    expect(splitCounts(10)).toEqual({ train: 7, validation: 3 });
    expect(splitCounts(20)).toEqual({ train: 14, validation: 6 });
    const total = 33;
    const s = splitCounts(total);
    expect(s.train + s.validation).toBe(total);
    expect(splitCounts(-5)).toEqual({ train: 0, validation: 0 });
  });

  it('policyDistance 数不同的维度', () => {
    const a: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY };
    expect(policyDistance(a, { ...a })).toBe(0);
    expect(policyDistance(a, { ...a, minMonotonicity: 0.7 })).toBe(1);
    expect(policyDistance(a, { ...a, minMonotonicity: 0.7, significanceLevel: 0.01 })).toBe(2);
    expect(policyDistance(a, { ...a, requirePositiveSpread: false })).toBe(1);
  });

  it('isFactoryPolicy 认得出出厂判据', () => {
    expect(isFactoryPolicy({ ...DEFAULT_HARNESS_POLICY })).toBe(true);
    expect(isFactoryPolicy({ ...DEFAULT_HARNESS_POLICY, minIcSamples: 6 })).toBe(false);
  });
});

describe('collectReplayRows', () => {
  it('只取带判据证据的记录（旧记录缺 evidence，回放会退化成"用 0 回放"）', () => {
    seedLedger([GOOD, WEAK_UNSTABLE]);
    // 再灌一条无 evidence 的历史记录
    recordFactorExperiments([
      {
        source: 'expression',
        name: 'legacy',
        universe: { requested: 1, included: 1 },
        horizon: 21,
        sampleSize: 10,
        icMean: 0.01,
        pValue: 0.2,
        oosStable: false,
        kept: false,
      },
    ]);
    const rows = collectReplayRows();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.evidence.quantileRows === 5)).toBe(true);
  });

  it('空台账返回空数组', () => {
    expect(collectReplayRows()).toEqual([]);
  });
});

describe('exploredKeys', () => {
  const input = (validationCount: number, policy: HarnessPolicy): ImprovementRecordInput => ({
    target: 'factor-verdict-policy',
    basis: { evidenceCount: 40, trainCount: 28, validationCount, split: 's' },
    before: { ...DEFAULT_HARNESS_POLICY },
    after: policy,
    metric: {
      name: 'oos-precision',
      before: 0.5,
      after: 0.6,
      delta: 0.1,
      keptBefore: 10,
      keptAfter: 8,
    },
    outcome: 'reverted',
    verdict: 'v',
    tried: [{ policy, trainScore: 0.5, validationScore: null }],
  });

  it('只在"历史验证集不少于当前"时才算探索过（证据变多后应重新可探索）', () => {
    const p: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY, minMonotonicity: 0.3 };
    recordImprovement(input(20, p));
    expect(exploredKeys(10).size).toBe(1); // 历史数据更多 → 已探索
    expect(exploredKeys(20).size).toBe(1); // 一样多 → 已探索
    expect(exploredKeys(21).size).toBe(0); // 现在数据更多 → 重新可探索
  });

  it('空台账没有已探索候选', () => {
    expect(exploredKeys(0).size).toBe(0);
  });
});

// ============================================================
// 一轮改进
// ============================================================

describe('runImprovementRound：早退路径', () => {
  it('证据不足时不动，并说明还差多少', () => {
    seedLedger(repeat([GOOD], 5)); // 5 条 < 20
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record).toBeNull();
    expect(r.reason).toContain('可回放');
    expect(r.reason).toContain(String(MIN_EVIDENCE_COUNT));
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('证据够但验证集不足时不动（精度分辨率不够，提升多半是噪声）', () => {
    // 22 条 → 训练 15 / 验证 7 < 8
    seedLedger(repeat([GOOD], 22));
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record).toBeNull();
    expect(r.reason).toContain('验证集');
    expect(r.reason).toContain(String(MIN_VALIDATION_COUNT));
  });

  it('全部候选不可行时不动（多空价差全为非正，任何判据都采信不出东西）', () => {
    seedLedger(repeat([{ ...GOOD, spread: -0.01 }], 30));
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.reason).toContain('不可行');
    expect(r.evaluated).toBeGreaterThan(0);
  });

  it('没有未探索过的候选时不动（负结果复用，不重复跑同一片区域）', () => {
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 20));
    const first = runImprovementRound();
    expect(first.changed).toBe(true);
    // 证据没变 → 上一轮试过的候选全部视为已探索
    const second = runImprovementRound();
    expect(second.changed).toBe(false);
    expect(second.reason).toContain('没有未探索过');
    expect(second.evaluated).toBe(0);
    // 只有真跑过候选的那一轮留痕；早退轮次不写记录（否则每天一条"数据还不够"会淹没台账）
    expect(listImprovements().length).toBe(1);
  });
});

describe('runImprovementRound：决策', () => {
  it('验证集上严格更优且不牺牲稳定条数 → 保留改动并落盘生效', () => {
    // 一半强因子、一半弱且不稳：收紧单调性下限可把弱因子剔掉
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 20));
    const r = runImprovementRound();

    expect(r.changed).toBe(true);
    expect(r.record).not.toBeNull();
    expect(r.record!.outcome).toBe('kept');
    expect(r.record!.metric.after).toBeGreaterThan(r.record!.metric.before);
    expect(r.record!.metric.keptAfter).toBeLessThan(r.record!.metric.keptBefore);
    expect(r.record!.basis.evidenceCount).toBe(40);
    expect(r.record!.basis.trainCount + r.record!.basis.validationCount).toBe(40);
    expect(r.record!.tried.length).toBeGreaterThan(1);

    // 生效的判据真的写到了盘上，且与记账一致
    const st = getHarnessPolicyState();
    expect(st.source).toBe('stored');
    expect(st.revision).toBe(1);
    expect(st.policy).toEqual(r.record!.after);
    // 同分取最小改动：只动单调性这一维（数值维度不该被顺手改掉）
    expect(policyDistance(st.policy, { ...DEFAULT_HARNESS_POLICY })).toBe(1);
    expect(st.policy.minMonotonicity).toBe(0.7);
  });

  it('现任已是最优（精度 100%）→ 回滚并留痕，策略不动', () => {
    seedLedger(repeat([GOOD], 40));
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record).not.toBeNull();
    expect(r.record!.outcome).toBe('reverted');
    expect(r.record!.metric.delta).toBe(0);
    expect(r.reason).toContain('未优于现任');
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('靠少采信换精度但牺牲了稳定条数 → 回滚（不是进步）', () => {
    // 强因子(0.9/稳) + 弱但稳(0.65/稳) + 弱且不稳(0.65/不稳)：
    // 收紧单调性会同时剔掉"弱但稳"，绝对条数下降
    seedLedger(
      repeat([{ mono: 0.9, stable: true }, { mono: 0.65, stable: true }, WEAK_UNSTABLE], 14),
    );
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record!.outcome).toBe('reverted');
    expect(r.record!.metric.after).toBeGreaterThan(r.record!.metric.before);
    expect(r.reason).toContain('不算进步');
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('演练模式：算出结论但不落盘、不改策略、不写记录', () => {
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 20));
    const r = runImprovementRound({ dryRun: true });
    expect(r.changed).toBe(false);
    expect(r.record).toBeNull();
    expect(r.reason).toContain('演练');
    expect(getHarnessPolicyState().source).toBe('default');
    expect(listImprovements().length).toBe(0);
  });

  it('候选更优但策略写盘失败 → 记为回滚，不留下"已改进"的假象', () => {
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 20));
    const blocker = path.join(tmpDir, 'policy-blocker');
    fs.writeFileSync(blocker, 'x', 'utf-8');
    process.env.HARNESS_POLICY_FILE = path.join(blocker, 'policy.json');
    resetHarnessPolicyCache();
    try {
      const r = runImprovementRound();
      expect(r.changed).toBe(false);
      expect(r.reason).toContain('写入失败');
      expect(r.record!.outcome).toBe('reverted');
      expect(r.record!.verdict).toContain('未生效');
    } finally {
      process.env.HARNESS_POLICY_FILE = policyFile;
      resetHarnessPolicyCache();
    }
  });

  it('保留后的新判据真的参与后续分析判定（judgeFactor 走当前策略）', async () => {
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 20));
    const r = runImprovementRound();
    expect(r.changed).toBe(true);

    const { judgeFactor } = await import('../factorEvaluation.js');
    const { getHarnessPolicy } = await import('../harnessPolicy.js');
    const weakReport = {
      period: 21,
      sampleSize: 100,
      ic: {
        n: 20,
        mean: 0.05,
        std: 0.1,
        ir: 0.5,
        tStat: 2,
        pValue: 0.001,
        skew: 0,
        excessKurtosis: 0,
      },
      oos: {
        isMeanIc: 0.05,
        oosMeanIc: 0.04,
        signAgree: true,
        isSignificant: true,
        oosSignificant: true,
        stable: true,
        isN: 14,
        oosN: 6,
      },
      quantile: { period: 21, rows: [{}, {}, {}, {}, {}], spread: 0.02, monotonicity: 0.65 },
      turnover: null,
      alphaBeta: null,
    } as unknown as Parameters<typeof judgeFactor>[0];
    // 出厂判据会采信单调性 0.65；改进后（下限 0.7）不再采信——证明策略真的接上了线上判定
    expect(judgeFactor(weakReport, { ...DEFAULT_HARNESS_POLICY }).effective).toBe(true);
    expect(judgeFactor(weakReport, getHarnessPolicy()).effective).toBe(false);
  });
});

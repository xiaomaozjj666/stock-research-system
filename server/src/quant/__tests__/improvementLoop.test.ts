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
  mcnemarExact,
  pairedDecision,
  policyDecisions,
  policyDistance,
  policyMovement,
  runImprovementRound,
  scorePolicy,
  splitCounts,
  type PolicyScore,
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
  /** 只填判定可行性需要的三个字段；correct/accuracy 与可行性无关 */
  const score = (kept: number, keptShare: number): PolicyScore => ({
    kept,
    keptStable: kept,
    precision: kept > 0 ? 1 : null,
    keptShare,
    correct: kept,
    accuracy: keptShare,
    total: 20,
  });

  it('必须真的采信了东西，且采信率不低于下限', () => {
    expect(isFeasible(score(0, 0))).toBe(false);
    expect(isFeasible(score(1, 0.05))).toBe(false);
    expect(isFeasible(score(2, 0.1))).toBe(true);
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
    significance: {
      accuracyBefore: 0.6,
      accuracyAfter: 0.8,
      afterBetter: 6,
      beforeBetter: 0,
      pValue: 0.0313,
      alpha: 0.05,
      significant: true,
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
// 决策的统计护栏
// ============================================================

/** 造一条判据证据（默认全部通过出厂判据） */
const ev = (monotonicity: number): ReplayRow['evidence'] => ({
  icN: 20,
  pValue: 0.001,
  quantileRows: 5,
  monotonicity,
  spread: 0.02,
});

describe('mcnemarExact', () => {
  it('没有不一致对 → p=1（没有证据就没有结论）', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it('单侧极端 6:0 → p=0.03125，恰好过 0.05', () => {
    expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 6);
    expect(mcnemarExact(6, 0)).toBeLessThan(0.05);
  });

  it('单侧极端 5:0 → p=0.0625，差一口气（这正是提高验证集下限的原因）', () => {
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 6);
    expect(mcnemarExact(5, 0)).toBeGreaterThan(0.05);
  });

  it('双侧对称：b/c 互换结果相同', () => {
    expect(mcnemarExact(7, 2)).toBeCloseTo(mcnemarExact(2, 7), 12);
  });

  it('接近平衡 → 不显著', () => {
    expect(mcnemarExact(10, 9)).toBeGreaterThan(0.9);
  });

  it('p 值封顶为 1', () => {
    expect(mcnemarExact(3, 3)).toBeLessThanOrEqual(1);
    expect(mcnemarExact(1, 0)).toBe(1);
  });

  it('不一致对超过 1000 时保守返回 1（现有配置不可达，且方向安全：不显著→不改判据）', () => {
    expect(mcnemarExact(600, 401)).toBe(1);
  });
});

describe('pairedDecision', () => {
  // 4 条验证记录：两条稳定、两条不稳
  const rows: ReplayRow[] = [
    { evidence: ev(0.8), oosStable: true },
    { evidence: ev(0.8), oosStable: true },
    { evidence: ev(0.65), oosStable: false },
    { evidence: ev(0.65), oosStable: false },
  ];

  it('数出不一致对与两侧准确率', () => {
    // 改前全采信：稳定留对、不稳也留错 → 对 2/4
    // 改后只留强因子：稳定留对、不稳剔对、但丢掉一条"弱但稳" → 对 3/4
    const d = pairedDecision([true, true, true, true], [true, false, false, false], rows);
    expect(d.b).toBe(2); // 两条不稳因子由"留错"变"剔对"
    expect(d.c).toBe(1); // 一条稳定因子由"留对"变"丢掉"
    expect(d.accuracyBefore).toBe(0.5);
    expect(d.accuracyAfter).toBe(0.75);
    expect(d.pValue).toBe(mcnemarExact(2, 1));
  });

  it('判据完全相同 → 无不一致对，p=1', () => {
    const same = [true, true, false, false];
    const d = pairedDecision(same, [...same], rows);
    expect(d.b).toBe(0);
    expect(d.c).toBe(0);
    expect(d.pValue).toBe(1);
    expect(d.accuracyAfter).toBe(d.accuracyBefore);
    // 全判对的情形
    expect(d.accuracyBefore).toBe(1);
  });

  it('空记录集不除零', () => {
    const d = pairedDecision([], [], []);
    expect(d.accuracyBefore).toBe(0);
    expect(d.pValue).toBe(1);
  });
});

describe('policyMovement', () => {
  it('同一策略移动量为 0', () => {
    expect(policyMovement({ ...DEFAULT_HARNESS_POLICY }, { ...DEFAULT_HARNESS_POLICY })).toBe(0);
  });

  it('按定义域归一：显著性动 0.04 比单调性动 0.1 更"重"', () => {
    const base: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY };
    const sigMove = policyMovement(base, { ...base, significanceLevel: 0.01 }); // 0.04/0.199
    const monoMove = policyMovement(base, { ...base, minMonotonicity: 0.7 }); // 0.10/0.90
    expect(sigMove).toBeGreaterThan(monoMove);
  });

  it('布尔维度变化记 1', () => {
    const base: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY };
    const both = policyMovement(base, { ...base, requirePositiveSpread: false });
    expect(both).toBe(1);
  });

  it('多维度变化累加', () => {
    const base: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY };
    const one = policyMovement(base, { ...base, minMonotonicity: 0.7 });
    const two = policyMovement(base, { ...base, minMonotonicity: 0.7, significanceLevel: 0.01 });
    expect(two).toBeGreaterThan(one);
  });
});

describe('policyDecisions', () => {
  it('逐条给出采信决定，与 scorePolicy 口径一致', () => {
    const rows: ReplayRow[] = [
      { evidence: ev(0.8), oosStable: true },
      { evidence: ev(0.65), oosStable: false },
    ];
    expect(policyDecisions({ ...DEFAULT_HARNESS_POLICY }, rows)).toEqual([true, true]);
    expect(policyDecisions({ ...DEFAULT_HARNESS_POLICY, minMonotonicity: 0.7 }, rows)).toEqual([
      true,
      false,
    ]);
  });
});

// ============================================================
// 一轮改进
// ============================================================

describe('runImprovementRound：早退路径', () => {
  it('证据不足时不动，并说明还差多少', () => {
    seedLedger(repeat([GOOD], 5)); // 5 条，远低于证据下限
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record).toBeNull();
    expect(r.reason).toContain('可回放');
    expect(r.reason).toContain(String(MIN_EVIDENCE_COUNT));
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('证据够但验证集不足时不动（配对检验没有功效，提升多半是噪声）', () => {
    // 60 条 → 训练 42 / 验证 18 < 20：刚好卡在"总量够、验证不够"这一档
    seedLedger(repeat([GOOD], 60));
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record).toBeNull();
    expect(r.reason).toContain('验证集');
    expect(r.reason).toContain(String(MIN_VALIDATION_COUNT));
  });

  it('全部候选不可行时不动（多空价差全为非正，任何判据都采信不出东西）', () => {
    seedLedger(repeat([{ ...GOOD, spread: -0.01 }], 70));
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.reason).toContain('不可行');
    expect(r.evaluated).toBeGreaterThan(0);
  });

  it('没有未探索过的候选时不动（负结果复用，不重复跑同一片区域）', () => {
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 35));
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
  it('验证集上显著更优且不牺牲稳定条数 → 保留改动并落盘生效', () => {
    // 一半强因子、一半弱且不稳：收紧单调性下限可把弱因子剔掉
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 35));
    const r = runImprovementRound();

    expect(r.changed).toBe(true);
    expect(r.record).not.toBeNull();
    expect(r.record!.outcome).toBe('kept');
    expect(r.record!.metric.after).toBeGreaterThan(r.record!.metric.before);
    expect(r.record!.metric.keptAfter).toBeLessThan(r.record!.metric.keptBefore);
    expect(r.record!.basis.evidenceCount).toBe(70);
    expect(r.record!.basis.trainCount + r.record!.basis.validationCount).toBe(70);
    expect(r.record!.tried.length).toBeGreaterThan(1);

    // 决策必须带得出统计证据：不一致对与 p 值都可复核
    const sig = r.record!.significance;
    expect(sig.significant).toBe(true);
    expect(sig.pValue).toBeLessThan(sig.alpha);
    expect(sig.afterBetter).toBeGreaterThan(0);
    expect(sig.accuracyAfter).toBeGreaterThan(sig.accuracyBefore);

    // 生效的判据真的写到了盘上，且与记账一致
    const st = getHarnessPolicyState();
    expect(st.source).toBe('stored');
    expect(st.revision).toBe(1);
    expect(st.policy).toEqual(r.record!.after);
    // 同分取移动量最小者：只动单调性这一维（无关维度不该被顺手改掉）
    expect(policyDistance(st.policy, { ...DEFAULT_HARNESS_POLICY })).toBe(1);
    expect(st.policy.minMonotonicity).toBe(0.7);
  });

  it('现任已是最优（准确率 100%）→ 回滚并留痕，策略不动', () => {
    seedLedger(repeat([GOOD], 70));
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record).not.toBeNull();
    expect(r.record!.outcome).toBe('reverted');
    expect(r.record!.metric.delta).toBe(0);
    expect(r.reason).toContain('未优于现任');
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('准确率虽升但牺牲了稳定条数 → 回滚（靠少采信换指标不是进步）', () => {
    // 强且稳(0.9) + 弱但稳(0.65) + 两个弱且不稳(0.65)：
    // 收紧单调性会连"弱但稳"一起剔掉，准确率上去、稳定的绝对条数却降了
    seedLedger(
      repeat(
        [{ mono: 0.9, stable: true }, { mono: 0.65, stable: true }, WEAK_UNSTABLE, WEAK_UNSTABLE],
        20,
      ),
    );
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record!.outcome).toBe('reverted');
    expect(r.record!.significance.accuracyAfter).toBeGreaterThan(
      r.record!.significance.accuracyBefore,
    );
    expect(r.reason).toContain('不算进步');
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('准确率提升但配对差异不显著 → 回滚（小样本上的"提升"不算数）', () => {
    // 验证集 21 条里只有 3 个弱且不稳：全剔掉也只构成 3:0 的不一致对，
    // 双侧 p = 2×(1/2³) = 0.25 > 0.05
    seedLedger(repeat([GOOD, GOOD, GOOD, GOOD, GOOD, GOOD, WEAK_UNSTABLE], 10));
    const r = runImprovementRound();
    expect(r.changed).toBe(false);
    expect(r.record!.significance.significant).toBe(false);
    expect(r.reason).toContain('未达显著');
    expect(getHarnessPolicyState().source).toBe('default');
  });

  it('演练模式：算出结论但不落盘、不改策略、不写记录', () => {
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 35));
    const r = runImprovementRound({ dryRun: true });
    expect(r.changed).toBe(false);
    expect(r.record).toBeNull();
    expect(r.reason).toContain('演练');
    expect(getHarnessPolicyState().source).toBe('default');
    expect(listImprovements().length).toBe(0);
  });

  it('候选更优但策略写盘失败 → 记为回滚，不留下"已改进"的假象', () => {
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 35));
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
    seedLedger(repeat([GOOD, WEAK_UNSTABLE], 35));
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

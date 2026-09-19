/**
 * 改进循环（Improvement Loop）
 * ----------------------------------------------------------------------------
 * RSI 的 L2 那一环：系统**自己找改进策略**，而不是等人给方案。
 *
 * 一轮做什么：
 *   1. 读经验 —— factorLedger 里带完整判据证据（evidence）的历史实验；
 *   2. 切两段 —— 较早的 70% 当**训练集**（只用来挑候选），较新的 30% 当**验证集**
 *      （只用来做保留/回滚决策）。同一批数据既挑又判，等于自己给自己判卷；
 *   3. 生成候选 —— 在判据的三个维度上取网格（显著性水平 × 单调性下限 × 最小样本期数），
 *      外加把**现任判据**本身作为基线候选，保证「不改」永远是一个合法选项；
 *   4. 回放 —— 用 `applyVerdictPolicy`（与线上同一实现）逐条重算采信结果，算目标函数；
 *   5. 决策 —— 胜出候选必须在**验证集**上严格优于现任，且不得牺牲样本外稳定的绝对条数
 *      （靠"少采信"把精度刷上去不是进步）；通过才落盘生效，否则回滚并留痕。
 *
 * 为什么目标函数是「采信集的样本外稳定占比」：
 *   台账里唯一可自动判定、且**独立于判据本身**的真值信号就是 `oosStable`
 *   （它是评估器把 IC 序列切前 70%/后 30% 分别做显著性检验得出的，不是判据的产物）。
 *   判据的职责正是"选出能扛住样本外的因子"，用它做目标与判据的职责一致。
 *   代价必须一并记录：只追精度会退化成"几乎不采信"，故设采信率下限。
 *
 * 诚实的边界（写在代码里而不是留在口头）：
 *   这是**带训练/验证切分的启发式搜索**，不是显著性检验；候选网格有限，
 *   结论只对"这批历史实验"负责。因此每条记录都把候选全集、切分口径与样本量
 *   一并落盘，让人可以复核而不是只能相信。
 */
import { applyVerdictPolicy, type VerdictEvidence } from './factorEvaluation.js';
import { listFactorExperiments, MAX_LEDGER_ITEMS, type FactorExperiment } from './factorLedger.js';
import {
  applyHarnessPolicy,
  DEFAULT_HARNESS_POLICY,
  getHarnessPolicyState,
  type HarnessPolicy,
  type HarnessPolicyState,
} from './harnessPolicy.js';
import {
  listImprovements,
  MAX_IMPROVEMENT_ITEMS,
  policyKey,
  recordImprovement,
  type ImprovementRecord,
  type TriedCandidate,
} from './improvementLedger.js';

/** 可参与回放的最小证据条数：低于此数任何"改进"都是噪声 */
export const MIN_EVIDENCE_COUNT = 20;
/**
 * 验证集最小条数：决策必须建立在足够样本上。
 * 取 8 而非更小值：它同时是「证据总量够但验证集仍不够」这一档的守门人——
 * 证据下界 20 条时验证集只有 6 条（精度分辨率 1/6），不足以支撑一次策略改动。
 */
export const MIN_VALIDATION_COUNT = 8;
/** 训练集占比（其余作验证集）；较早的一段训练、较新的一段验证，避免用未来信息调参 */
export const TRAIN_RATIO = 0.7;
/**
 * 采信率下限：候选至少采信 10% 的待评记录。
 * 没有它，目标函数的最优解几乎总是"几乎不采信"——精度 100% 但一个因子都没选出来。
 */
export const MIN_KEPT_SHARE = 0.1;

/** 候选网格：显著性水平 */
const GRID_SIGNIFICANCE = [0.01, 0.02, 0.05, 0.1] as const;
/** 候选网格：单调性下限 */
const GRID_MONOTONICITY = [0.3, 0.5, 0.6, 0.7] as const;
/** 候选网格：IC 最小样本期数 */
const GRID_MIN_IC_SAMPLES = [5, 10] as const;

/**
 * 训练/验证集切分条数。
 *
 * 导出而非在调用处各写一遍：状态接口要预告"现在跑一轮会不会真的评估候选"，
 * 若它自己算一份切分，就会与循环实际用的口径漂移——预告说够了、实跑却因验证集
 * 不足直接返回，是最难排查的那种不一致。
 */
export function splitCounts(total: number): { train: number; validation: number } {
  const train = Math.floor(Math.max(0, total) * TRAIN_RATIO);
  return { train, validation: Math.max(0, total) - train };
}

/** 一条可回放的经验：判据输入 + 独立真值信号 */
export interface ReplayRow {
  evidence: VerdictEvidence;
  /** 样本外是否稳定（判据之外的独立信号，用作目标函数的真值） */
  oosStable: boolean;
}

/** 某个候选策略在给定记录集上的表现 */
export interface PolicyScore {
  /** 被采信的条数 */
  kept: number;
  /** 采信中样本外稳定的条数（分子） */
  keptStable: number;
  /** 采信集的样本外稳定占比；无采信时为 null */
  precision: number | null;
  /** 采信率 = kept / 总数 */
  keptShare: number;
  /** 总条数 */
  total: number;
}

/** 生成候选网格（含现任判据），按策略键去重 */
export function buildCandidates(incumbent: HarnessPolicy): HarnessPolicy[] {
  const out = new Map<string, HarnessPolicy>();
  out.set(policyKey(incumbent), { ...incumbent });
  for (const significanceLevel of GRID_SIGNIFICANCE) {
    for (const minMonotonicity of GRID_MONOTONICITY) {
      for (const minIcSamples of GRID_MIN_IC_SAMPLES) {
        const p: HarnessPolicy = {
          minIcSamples,
          significanceLevel,
          minMonotonicity,
          requirePositiveSpread: incumbent.requirePositiveSpread,
        };
        out.set(policyKey(p), p);
      }
    }
  }
  return [...out.values()];
}

/** 纯函数：把候选判据逐条回放到记录集上 */
export function scorePolicy(policy: HarnessPolicy, rows: ReplayRow[]): PolicyScore {
  let kept = 0;
  let keptStable = 0;
  for (const row of rows) {
    if (!applyVerdictPolicy(row.evidence, policy).effective) continue;
    kept += 1;
    if (row.oosStable) keptStable += 1;
  }
  return {
    kept,
    keptStable,
    precision: kept > 0 ? keptStable / kept : null,
    keptShare: rows.length > 0 ? kept / rows.length : 0,
    total: rows.length,
  };
}

/** 两个策略在几个维度上不同（0–4） */
export function policyDistance(a: HarnessPolicy, b: HarnessPolicy): number {
  let d = 0;
  if (a.minIcSamples !== b.minIcSamples) d += 1;
  if (a.significanceLevel !== b.significanceLevel) d += 1;
  if (a.minMonotonicity !== b.minMonotonicity) d += 1;
  if (a.requirePositiveSpread !== b.requirePositiveSpread) d += 1;
  return d;
}

/**
 * 候选排序键（越小越优）。
 *
 * 前三级是「好多少」：精度高者优先；精度相同则**稳定的绝对条数**多者优先
 * （同样 80% 精度，采信 8 个稳定因子比采信 4 个好）；再同则采信率高者优先。
 *
 * 第四级是「动多少」：与现任差异最小的优先。没有这一级，目标函数对
 * 「哪个维度起的作用」没有偏好，会在一堆同分候选里按遍历顺序随便挑一个——
 * 实测中它会把**与提升无关**的维度也一起改掉（显著性从 0.05 挪到 0.01，
 * 仅仅因为它排在网格前面）。同分时取最小改动，是"能不动就不动"的归纳偏置。
 */
function compareScore(a: PolicyScore, b: PolicyScore, aDist: number, bDist: number): number {
  if (a.precision === null) return b.precision === null ? 0 : 1;
  if (b.precision === null) return -1;
  if (a.precision !== b.precision) return b.precision - a.precision;
  if (a.keptStable !== b.keptStable) return b.keptStable - a.keptStable;
  if (a.keptShare !== b.keptShare) return b.keptShare - a.keptShare;
  return aDist - bDist;
}

/** 候选是否可行：必须有采信，且采信率不低于下限 */
export function isFeasible(score: PolicyScore): boolean {
  return score.kept > 0 && score.keptShare >= MIN_KEPT_SHARE;
}

/**
 * 从台账抽取可回放的经验行（旧→新）。
 * 只取带完整 evidence 的记录——旧记录缺判据输入，回放时会退化成"用 0 回放"，
 * 那是在编数据，不是回放。
 */
export function collectReplayRows(): ReplayRow[] {
  // listFactorExperiments 返回新→旧；反转得旧→新，让"较早训练、较新验证"成立
  return [...listFactorExperiments({ limit: MAX_LEDGER_ITEMS })]
    .reverse()
    .filter((e: FactorExperiment) => e.evidence !== undefined)
    .map((e) => ({
      // 只保留判据需要的四项；台账里的 quantileRows 与 icN 由记录侧保证齐全
      evidence: { ...e.evidence!, pValue: e.pValue },
      oosStable: Boolean(e.oosStable),
    }));
}

/**
 * 已被"用不少于当前验证集规模的数据"探索过的候选键。
 *
 * 负结果复用的判据：某候选在验证集更大（信息更多）的那一轮里都赢不了，
 * 现在数据更少，再试一次不会得到不同结论。反过来，当验证集长大后
 * （validationCount 超过历史记录）候选会重新变为可探索——证据变了就该重判。
 */
export function exploredKeys(currentValidationCount: number): Set<string> {
  const keys = new Set<string>();
  for (const rec of listImprovements(MAX_IMPROVEMENT_ITEMS)) {
    if (rec.basis.validationCount < currentValidationCount) continue;
    for (const c of rec.tried ?? []) keys.add(policyKey(c.policy));
  }
  return keys;
}

export interface ImprovementRoundResult {
  /** 策略是否真的被改动并落盘生效 */
  changed: boolean;
  /** 结局说明（中文，可直接展示）；changed 为 false 时即为未改动的原因 */
  reason: string;
  /** 写入台账的记录；本轮未产生记录（证据不足等）时为 null */
  record: ImprovementRecord | null;
  /** 本轮结束后的策略状态 */
  policyState: HarnessPolicyState;
  /** 本轮真正评估过的候选数 */
  evaluated: number;
}

export interface RunImprovementOptions {
  /** 只评估、不落盘（演练）：用于人手确认改动是否合理 */
  dryRun?: boolean;
}

/**
 * 跑一轮改进。
 *
 * 任何内部异常都不外抛——改进循环是增强能力，不该把调用它的定时任务或 HTTP
 * 处理器打挂。失败时返回 changed=false 与原因。
 */
export function runImprovementRound(opts: RunImprovementOptions = {}): ImprovementRoundResult {
  const dryRun = opts.dryRun === true;
  try {
    return runRound(dryRun);
  } catch (err) {
    return {
      changed: false,
      reason: `改进循环内部错误：${(err as Error).message}`,
      record: null,
      policyState: getHarnessPolicyState(),
      evaluated: 0,
    };
  }
}

function runRound(dryRun: boolean): ImprovementRoundResult {
  const incumbentState = getHarnessPolicyState();
  const incumbent = incumbentState.policy;
  const rows = collectReplayRows();

  if (rows.length < MIN_EVIDENCE_COUNT) {
    return {
      changed: false,
      reason: `可回放的历史实验仅 ${rows.length} 条（需 ≥${MIN_EVIDENCE_COUNT}）：台账里的判据证据是本次改造起才开始留痕的，先多跑几轮因子评估再来`,
      record: null,
      policyState: incumbentState,
      evaluated: 0,
    };
  }

  const trainCount = splitCounts(rows.length).train;
  const train = rows.slice(0, trainCount);
  const validation = rows.slice(trainCount);
  if (validation.length < MIN_VALIDATION_COUNT) {
    return {
      changed: false,
      reason: `验证集仅 ${validation.length} 条（需 ≥${MIN_VALIDATION_COUNT}）：样本太少时"精度提升"多半是噪声`,
      record: null,
      policyState: incumbentState,
      evaluated: 0,
    };
  }

  const explored = exploredKeys(validation.length);
  // 现任判据永远参与评估（「不改」必须是合法选项），但只有**未探索过**的候选才算新信息；
  // 一个都没有时直接说明，而不是把同一片区域重跑一遍得出同一个结论。
  const fresh = buildCandidates(incumbent).filter((p) => !explored.has(policyKey(p)));
  if (fresh.length === 0) {
    return {
      changed: false,
      reason:
        '本轮没有未探索过的候选（现有证据下可试的判据都试过了）：等历史实验再多一些会自动重新可探索',
      record: null,
      policyState: incumbentState,
      evaluated: 0,
    };
  }
  const candidateMap = new Map<string, HarnessPolicy>();
  candidateMap.set(policyKey(incumbent), incumbent);
  for (const p of fresh) candidateMap.set(policyKey(p), p);
  const candidates = [...candidateMap.values()];

  // 训练集挑候选：可行的里面取最优（同分取与现任差异最小者）
  const tried: TriedCandidate[] = [];
  let best: { policy: HarnessPolicy; trainScore: PolicyScore } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const policy of candidates) {
    const trainScore = scorePolicy(policy, train);
    const feasible = isFeasible(trainScore);
    tried.push({
      policy,
      trainScore: feasible ? (trainScore.precision ?? null) : null,
      validationScore: null,
    });
    if (!feasible) continue;
    const dist = policyDistance(policy, incumbent);
    if (best === null || compareScore(trainScore, best.trainScore, dist, bestDist) < 0) {
      best = { policy, trainScore };
      bestDist = dist;
    }
  }

  if (best === null) {
    return {
      changed: false,
      reason: `训练集上 ${candidates.length} 个候选全部不可行（没有一个能把采信率维持在 ${MIN_KEPT_SHARE * 100}% 以上）`,
      record: null,
      policyState: incumbentState,
      evaluated: candidates.length,
    };
  }

  // 验证集做决策：现任 vs 胜出候选
  const beforeScore = scorePolicy(incumbent, validation);
  const afterScore = scorePolicy(best.policy, validation);
  // 把胜出候选的验证集得分补进 tried，便于事后复核"训练集最优在验证集上是什么样"
  const bestKey = policyKey(best.policy);
  for (const t of tried) {
    if (policyKey(t.policy) === bestKey) t.validationScore = afterScore.precision ?? null;
  }

  const beforePrecision = beforeScore.precision ?? 0;
  const afterPrecision = afterScore.precision ?? 0;
  const basis = {
    evidenceCount: rows.length,
    trainCount: train.length,
    validationCount: validation.length,
    split: `按记录时间旧→新排序，前 ${Math.round(TRAIN_RATIO * 100)}% 训练（${train.length} 条）挑候选，后 ${100 - Math.round(TRAIN_RATIO * 100)}% 验证（${validation.length} 条）做决策`,
  };
  const metric = {
    name: 'oos-precision' as const,
    before: round4(beforePrecision),
    after: round4(afterPrecision),
    delta: round4(afterPrecision - beforePrecision),
    keptBefore: beforeScore.kept,
    keptAfter: afterScore.kept,
  };

  // 决策：必须严格更优，且不得牺牲稳定的绝对条数
  const improved = afterPrecision > beforePrecision;
  const noLoss = afterScore.keptStable >= beforeScore.keptStable;
  const decided = improved && noLoss;

  let verdict: string;
  if (!improved) {
    verdict = `验证集上胜出候选未优于现任（精度 ${fmt(beforePrecision)} → ${fmt(afterPrecision)}），维持现任判据`;
  } else if (!noLoss) {
    verdict = `验证集精度虽升（${fmt(beforePrecision)} → ${fmt(afterPrecision)}），但样本外稳定的绝对条数从 ${beforeScore.keptStable} 降到 ${afterScore.keptStable}——靠少采信换精度不算进步，维持现任判据`;
  } else {
    verdict = `验证集精度 ${fmt(beforePrecision)} → ${fmt(afterPrecision)}（采信 ${beforeScore.kept} → ${afterScore.kept} 条，其中稳定 ${beforeScore.keptStable} → ${afterScore.keptStable} 条），保留改动`;
  }

  const record: ImprovementRecord | null = dryRun
    ? null
    : recordImprovement({
        target: 'factor-verdict-policy',
        basis,
        before: { ...incumbent },
        after: { ...best.policy },
        metric,
        outcome: decided ? 'kept' : 'reverted',
        verdict: dryRun ? `（演练，未落盘）${verdict}` : verdict,
        tried,
      });

  if (!decided) {
    return {
      changed: false,
      // 演练标记必须加在**所有**出口上：只在"本来就会改"的分支加，会让没改成的
      // 演练与真实运行返回一模一样的文案，事后翻日志分不出哪次是真的动过手。
      reason: dryRun ? `（演练）${verdict}` : verdict,
      record,
      policyState: getHarnessPolicyState(),
      evaluated: candidates.length,
    };
  }

  if (dryRun) {
    return {
      changed: false,
      reason: `（演练）${verdict}`,
      record,
      policyState: incumbentState,
      evaluated: candidates.length,
    };
  }

  const applied = applyHarnessPolicy(best.policy, { lastChange: verdict });
  if (!applied.ok) {
    // 落盘失败 = 假保留：内存生效而重启即丢。如实记成回滚，不留"已改进"的假象。
    const failed = recordImprovement({
      target: 'factor-verdict-policy',
      basis,
      before: { ...incumbent },
      after: { ...best.policy },
      metric,
      outcome: 'reverted',
      verdict: `候选更优但策略写入失败，未生效：${applied.errors.join('；')}`,
      tried,
    });
    return {
      changed: false,
      reason: `策略写入失败，改动未生效：${applied.errors.join('；')}`,
      record: failed ?? record,
      policyState: getHarnessPolicyState(),
      evaluated: candidates.length,
    };
  }

  return {
    changed: true,
    reason: verdict,
    record,
    policyState: applied.state ?? getHarnessPolicyState(),
    evaluated: candidates.length,
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function fmt(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** 现任判据是否就是出厂值（供状态接口如实披露"从未被改动过"） */
export function isFactoryPolicy(policy: HarnessPolicy): boolean {
  return policyKey(policy) === policyKey(DEFAULT_HARNESS_POLICY as HarnessPolicy);
}

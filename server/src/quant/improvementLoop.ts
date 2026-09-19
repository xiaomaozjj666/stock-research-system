/**
 * 改进循环（Improvement Loop）
 * ----------------------------------------------------------------------------
 * RSI 的 L2 那一环：系统**自己找改进策略**，而不是等人给方案。
 *
 * 一轮做什么：
 *   1. 读经验 —— factorLedger 里带完整判据证据（evidence）的历史实验；
 *   2. 切两段 —— 较早的 70% 当**训练集**（只用来挑候选），较新的 30% 当**验证集**
 *      （只用来做保留/回滚决策）。同一批数据既挑又判，等于自己给自己判卷；
 *   3. 生成候选 —— 判据的三个维度取网格（显著性水平 × 单调性下限 × 最小样本期数），
 *      外加把**现任判据**本身作为基线候选，保证「不改」永远是一个合法选项；
 *   4. 回放 —— 用 `applyVerdictPolicy`（与线上同一实现）逐条重算采信结果，算目标函数；
 *   5. 决策 —— 胜出候选必须同时满足三条：验证集上**决策准确率**更高、样本外稳定的
 *      **绝对条数不减**、且配对差异通过 **McNemar 精确检验**（双侧 p < 0.05）。
 *
 * 目标函数为什么是「决策准确率」而不是「采信集精度」：
 *   一条记录的判定对错只有两种好结局——采信了扛住样本外的因子（真阳性）、
 *   剔除了没扛住的因子（真阴性）。只盯精度会漏掉后者：把好因子一起扔掉的策略
 *   精度可能更高。准确率把两类错误一起算进去，而且**天然是配对二值**，
 *   于是可以直接上 McNemar——这正是"它只是启发式、不是显著性检验"那个短板的解法。
 *   精度仍然照常记录：它是使用者真正关心的口径（采信的东西有多可靠）。
 *
 * 为什么不对候选数做多重比较校正：
 *   候选是在**训练集**上挑的，验证集自始至终没参与选择。选择偏差由切分本身挡掉了，
 *   验证集上的检验是一次干净的确认性检验，不是"32 次里的最大值"。
 *
 * 诚实的边界（写在代码里，而不是留在口头）：
 *   ① 候选网格有限，结论只对「这批历史实验」负责；
 *   ② 提高证据下限（60 条可回放 / 20 条验证）是有意的——判据会被自动改写并影响
 *      后续所有分析结论，样本不足时"不动"才是正确答案，故宁可让循环多在等待态；
 *   ③ 每条记录都把候选全集、切分口径、样本量与检验统计量一并落盘，供人复核。
 */
import { applyVerdictPolicy, type VerdictEvidence } from './factorEvaluation.js';
import { listFactorExperiments, MAX_LEDGER_ITEMS, type FactorExperiment } from './factorLedger.js';
import {
  applyHarnessPolicy,
  DEFAULT_HARNESS_POLICY,
  getHarnessPolicyState,
  POLICY_BOUNDS,
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

/**
 * 可参与回放的最小证据条数：低于此数任何"改进"都是噪声。
 * 取 60 而非 20：判据一旦被改写就影响后续全部分析结论，而配对检验在小样本上
 * 几乎没有功效——与其给出一个测不出来的结论，不如先攒够证据。
 */
export const MIN_EVIDENCE_COUNT = 60;
/** 验证集最小条数：它决定检验的功效。20 条时 6:0 的不一致对即可达显著（p≈0.031） */
export const MIN_VALIDATION_COUNT = 20;
/** 训练集占比（其余作验证集）；较早的一段训练、较新的一段验证，避免用未来信息调参 */
export const TRAIN_RATIO = 0.7;
/**
 * 采信率下限：候选至少采信 10% 的待评记录。
 * 没有它，目标函数的最优解几乎总是"几乎不采信"——准确率好看但一个因子都没选出来。
 */
export const MIN_KEPT_SHARE = 0.1;
/** 决策显著性水平（双侧） */
export const DECISION_ALPHA = 0.05;

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
  /** 采信中样本外稳定的条数 */
  keptStable: number;
  /** 采信集的样本外稳定占比（使用者口径）；无采信时为 null */
  precision: number | null;
  /** 采信率 = kept / 总数 */
  keptShare: number;
  /** 判定正确的条数：采信了稳定因子，或剔除了不稳定因子 */
  correct: number;
  /** 决策准确率 = correct / 总数（目标函数） */
  accuracy: number;
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

/** 某条记录在该判据下的采信决定（逐条，供配对检验用） */
export function policyDecisions(policy: HarnessPolicy, rows: ReplayRow[]): boolean[] {
  return rows.map((row) => applyVerdictPolicy(row.evidence, policy).effective);
}

/** 纯函数：把候选判据逐条回放到记录集上 */
export function scorePolicy(policy: HarnessPolicy, rows: ReplayRow[]): PolicyScore {
  const decisions = policyDecisions(policy, rows);
  let kept = 0;
  let keptStable = 0;
  let correct = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const decision = decisions[i];
    const stable = rows[i].oosStable;
    if (decision) {
      kept += 1;
      if (stable) keptStable += 1;
    }
    // 判定正确 = 采信了稳定因子（真阳性）或剔除了不稳定因子（真阴性）
    if (decision === stable) correct += 1;
  }
  return {
    kept,
    keptStable,
    precision: kept > 0 ? keptStable / kept : null,
    keptShare: rows.length > 0 ? kept / rows.length : 0,
    correct,
    accuracy: rows.length > 0 ? correct / rows.length : 0,
    total: rows.length,
  };
}

/**
 * McNemar 精确检验（双侧）。
 *
 * 输入是配对二值结果的不一致对数：b = 改后对/改前错，c = 改前对/改后错。
 * 在原假设「两种判据的判定正确率相同」下，不一致对服从 Binomial(b+c, 0.5)，
 * 双侧 p = 2 × P(X ≤ min(b,c))，封顶 1。
 *
 * 大样本兜底：b+c > 1000 时 0.5^n 下溢，直接返回 1（不显著）。该分支在现有配置下
 * **不可达**——台账上限 500 条、验证集占 30%，不一致对最多 150 对；返回 1 是安全
 * 方向（不显著 → 不改判据），不会误保留。
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  if (n > 1000) return 1;
  const m = Math.min(b, c);
  let term = 0.5 ** n; // P(X=0)
  let tail = term;
  for (let k = 1; k <= m; k += 1) {
    term *= (n - k + 1) / k; // C(n,k)/C(n,k-1)
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

export interface PairedDecision {
  /** 改后对、改前错的条数（McNemar b） */
  b: number;
  /** 改前对、改后错的条数（McNemar c） */
  c: number;
  pValue: number;
  accuracyBefore: number;
  accuracyAfter: number;
}

/** 配对比较两个判据在**同一批**验证记录上的判定正确率 */
export function pairedDecision(
  beforeKept: boolean[],
  afterKept: boolean[],
  rows: ReplayRow[],
): PairedDecision {
  let b = 0;
  let c = 0;
  let correctBefore = 0;
  let correctAfter = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const stable = rows[i].oosStable;
    const okBefore = beforeKept[i] === stable;
    const okAfter = afterKept[i] === stable;
    if (okBefore) correctBefore += 1;
    if (okAfter) correctAfter += 1;
    if (okAfter && !okBefore) b += 1;
    else if (okBefore && !okAfter) c += 1;
  }
  const total = rows.length || 1;
  return {
    b,
    c,
    pValue: mcnemarExact(b, c),
    accuracyBefore: correctBefore / total,
    accuracyAfter: correctAfter / total,
  };
}

/**
 * 判据改动的「归一化移动量」：各维度变化幅度除以该维度定义域宽度后求和，布尔维度记 1。
 *
 * 用于同分候选的取舍。此前按"改了几个维度"排，遇到两个都只改一维、得分又完全相同的
 * 候选时只能由遍历顺序决定改哪个——实测会把显著性从 0.05 一路收紧到 0.01，而真正
 * 起作用的是单调性。改成比移动量后，**动得最少的那个**胜出：既是"能不动就不动"的
 * 归纳偏置，也避免把与提升无关的维度顺手改掉。
 */
export function policyMovement(a: HarnessPolicy, b: HarnessPolicy): number {
  const span = (key: 'minIcSamples' | 'significanceLevel' | 'minMonotonicity') =>
    POLICY_BOUNDS[key].max - POLICY_BOUNDS[key].min;
  return (
    Math.abs(a.minIcSamples - b.minIcSamples) / span('minIcSamples') +
    Math.abs(a.significanceLevel - b.significanceLevel) / span('significanceLevel') +
    Math.abs(a.minMonotonicity - b.minMonotonicity) / span('minMonotonicity') +
    (a.requirePositiveSpread === b.requirePositiveSpread ? 0 : 1)
  );
}

/** 两个策略在几个维度上不同（0–4）；作为移动量相同后的兜底排序 */
export function policyDistance(a: HarnessPolicy, b: HarnessPolicy): number {
  let d = 0;
  if (a.minIcSamples !== b.minIcSamples) d += 1;
  if (a.significanceLevel !== b.significanceLevel) d += 1;
  if (a.minMonotonicity !== b.minMonotonicity) d += 1;
  if (a.requirePositiveSpread !== b.requirePositiveSpread) d += 1;
  return d;
}

/**
 * 候选排序键（返回负数表示 a 更优）。
 *   ① 准确率高者优先（主目标）
 *   ② 稳定的绝对条数多者优先（同样准确率，多留一个真因子更好）
 *   ③ 采信率高者优先（同样准确率，别把判据收得太死）
 *   ④ 与现任的归一化移动量小者优先（能不动就不动）
 *   ⑤ 改动的维度数少者优先（同为最小移动时少动一维）
 */
function compareScore(
  a: PolicyScore,
  b: PolicyScore,
  aMove: number,
  bMove: number,
  aDist: number,
  bDist: number,
): number {
  if (a.accuracy !== b.accuracy) return b.accuracy - a.accuracy;
  if (a.keptStable !== b.keptStable) return b.keptStable - a.keptStable;
  if (a.keptShare !== b.keptShare) return b.keptShare - a.keptShare;
  if (aMove !== bMove) return aMove - bMove;
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
      evidence: { ...e.evidence!, pValue: e.pValue },
      oosStable: Boolean(e.oosStable),
    }));
}

/**
 * 已被"用不少于当前验证集规模的数据"探索过的候选键。
 *
 * 负结果复用的判据：某候选在验证集更大（信息更多）的那一轮里都赢不了，现在数据
 * 更少，再试一次不会得到不同结论。反过来，当验证集长大后（validationCount 超过
 * 历史记录）候选会重新变为可探索——证据变了就该重判。
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
      reason: `可回放的历史实验仅 ${rows.length} 条（需 ≥${MIN_EVIDENCE_COUNT}）：判据证据自本次改造起才开始留痕，存量记录不含该字段，先多跑几轮因子评估再来`,
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
      reason: `验证集仅 ${validation.length} 条（需 ≥${MIN_VALIDATION_COUNT}）：样本太少时配对检验没有功效，"提升"多半是噪声`,
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

  // 训练集挑候选：可行的里面取最优（同分取移动量最小者）
  const tried: TriedCandidate[] = [];
  let best: { policy: HarnessPolicy; trainScore: PolicyScore } | null = null;
  let bestMove = Number.POSITIVE_INFINITY;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const policy of candidates) {
    const trainScore = scorePolicy(policy, train);
    const feasible = isFeasible(trainScore);
    tried.push({
      policy,
      trainScore: feasible ? trainScore.accuracy : null,
      validationScore: null,
    });
    if (!feasible) continue;
    const move = policyMovement(policy, incumbent);
    const dist = policyDistance(policy, incumbent);
    if (
      best === null ||
      compareScore(trainScore, best.trainScore, move, bestMove, dist, bestDist) < 0
    ) {
      best = { policy, trainScore };
      bestMove = move;
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

  // 并列数：与胜出者在训练集上准确率相同的候选个数（>1 说明主目标区分不开，供人复核取舍）
  const winnerAccuracy = best.trainScore.accuracy;
  const tiedAtBest = tried.filter(
    (t) => t.trainScore !== null && t.trainScore === winnerAccuracy,
  ).length;

  // 验证集做决策：现任 vs 胜出候选（配对 McNemar）
  const beforeScore = scorePolicy(incumbent, validation);
  const afterScore = scorePolicy(best.policy, validation);
  const paired = pairedDecision(
    policyDecisions(incumbent, validation),
    policyDecisions(best.policy, validation),
    validation,
  );
  // 把胜出候选的验证集得分补进 tried，便于事后复核"训练集最优在验证集上是什么样"
  const winnerKey = policyKey(best.policy);
  for (const t of tried) {
    if (policyKey(t.policy) === winnerKey) t.validationScore = afterScore.accuracy;
  }

  const basis = {
    evidenceCount: rows.length,
    trainCount: train.length,
    validationCount: validation.length,
    split: `按记录时间旧→新排序，前 ${Math.round(TRAIN_RATIO * 100)}% 训练（${train.length} 条）挑候选，后 ${100 - Math.round(TRAIN_RATIO * 100)}% 验证（${validation.length} 条）做决策`,
  };
  const metric = {
    name: 'oos-precision' as const,
    before: round4(beforeScore.precision ?? 0),
    after: round4(afterScore.precision ?? 0),
    delta: round4((afterScore.precision ?? 0) - (beforeScore.precision ?? 0)),
    keptBefore: beforeScore.kept,
    keptAfter: afterScore.kept,
  };
  const significance = {
    accuracyBefore: round4(paired.accuracyBefore),
    accuracyAfter: round4(paired.accuracyAfter),
    afterBetter: paired.b,
    beforeBetter: paired.c,
    pValue: round4(paired.pValue),
    alpha: DECISION_ALPHA,
    significant: paired.pValue < DECISION_ALPHA,
  };

  const accuracyImproved = paired.accuracyAfter > paired.accuracyBefore;
  const noLoss = afterScore.keptStable >= beforeScore.keptStable;
  const decided = accuracyImproved && noLoss && significance.significant;

  let verdict: string;
  if (!accuracyImproved) {
    verdict = `验证集上胜出候选未优于现任（决策准确率 ${pct(paired.accuracyBefore)} → ${pct(paired.accuracyAfter)}），维持现任判据`;
  } else if (!noLoss) {
    verdict = `决策准确率虽升（${pct(paired.accuracyBefore)} → ${pct(paired.accuracyAfter)}），但样本外稳定的绝对条数从 ${beforeScore.keptStable} 降到 ${afterScore.keptStable}——靠少采信换指标不算进步，维持现任判据`;
  } else if (!significance.significant) {
    verdict = `决策准确率 ${pct(paired.accuracyBefore)} → ${pct(paired.accuracyAfter)}，但配对差异未达显著（McNemar 不一致对 ${paired.b}:${paired.c}，双侧 p=${significance.pValue.toFixed(4)} ≥ ${DECISION_ALPHA}），维持现任判据`;
  } else {
    verdict = `决策准确率 ${pct(paired.accuracyBefore)} → ${pct(paired.accuracyAfter)}（McNemar 不一致对 ${paired.b}:${paired.c}，双侧 p=${significance.pValue.toFixed(4)} < ${DECISION_ALPHA}；采信 ${beforeScore.kept} → ${afterScore.kept} 条，其中稳定 ${beforeScore.keptStable} → ${afterScore.keptStable} 条），保留改动`;
  }
  if (tiedAtBest > 1) {
    verdict += `（另有 ${tiedAtBest - 1} 个候选在训练集上与它同分，按移动量最小取此者）`;
  }

  const record: ImprovementRecord | null = dryRun
    ? null
    : recordImprovement({
        target: 'factor-verdict-policy',
        basis,
        before: { ...incumbent },
        after: { ...best.policy },
        metric,
        significance,
        outcome: decided ? 'kept' : 'reverted',
        verdict,
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
      significance,
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

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** 现任判据是否就是出厂值（供状态接口如实披露"从未被改动过"） */
export function isFactoryPolicy(policy: HarnessPolicy): boolean {
  return policyKey(policy) === policyKey({ ...DEFAULT_HARNESS_POLICY });
}

/**
 * Harness 策略：可调的因子采信判据
 * ----------------------------------------------------------------------------
 * 背景（RSI · Recursive Self-Improvement 的落点）
 *
 * 论文《The Last AI Built by Humans》(arXiv:2609.11873) 把 RSI 定义为「把经验与
 * 反馈转化为**持久改动**」，并划出 L1–L5：L1 执行人给的改进方案，L2 自主寻找改进
 * 策略……本项目此前的因子采信判据（`judgeFactor` 的四个阈值）是**写死的常量**，
 * 于是「试了多少、活下来几个」的台账攒下来了，却没有任何机制把这份经验变成
 * 下一次判断方式的改动——缺的正是这一环。
 *
 * 本模块把那四个阈值从常量变成有来源、有边界、可回滚的持久状态：
 *   - 默认值与改造前**逐字一致**，未运行改进循环时线上行为完全不变；
 *   - 写入前必须过校验（越界一律拒绝，不接受「静默夹紧」——静默改值会让
 *     改进循环以为自己保留了一个策略，实际生效的是另一个）；
 *   - 与 factorLedger 同模式：单 JSON 文件 + env 重定向 + tmp+rename 原子写 +
 *     IO 静默降级（读失败回落默认值，绝不阻断分析主流程）。
 *
 * 这里只负责「策略是什么、怎么存」；「策略该不该改」由 improvementLoop 依据
 * 历史实验台账回放决定，改动与判定结果记在 improvementLedger 里。
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * 因子采信判据。
 *
 * 字段与 `judgeFactor` 的判定一一对应，改动任一项都会改变「哪些因子被采信」，
 * 因此每次改动都必须留下改前改后的指标（见 improvementLedger）。
 */
export interface HarnessPolicy {
  /** IC 最小有效样本期数：不足直接判无效（样本太少的显著性没有意义） */
  minIcSamples: number;
  /** 显著性水平：IC 的 p 值必须**严格小于**此值才算通过 */
  significanceLevel: number;
  /** 分档收益单调性下限：Spearman 秩相关须 ≥ 此值 */
  minMonotonicity: number;
  /** 是否要求多空价差为正（关闭后允许方向不成立的因子被采信，谨慎使用） */
  requirePositiveSpread: boolean;
}

/**
 * 出厂判据 —— 与 2026-09-19 之前 `judgeFactor` 里的硬编码值逐字一致：
 * `ic.n < 5` / `pValue >= 0.05` / `monotonicity < 0.6` / `spread <= 0`。
 *
 * 保留这份常量有两个用途：① 策略文件缺失/损坏时的回落基准；② 改进循环的
 * 「现任策略」基线——没有它，一次坏写入就可能把判据永久带偏且无从对照。
 */
export const DEFAULT_HARNESS_POLICY: Readonly<HarnessPolicy> = Object.freeze({
  minIcSamples: 5,
  significanceLevel: 0.05,
  minMonotonicity: 0.6,
  requirePositiveSpread: true,
});

/**
 * 取值边界。
 *
 * 改进循环是自动搜索，边界就是它的安全绳：没有边界时，一次搜索就可能把
 * 显著性水平推到 0.9（什么都采信）或把单调性下限推到 1.0（什么都不采信），
 * 而这两种退化都会让「采信集」失去意义。
 *   - 显著性上限 0.2：再宽就已经不是「显著」了；
 *   - 单调性下限上限 0.9：留出噪声容忍，1.0 在有限样本下几乎不可达。
 */
export const POLICY_BOUNDS = Object.freeze({
  minIcSamples: { min: 3, max: 60 },
  significanceLevel: { min: 0.001, max: 0.2 },
  minMonotonicity: { min: 0, max: 0.9 },
});

export interface PolicyValidation {
  ok: boolean;
  /** 逐条中文说明；ok 为 true 时为空数组 */
  errors: string[];
}

/** 校验策略：类型、有限性、区间、整数性（IC 样本期数必须是整数） */
export function validateHarnessPolicy(policy: unknown): PolicyValidation {
  const errors: string[] = [];
  if (!policy || typeof policy !== 'object') {
    return { ok: false, errors: ['策略必须是对象'] };
  }
  const p = policy as Record<string, unknown>;
  const num = (key: keyof HarnessPolicy, label: string, bounds: { min: number; max: number }) => {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${label}必须是有限数值`);
      return;
    }
    if (v < bounds.min || v > bounds.max) {
      errors.push(`${label}须在 [${bounds.min}, ${bounds.max}] 之间（当前 ${v}）`);
    }
  };
  num('minIcSamples', 'IC 最小样本期数', POLICY_BOUNDS.minIcSamples);
  num('significanceLevel', '显著性水平', POLICY_BOUNDS.significanceLevel);
  num('minMonotonicity', '单调性下限', POLICY_BOUNDS.minMonotonicity);
  if (typeof p.minIcSamples === 'number' && !Number.isInteger(p.minIcSamples)) {
    errors.push('IC 最小样本期数必须是整数');
  }
  if (typeof p.requirePositiveSpread !== 'boolean') {
    errors.push('「要求多空价差为正」必须是布尔值');
  }
  return { ok: errors.length === 0, errors };
}

/** 策略来源：出厂默认 / 已持久化（改进循环保留过改动） */
export type HarnessPolicySource = 'default' | 'stored';

export interface HarnessPolicyState {
  policy: HarnessPolicy;
  source: HarnessPolicySource;
  /** 落盘时间（source 为 default 时为 null） */
  updatedAt: string | null;
  /** 保留次数：改进循环每保留一次改动 +1（source 为 default 时为 0） */
  revision: number;
  /** 上一次改动的摘要（由改进循环写入，便于状态接口如实披露） */
  lastChange: string | null;
}

interface PolicyStore {
  policy: HarnessPolicy;
  updatedAt: string;
  revision: number;
  lastChange: string | null;
}

const DEFAULT_POLICY_FILE = path.join(import.meta.dirname, '..', 'data', 'harnessPolicy.json');

/** 策略文件路径（env 可重定向，测试隔离用） */
function getPolicyFile(): string {
  return process.env.HARNESS_POLICY_FILE && process.env.HARNESS_POLICY_FILE.length > 0
    ? process.env.HARNESS_POLICY_FILE
    : DEFAULT_POLICY_FILE;
}

/**
 * 模块级缓存（与 factorLedger 同范式）。
 * 不做 mtime 校验：本模块是策略文件的唯一写者；测试直接改写落盘文件后调用
 * resetHarnessPolicyCache() 即可重建。
 */
let cache: { file: string; state: HarnessPolicyState } | null = null;

/** 清空内存缓存（外部改写落盘文件后强制重读；测试隔离用） */
export function resetHarnessPolicyCache(): void {
  cache = null;
}

function defaultState(): HarnessPolicyState {
  return {
    policy: { ...DEFAULT_HARNESS_POLICY },
    source: 'default',
    updatedAt: null,
    revision: 0,
    lastChange: null,
  };
}

/**
 * 读当前策略。
 *
 * 任何异常（文件缺失、JSON 损坏、字段越界）都回落到出厂默认值——判据被读坏
 * 会让分析结果不可信，但让判据读取抛错会直接打断分析主流程，两害相权取前者。
 * 注意：损坏时**不写缓存**，下次调用重试读盘，避免一次瞬时读失败把默认值
 * 钉在内存里。
 */
export function getHarnessPolicyState(): HarnessPolicyState {
  const file = getPolicyFile();
  if (cache && cache.file === file) return cache.state;
  let store: PolicyStore | null = null;
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as PolicyStore;
      const check = validateHarnessPolicy(parsed?.policy);
      if (check.ok) {
        store = {
          policy: parsed.policy,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
          revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
          lastChange: typeof parsed.lastChange === 'string' ? parsed.lastChange : null,
        };
      }
    }
  } catch {
    return defaultState();
  }
  const state: HarnessPolicyState = store
    ? {
        policy: { ...store.policy },
        source: 'stored',
        updatedAt: store.updatedAt || null,
        revision: store.revision,
        lastChange: store.lastChange,
      }
    : defaultState();
  cache = { file, state };
  return state;
}

/** 只取策略本身（调用方不关心来源时用这个） */
export function getHarnessPolicy(): HarnessPolicy {
  return { ...getHarnessPolicyState().policy };
}

export interface ApplyPolicyResult {
  ok: boolean;
  errors: string[];
  state?: HarnessPolicyState;
}

/**
 * 写入策略（改进循环「保留改动」的唯一入口）。
 *
 * 校验不过一律拒绝并如实返回原因，**不做静默夹紧**：改进循环据返回值判断是否
 * 真的生效，静默改值会让它记录下一个并未生效的策略。
 * 写盘失败同样返回 ok=false —— 内存里生效而盘上没有，重启即丢失，属于假保留。
 */
export function applyHarnessPolicy(
  next: HarnessPolicy,
  meta: { lastChange?: string } = {},
): ApplyPolicyResult {
  const check = validateHarnessPolicy(next);
  if (!check.ok) return { ok: false, errors: check.errors };

  const prev = getHarnessPolicyState();
  const store: PolicyStore = {
    policy: { ...next },
    updatedAt: new Date().toISOString(),
    revision: prev.revision + 1,
    lastChange: meta.lastChange ?? prev.lastChange,
  };
  const file = getPolicyFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换：读者要么看到旧策略要么看到新策略，不会读到半截
  } catch (err) {
    cache = null;
    return { ok: false, errors: [`策略写入失败：${(err as Error).message}`] };
  }
  const state: HarnessPolicyState = {
    policy: { ...store.policy },
    source: 'stored',
    updatedAt: store.updatedAt,
    revision: store.revision,
    lastChange: store.lastChange,
  };
  cache = { file, state };
  return { ok: true, errors: [], state };
}

/** 恢复出厂判据（删掉策略文件并清缓存）；改进循环「回滚」的落地动作 */
export function resetHarnessPolicy(): void {
  const file = getPolicyFile();
  try {
    if (fs.existsSync(file)) fs.rmSync(file);
  } catch {
    // 删除失败不抛：调用方据 getHarnessPolicyState().source 判断是否真的回到默认
  }
  cache = null;
}

/**
 * 改进台账（Improvement Ledger）
 * ----------------------------------------------------------------------------
 * factorLedger 记的是「试过哪些因子」，本模块记的是**「改过哪些判断方式、依据是什么、
 * 改完有没有用」**——这是 RSI 与「跑得多」的分界线：只积累实验不改方法，是自我修正；
 * 把有效的方法改动留下来供后续继续用，才是递归自我改进（arXiv:2609.11873 的 L2→L4）。
 *
 * 每条记录必须能回答四个问题，缺一不可：
 *   1. 改了什么        —— before / after 两份完整策略（不是 diff 摘要，要能直接回滚）
 *   2. 凭什么改        —— basis：用了多少条带判据证据的历史记录、怎么切分
 *   3. 改完好了多少    —— metric：**验证集**上的精度变化，连同被采信数一起记
 *      （只看精度不看样本量会被「只采信 1 个因子且恰好蒙对」骗过去）
 *   4. 谁被否掉了      —— tried：本轮试过的全部候选，避免下一轮重复试探同一片区域
 *
 * 与 factorLedger 同模式：单 JSON 文件 + env 重定向 + 原子写 + 串行锁 + 容量淘汰 +
 * IO 静默降级（记不下改动**绝不**阻断分析主流程；台账是研究资产，不是数据源）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { HarnessPolicy } from './harnessPolicy.js';

/** 改进对象。目前只有因子采信判据；留成联合类型以便将来扩展（如筛选阈值、专家权重） */
export type ImprovementTarget = 'factor-verdict-policy';

/** 一轮改进的结局：保留（已落盘生效）或回滚（未生效，原因留痕） */
export type ImprovementOutcome = 'kept' | 'reverted';

/** 一个被评估过的候选策略 */
export interface TriedCandidate {
  policy: HarnessPolicy;
  /** 训练集得分（用于挑候选）；候选无法评分时为 null */
  trainScore: number | null;
  /** 验证集得分；非最终候选不评验证集时为 null */
  validationScore: number | null;
}

export interface ImprovementRecord {
  id: string;
  createdAt: string;
  target: ImprovementTarget;
  /** 依据：本轮用到多少经验、怎么切的训练/验证集 */
  basis: {
    /** 带完整判据证据、可参与回放的记录数 */
    evidenceCount: number;
    /** 其中训练集条数（较早的一段） */
    trainCount: number;
    /** 其中验证集条数（较新的一段） */
    validationCount: number;
    /** 切分口径的人可读说明 */
    split: string;
  };
  /** 改动前的策略（回滚基准） */
  before: HarnessPolicy;
  /** 本轮胜出的候选策略 */
  after: HarnessPolicy;
  /** 决策指标：在验证集上的「采信集样本外稳定占比」 */
  metric: {
    name: 'oos-precision';
    before: number;
    after: number;
    delta: number;
    /** 验证集上被采信的条数：精度必须连着样本量一起读 */
    keptBefore: number;
    keptAfter: number;
  };
  outcome: ImprovementOutcome;
  /** 中文判定说明，可直接展示给用户 */
  verdict: string;
  /** 本轮试过的全部候选（含被否的），用于避免重复试探 */
  tried: TriedCandidate[];
}

export type ImprovementRecordInput = Omit<ImprovementRecord, 'id' | 'createdAt'>;

interface LedgerStore {
  items: ImprovementRecord[];
}

const DEFAULT_LEDGER_FILE = path.join(import.meta.dirname, '..', 'data', 'improvements.json');

/**
 * 台账容量上限。改进循环每天最多一轮，500 条足够回溯一年多；
 * 超出后淘汰最旧记录（与 factorLedger 同口径）。
 */
export const MAX_IMPROVEMENT_ITEMS = 500;

let storeCache: { file: string; store: LedgerStore } | null = null;

/** 清空内存缓存（外部改写落盘文件后强制重读；测试隔离用） */
export function resetImprovementLedgerCache(): void {
  storeCache = null;
}

/**
 * 写入串行锁（与 factorLedger.withLedgerStoreLock 同范式）：
 * tmp+rename 只防半写、不防丢更新，本队列把「读-改-写」整段排成单进程内串行。
 */
let storeLock: Promise<void> = Promise.resolve();

export function withImprovementStoreLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const result = storeLock.then(() => fn());
  storeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function getLedgerFile(): string {
  return process.env.IMPROVEMENT_LEDGER_FILE && process.env.IMPROVEMENT_LEDGER_FILE.length > 0
    ? process.env.IMPROVEMENT_LEDGER_FILE
    : DEFAULT_LEDGER_FILE;
}

function readStore(): LedgerStore {
  const file = getLedgerFile();
  if (storeCache && storeCache.file === file) return storeCache.store;
  let store: LedgerStore;
  try {
    if (!fs.existsSync(file)) {
      store = { items: [] };
    } else {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as LedgerStore;
      store = parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
    }
  } catch {
    // 损坏/不可读 → 视为空台账（不阻断）。不写缓存：一次瞬时失败不该把「空台账」
    // 钉进内存，否则下一次写入会把整份历史覆盖为空。
    return { items: [] };
  }
  storeCache = { file, store };
  return store;
}

function writeStore(store: LedgerStore): boolean {
  const file = getLedgerFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    storeCache = { file, store };
    return true;
  } catch {
    storeCache = null; // 写失败：内存与落盘可能不一致，下次读盘重建
    return false;
  }
}

let seq = 0;
function makeId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 记录一轮改进。返回写入的记录；**写盘失败返回 null**（静默，不抛）。
 *
 * 与 factorLedger 的差别：那里写失败返回 []，这里返回 null 更好区分「没写」与
 * 「写了空」——一轮改进的结果是单个对象，没有「空批次」这种合法语义。
 */
export function recordImprovement(input: ImprovementRecordInput): ImprovementRecord | null {
  const store = readStore();
  const item: ImprovementRecord = { ...input, id: makeId(), createdAt: new Date().toISOString() };
  store.items = [item, ...store.items].slice(0, MAX_IMPROVEMENT_ITEMS);
  return writeStore(store) ? item : null;
}

/** 异步记录：把读-改-写整段排入串行队列 */
export function recordImprovementAsync(
  input: ImprovementRecordInput,
): Promise<ImprovementRecord | null> {
  return withImprovementStoreLock(() => recordImprovement(input));
}

/** 查询改进历史（按时间倒序） */
export function listImprovements(limit = 50): ImprovementRecord[] {
  const items = [...readStore().items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const n = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  return items.slice(0, n);
}

/**
 * 改进台账概览。
 *
 * `triedValues` 是负结果复用的抓手：把历史试过的候选序列化成可比对的键，
 * 下一轮生成候选时据此跳过——没有它，自动搜索会在同一片区域反复打转，
 * 看起来天天在改进，实际每次都得出同一个结论。
 */
export function summarizeImprovements(): {
  total: number;
  kept: number;
  reverted: number;
  lastAt: string | null;
  /** 历史试过的候选键（去重）；每轮搜索据此跳过已知候选 */
  triedValues: string[];
  /** 最近一次成功保留的改动时间 */
  lastKeptAt: string | null;
} {
  const items = readStore().items;
  const kept = items.filter((i) => i.outcome === 'kept');
  const tried = new Set<string>();
  for (const it of items) {
    for (const c of it.tried ?? []) tried.add(policyKey(c.policy));
  }
  const sorted = [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return {
    total: items.length,
    kept: kept.length,
    reverted: items.length - kept.length,
    lastAt: sorted.length > 0 ? sorted[0].createdAt : null,
    triedValues: [...tried],
    lastKeptAt:
      kept.length > 0
        ? kept
            .map((i) => i.createdAt)
            .sort()
            .reverse()[0]
        : null,
  };
}

/** 策略的可比对键（用于「这个候选试过了吗」）。浮点按固定精度归一，避免 0.05 与 0.050000001 被当成两个 */
export function policyKey(p: HarnessPolicy): string {
  const f = (v: number) => Number(v.toFixed(4)).toString();
  return `${p.minIcSamples}|${f(p.significanceLevel)}|${f(p.minMonotonicity)}|${p.requirePositiveSpread ? 1 : 0}`;
}

/** 清空台账（测试隔离用） */
export function clearImprovements(): void {
  writeStore({ items: [] });
}

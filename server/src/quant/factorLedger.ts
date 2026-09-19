/**
 * 因子实验台账（Factor Experiment Ledger）
 * ------------------------------------------------------------------
 * RD-Agent(Q) 最有价值的不是模型，而是它把「假设 → 实现 → 回测 → 结论」每一步
 * 都留痕，于是研究有了复利：看得到试过多少、活下来几个。本项目此前缺这一层——
 * 因子评估完就散在响应里，下次重跑无从对照。
 *
 * 本模块提供极简落盘台账（与 historyService 同模式：单 JSON 文件 + env 重定向 +
 * 原子写入 + 容量淘汰 + IO 静默降级）。**记录失败绝不阻断主流程**——台账是
 * 研究资产，不是数据源。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 假设来源：截面标准因子 / 自定义表达式 / LLM 生成的假设 */
export type FactorExperimentSource = 'cross-section' | 'expression' | 'hypothesis';

/**
 * 判据输入留痕。
 *
 * 「用历史经验调判据」（改进循环）要求台账记得住**当时据以判定的原始数值**。
 * 此前只落了 pValue 与 oosStable，单调性与多空价差没存，于是历史记录无法回放——
 * 攒再多实验也调不动判据。新增本块后，凡带本块的记录都能参与回放；
 * 旧记录缺此块，回放时**跳过**（不猜、不补默认值，宁可样本变少也不造假数据）。
 */
export interface FactorJudgementEvidence {
  /** IC 有效样本期数 */
  icN: number;
  /** 分档数 */
  quantileRows: number;
  /** 分档收益单调性 ∈ [−1,1] */
  monotonicity: number;
  /** 多空价差（小数） */
  spread: number;
}

/** 一条实验记录 = 因子 × 持有期（一次评估内多个因子/窗口会拆成多条） */
export interface FactorExperiment {
  id: string;
  createdAt: string;
  source: FactorExperimentSource;
  /** 因子名（标准因子）或自定义因子名 */
  name: string;
  /** 自定义表达式原文（source 为 expression/hypothesis 时必有） */
  expression?: string;
  universe: {
    /** 板块代码（board 来源） */
    board?: string;
    /** 显式股票代码（codes 来源） */
    codes?: string[];
    requested: number;
    /** 实际入组股票数 */
    included: number;
  };
  /** 持有期（交易日） */
  horizon: number;
  /** 样本量（观测数） */
  sampleSize: number;
  /** 截面 IC 均值 */
  icMean: number;
  /** IC 显著性 p 值 */
  pValue: number;
  /** 样本外是否稳定 */
  oosStable: boolean;
  /** 是否采信（与 judgeFactor 同口径） */
  kept: boolean;
  /**
   * 判据输入（旧记录缺省）。改进循环只回放带本块的记录。
   */
  evidence?: FactorJudgementEvidence;
  /** 备注（如跳过原因、降级说明） */
  notes?: string;
}

export interface FactorExperimentInput extends Omit<FactorExperiment, 'id' | 'createdAt'> {}

interface LedgerStore {
  items: FactorExperiment[];
}

const DEFAULT_LEDGER_FILE = path.join(import.meta.dirname, '..', 'data', 'factorExperiments.json');
/** 台账容量上限：超出后淘汰最旧记录 */
export const MAX_LEDGER_ITEMS = 500;

/**
 * 模块级内存 store（单进程单写者）：读走内存、写后更新缓存。
 * 动机：GET /api/quant/factor/experiments 连续调用 listFactorExperiments() 与
 * summarizeFactorExperiments()，两者各自 readStore()，台账满额（500 条 / 241KB）时
 * 每次 ≈ 2.0ms × 2 白花在解析上；现在第二次调用直接命中缓存。
 * 不做 mtime 校验——本模块是台账文件的唯一写者；测试夹具直接改写落盘文件后
 * 调用 clearFactorExperiments() 或 resetFactorLedgerCache() 即可重建缓存。
 */
let storeCache: { file: string; store: LedgerStore } | null = null;

/** 清空内存缓存（外部直接改写了落盘文件后强制重读；测试隔离用） */
export function resetFactorLedgerCache(): void {
  storeCache = null;
}

/**
 * 台账写入串行锁（与 services/outcomeTracker.ts 的 withStoreLock 同范式）。
 * ----------------------------------------------------------------------------
 * recordFactorExperiments 是「readStore → 改 → writeStore」的读-改-写：writeStore 的
 * tmp+rename 只防半写，**不防丢更新**。当前实现整段同步（JS 单线程内不会被别的回调打断），
 * 但它是异步 HTTP 处理器链上的收尾动作，一旦中间出现 await（或将来改成异步 IO），
 * 并发调用会各自读到同一份旧文件后整体覆盖，最多 MAX_LEDGER_ITEMS 条实验记录静默消失，
 * 而两边响应都声称写入成功。此队列把「读-改-写」整段排成单进程内串行。
 */
let storeLock: Promise<void> = Promise.resolve();

/**
 * 把一段台账读-改-写排入串行队列（异步调用方可直接使用）。
 * 无论成功失败都续上队列，避免一次异常让后续写入永久挂起。
 */
export function withLedgerStoreLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const result = storeLock.then(() => fn());
  storeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function getLedgerFile(): string {
  return process.env.FACTOR_LEDGER_FILE && process.env.FACTOR_LEDGER_FILE.length > 0
    ? process.env.FACTOR_LEDGER_FILE
    : DEFAULT_LEDGER_FILE;
}

function readStore(): LedgerStore {
  const file = getLedgerFile();
  if (storeCache && storeCache.file === file) return storeCache.store; // 缓存命中：不读盘
  let store: LedgerStore;
  try {
    if (!fs.existsSync(file)) {
      store = { items: [] };
    } else {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as LedgerStore;
      store = parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
    }
  } catch {
    // 文件损坏/不可读：视为空台账（不阻断）。不写缓存：一次瞬时读失败不该把「空台账」
    // 钉在内存里（否则下一次写入会把整份台账覆盖为空），下次调用重试读盘。
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
    fs.renameSync(tmp, file); // 原子替换，避免半写状态（tmp+rename 只防半写，不防丢更新，见上方串行锁）
    storeCache = { file, store }; // 写后更新缓存：后续读直接命中内存
    return true;
  } catch {
    storeCache = null; // 写失败：缓存与落盘可能不一致，下次读盘重建
    return false;
  }
}

let seq = 0;
function makeId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 批量记录实验结果（单次读盘 + 单次写盘，避免逐个因子反复重写文件）。
 * 返回实际写入的条目；写盘失败返回 []（静默，不阻断调用方）。
 *
 * 向后兼容：保持同步签名。同步函数体内的读-改-写不会被 JS 单线程打断，
 * 因此本入口本身即原子；需要与其他 await 交错、或与其他锁定段互斥的异步调用方，
 * 请用 recordFactorExperimentsAsync()（同一队列）。
 */
export function recordFactorExperiments(inputs: FactorExperimentInput[]): FactorExperiment[] {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  return recordFactorExperimentsUnsafe(inputs);
}

/**
 * 异步记录：把「readStore → 改 → writeStore」整段排入模块级串行队列。
 * 供异步处理器/脚本使用——并发调用不会各自基于同一份旧台账整体覆盖（见上方锁的说明）。
 */
export function recordFactorExperimentsAsync(
  inputs: FactorExperimentInput[],
): Promise<FactorExperiment[]> {
  if (!Array.isArray(inputs) || inputs.length === 0) return Promise.resolve([]);
  return withLedgerStoreLock(() => recordFactorExperimentsUnsafe(inputs));
}

/** 读-改-写核心（调用方负责持有锁或保证同步原子性） */
function recordFactorExperimentsUnsafe(inputs: FactorExperimentInput[]): FactorExperiment[] {
  const store = readStore();
  const createdAt = new Date().toISOString();
  const added = inputs.map((input) => ({ ...input, id: makeId(), createdAt }));
  store.items = [...added, ...store.items].slice(0, MAX_LEDGER_ITEMS);
  return writeStore(store) ? added : [];
}

/**
 * 时间倒序比较器。
 *
 * **必须对相等键返回 0**：写成 `a.createdAt < b.createdAt ? 1 : -1` 时，同毫秒写入的
 * 两条记录会让 compare(a,b) 与 compare(b,a) 都返回 -1——违反排序契约，顺序由引擎实现
 * 决定。改进台账那边正是因此被 CI 抓出「本地绿、CI 红」（2026-09-19）；此处的写法与之
 * 同源，一并修正。返回 0 后由稳定排序保持数组原序，而台账数组是**新在前**，故同毫秒内
 * 的先后即写入先后——这也让改进循环的「较早 70% 训练 / 较新 30% 验证」切分变得确定。
 */
function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt < b.createdAt ? 1 : -1;
}

/** 查询实验台账（按时间倒序）；可按来源/采信状态过滤 */
export function listFactorExperiments(
  filter: { source?: FactorExperimentSource; kept?: boolean; limit?: number } = {},
): FactorExperiment[] {
  let items = [...readStore().items].sort(byCreatedAtDesc);
  if (filter.source) items = items.filter((i) => i.source === filter.source);
  if (filter.kept !== undefined) items = items.filter((i) => i.kept === filter.kept);
  const limit = Number.isFinite(filter.limit) ? Math.max(1, Math.floor(filter.limit!)) : 100;
  return items.slice(0, limit);
}

/** 台账概览：总量、采信数、按来源分组、最近一次实验时间、采信集的诚实折扣 */
export function summarizeFactorExperiments(): {
  total: number;
  kept: number;
  bySource: Record<string, number>;
  lastAt: string | null;
  /**
   * 采信集的期望假阳性数**上界** = 采信数 × 0.05（采信判据的显著性水平，
   * 与 judgeFactor 的 p<0.05 同口径）。最坏情形是「采信集全部为真原假设」，
   * 此时按水平 0.05 逐条检验的期望假阳性恰为 kept × 0.05——这是频率学派
   * 能给出的严格界；此前用 ΣpValue 当「期望假发现」是错的（p 值是
   * P(数据这样极端 | H0)，不是 P(H0 | 被采信)，Σp 没有可解释含义）。
   * 单次评估的 Holm 校正只控制当次家族，这里补上「全历史试错」维度的诚实折扣。
   */
  keptExpectedFalse: number;
  /** 采信集中 OOS 稳定的占比（方向与显著性双双跨段成立的口径） */
  keptOosShare: number;
} {
  const items = readStore().items;
  const bySource: Record<string, number> = {};
  for (const it of items) bySource[it.source] = (bySource[it.source] ?? 0) + 1;
  const kept = items.filter((i) => i.kept);
  // 期望假阳性上界 = 采信数 × 0.05（最坏情形：采信集全部为真原假设）
  const expectedFalse = kept.length * 0.05;
  return {
    total: items.length,
    kept: kept.length,
    bySource,
    lastAt: items.length > 0 ? items[0].createdAt : null,
    keptExpectedFalse: Math.round(expectedFalse * 100) / 100,
    keptOosShare:
      kept.length > 0
        ? Math.round((kept.filter((i) => i.oosStable).length / kept.length) * 100) / 100
        : 0,
  };
}

/** 清空台账（供测试隔离）；同时刷新内存缓存（writeStore 成功后缓存即新空台账） */
export function clearFactorExperiments(): void {
  writeStore({ items: [] });
}

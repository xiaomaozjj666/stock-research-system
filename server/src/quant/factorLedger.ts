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

function getLedgerFile(): string {
  return process.env.FACTOR_LEDGER_FILE && process.env.FACTOR_LEDGER_FILE.length > 0
    ? process.env.FACTOR_LEDGER_FILE
    : DEFAULT_LEDGER_FILE;
}

function readStore(): LedgerStore {
  try {
    const file = getLedgerFile();
    if (!fs.existsSync(file)) return { items: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as LedgerStore;
    return parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeStore(store: LedgerStore): boolean {
  try {
    const file = getLedgerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
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
 */
export function recordFactorExperiments(inputs: FactorExperimentInput[]): FactorExperiment[] {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const store = readStore();
  const createdAt = new Date().toISOString();
  const added = inputs.map((input) => ({ ...input, id: makeId(), createdAt }));
  store.items = [...added, ...store.items].slice(0, MAX_LEDGER_ITEMS);
  return writeStore(store) ? added : [];
}

/** 查询实验台账（按时间倒序）；可按来源/采信状态过滤 */
export function listFactorExperiments(
  filter: { source?: FactorExperimentSource; kept?: boolean; limit?: number } = {},
): FactorExperiment[] {
  let items = [...readStore().items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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
   * 采信集的期望假阳性数 ≈ Σ pValue（被采信实验的 p 值之和）。
   * FDR 视角：每条被采信的实验仍有约 p 的概率是「纯运气的显著」——50 条 p≈0.03
   * 的采信实验里期望混着 ~1.5 条假发现。单次评估的 Holm 校正只控制当次家族，
   * 这里补上「全历史试错」维度的诚实折扣。
   */
  keptExpectedFalse: number;
  /** 采信集中 OOS 稳定的占比（方向与显著性双双跨段成立的口径） */
  keptOosShare: number;
} {
  const items = readStore().items;
  const bySource: Record<string, number> = {};
  for (const it of items) bySource[it.source] = (bySource[it.source] ?? 0) + 1;
  const kept = items.filter((i) => i.kept);
  // 期望假阳性 = 各采信实验 p 值之和（p 越小的采信越"贵"，污染越少）
  const expectedFalse = kept.reduce((s, i) => s + (Number.isFinite(i.pValue) ? i.pValue : 0), 0);
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

/** 清空台账（供测试隔离） */
export function clearFactorExperiments(): void {
  writeStore({ items: [] });
}

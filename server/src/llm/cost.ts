/**
 * LLM 成本治理（轻量、内存态）
 * ----------------------------------------------------------------------------
 * 记录每次调用的 token 用量与估算成本，供多模型路由与预算护栏使用。
 * 纯内存；无持久化（重启即清零）。测试可调用 resetCostTracker 隔离。
 *
 * 容量：内存只保留最近 COST_LEDGER_MAX_ENTRIES 条（默认 5000），更早的条目在淘汰时
 * 把用量并入累计值，故 getCostReport 仍是**生命周期累计**口径——长期运行既不会无界
 * 增长，账面总额也不会随时间"缩水"。
 */
export interface CostEntry {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  at: number;
  task?: string;
}

const entries: CostEntry[] = [];

/** 台账默认容量上限（条）：超限按时间淘汰最旧（COST_LEDGER_MAX_ENTRIES 可覆盖） */
const COST_LEDGER_MAX_DEFAULT = 5000;

/**
 * 当前容量上限：每次调用时解析（便于测试与运行期调整），
 * 非法值（非数字 / 小于 1）回退默认——与 watchlistBatchMax() 同一 env 解析口径。
 */
export function costLedgerMax(): number {
  const raw = Number(process.env.COST_LEDGER_MAX_ENTRIES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : COST_LEDGER_MAX_DEFAULT;
}

/**
 * 已被容量上限淘汰条目的累计值（与 CostReport 同形，便于直接作为报告基数）。
 * 为什么不能"只截断 entries"：getCostReport 的 totalCost / callCount / byModel 是
 * **生命周期累计**口径（/api/cost 面板、Prometheus 指标与预算护栏都直接消费它），
 * 若截断后只统计保留窗口，账面总额会随运行时长悄悄"缩水"，比内存膨胀更危险。
 * 故淘汰时把该条目的用量累加到这里，报告口径与未加上限时完全一致。
 */
const evictedTotals: CostReport = {
  totalCost: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  callCount: 0,
  byModel: {},
};

/** 记录一次用量并返回该条目（cost 由调用方按模型单价计算后传入，或传 0 表示未知） */
export function recordUsage(
  model: string,
  promptTokens: number,
  completionTokens: number,
  opts: { cost?: number; task?: string } = {},
): CostEntry {
  const entry: CostEntry = {
    model,
    promptTokens,
    completionTokens,
    cost: opts.cost ?? 0,
    at: Date.now(),
    task: opts.task,
  };
  entries.push(entry);

  // 容量上限：entries 按写入顺序递增时间，超限即从头部（最旧）淘汰一批，
  // 并把它们的用量并入累计值，保证 getCostReport 仍是生命周期口径
  const max = costLedgerMax();
  if (entries.length > max) {
    for (const dropped of entries.splice(0, entries.length - max)) {
      evictedTotals.totalCost += dropped.cost;
      evictedTotals.totalPromptTokens += dropped.promptTokens;
      evictedTotals.totalCompletionTokens += dropped.completionTokens;
      evictedTotals.callCount += 1;
      const agg = (evictedTotals.byModel[dropped.model] ||= { cost: 0, calls: 0 });
      agg.cost += dropped.cost;
      agg.calls += 1;
    }
  }
  return entry;
}

/**
 * 当前内存中保留的台账条目（按时间升序的副本）。
 * 用途：观测/测试"留存了多少条"，累计口径请用 getCostReport（含已淘汰部分）。
 */
export function getRetainedEntries(): CostEntry[] {
  return entries.map((e) => ({ ...e }));
}

export interface CostReport {
  totalCost: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  callCount: number;
  byModel: Record<string, { cost: number; calls: number }>;
}

export function getCostReport(): CostReport {
  // 基数取"已淘汰条目的累计值"，再叠加当前保留的条目 → 与未加上限时口径一致
  const byModel: Record<string, { cost: number; calls: number }> = {};
  for (const [model, agg] of Object.entries(evictedTotals.byModel)) {
    byModel[model] = { cost: agg.cost, calls: agg.calls };
  }
  let totalCost = evictedTotals.totalCost;
  let totalPromptTokens = evictedTotals.totalPromptTokens;
  let totalCompletionTokens = evictedTotals.totalCompletionTokens;
  let callCount = evictedTotals.callCount;
  for (const e of entries) {
    totalCost += e.cost;
    totalPromptTokens += e.promptTokens;
    totalCompletionTokens += e.completionTokens;
    const agg = (byModel[e.model] ||= { cost: 0, calls: 0 });
    agg.cost += e.cost;
    agg.calls += 1;
    callCount += 1;
  }
  return {
    totalCost: Math.round(totalCost * 1e6) / 1e6,
    totalPromptTokens,
    totalCompletionTokens,
    callCount,
    byModel,
  };
}

/** 测试/重置用 */
export function resetCostTracker(): void {
  entries.length = 0;
  // 累计值必须一并清零，否则"重置"后报告仍带着上一轮的淘汰量
  evictedTotals.totalCost = 0;
  evictedTotals.totalPromptTokens = 0;
  evictedTotals.totalCompletionTokens = 0;
  evictedTotals.callCount = 0;
  evictedTotals.byModel = {};
}

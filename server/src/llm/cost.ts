/**
 * LLM 成本治理（轻量、内存态）
 * ----------------------------------------------------------------------------
 * 记录每次调用的 token 用量与估算成本，供多模型路由与预算护栏使用。
 * 纯内存；无持久化（重启即清零）。测试可调用 resetCostTracker 隔离。
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
  return entry;
}

export interface CostReport {
  totalCost: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  callCount: number;
  byModel: Record<string, { cost: number; calls: number }>;
}

export function getCostReport(): CostReport {
  const byModel: Record<string, { cost: number; calls: number }> = {};
  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  for (const e of entries) {
    totalCost += e.cost;
    totalPromptTokens += e.promptTokens;
    totalCompletionTokens += e.completionTokens;
    const agg = (byModel[e.model] ||= { cost: 0, calls: 0 });
    agg.cost += e.cost;
    agg.calls += 1;
  }
  return {
    totalCost: Math.round(totalCost * 1e6) / 1e6,
    totalPromptTokens,
    totalCompletionTokens,
    callCount: entries.length,
    byModel,
  };
}

/** 测试/重置用 */
export function resetCostTracker(): void {
  entries.length = 0;
}

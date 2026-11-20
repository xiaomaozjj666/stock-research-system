/**
 * 进程内「昂贵操作并发闸」。
 * ----------------------------------------------------------------------------
 * 限流器（express-rate-limit）按客户端/IP 计，管不住**并发**：脚本多开、或同一个
 * 用户连点，就能让全市场扫描/批量表达式同时跑 N 份——它们共享上游配额与 CPU，
 * 叠加后果是上游 429 雪崩与请求互相拖慢。深度研究入口（routes/research.ts）早有
 * MAX_CONCURRENT_RUNS=2 的范式，本模块把它抽成可复用的小闸。
 *
 * 用法：
 *   const release = tryAcquireGate('screener', 2);
 *   if (!release) return res.status(429).json({ error: '…', retryAfterSeconds: 30 });
 *   try { … } finally { release(); }
 *
 * 语义：名字隔离、按进程计数（单机单进程部署；cluster/多实例下各算各的）、
 * release 幂等（重复调用不会把计数击穿成负数）。纯内存、无副作用。
 */

const counts = new Map<string, number>();

/**
 * 尝试占用一个名额。
 * @returns 释放函数（幂等）；已满时返回 null（调用方应回 429）
 */
export function tryAcquireGate(name: string, max: number): (() => void) | null {
  const limit = Math.max(1, Math.floor(max));
  const current = counts.get(name) ?? 0;
  if (current >= limit) return null;
  counts.set(name, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    counts.set(name, Math.max(0, (counts.get(name) ?? 1) - 1));
  };
}

/** 当前占用数（观测/测试用） */
export function gateActive(name: string): number {
  return counts.get(name) ?? 0;
}

/** 测试用：复位全部闸门计数（避免跨用例污染） */
export function resetGates(): void {
  counts.clear();
}

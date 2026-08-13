/**
 * 有界并发映射（mapWithConcurrency）
 * ------------------------------------------------------------------
 * 与 Promise.all 不同：限制同时进行的异步 worker 数量，避免对下游
 * （行情接口 / 新闻抓取 / 策略回测）瞬时打满。结果按输入顺序返回，
 * 便于调用方按代码对齐。worker 内部抛错会向上传递，由调用方捕获。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  // limit 非法（NaN/负无穷）时钳制为 1：Math.floor(NaN)=NaN → Math.max(1,NaN)=NaN，
  // 会传导到 Array.from({length:NaN}) 抛 RangeError（曾是真崩溃点）
  const floorLimit = Math.floor(limit);
  const safeLimit = Number.isFinite(floorLimit) ? Math.max(1, floorLimit) : 1;
  const results = new Array<R>(n);
  let cursor = 0;

  async function runNext(): Promise<void> {
    while (cursor < n) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from({ length: Math.min(safeLimit, n) }, () => runNext());
  await Promise.all(runners);
  return results;
}

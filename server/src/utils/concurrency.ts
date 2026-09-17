/**
 * 有界并发映射（mapWithConcurrency）
 * ------------------------------------------------------------------
 * 与 Promise.all 不同：限制同时进行的异步 worker 数量，避免对下游
 * （行情接口 / 新闻抓取 / 策略回测）瞬时打满。结果按输入顺序返回，
 * 便于调用方按代码对齐。worker 内部抛错会向上传递，由调用方捕获。
 *
 * 失败语义（P1 修复）：**首个 worker 失败即整体收手**，不是「谁先 reject 谁赢、
 * 其余继续在后台烧上游配额」。此前实现是 `await Promise.all(runners)`：Promise.all
 * 在第一个 rejection 立刻返回，但其余 runner 仍停在 `await worker(...)` 上继续跑，
 * 调用方已按失败处理（HTTP 已 500），后台却还在打行情/新闻上游，且这些 runner 后续的
 * rejection 无人 await（unhandled rejection）。现在的做法：
 *   1. 内部自建 AbortController，把「调用方中止」与「首个 worker 失败」合并成一个信号；
 *   2. 该信号作为 worker 的第 3 个参数传入（如 fetch(url, { signal })，取消沿调用链
 *      级联到 socket 级），在途 worker 可据此提前收手；
 *   3. 首个失败后不再派发新任务，runner 的 rejection 全部在内部消化（不会有人漏 await），
 *      最后把**首个错误**原样抛出（保持既有调用方的 catch 语义）。
 *
 * 签名向后兼容：worker 的第 3 个参数是**新增可选**的，既有的两参 worker 照旧可用
 * （多余的实参被忽略）；options.signal 的既有语义（预置位则不派发任何任务）不变。
 */
export interface MapWithConcurrencyOptions {
  /** 中止信号：置位后不再派发新任务并以 abort 原因整体拒绝；
   * 在途任务由其自身响应信号（如 fetch 抛 AbortError）后收尾 */
  signal?: AbortSignal;
}

/** worker：第 3 个参数是本轮调用的合并中止信号（首个兄弟任务失败时也会置位） */
export type MapWorker<T, R> = (item: T, index: number, signal: AbortSignal) => Promise<R>;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: MapWorker<T, R>,
  options: MapWithConcurrencyOptions = {},
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  // limit 非法（NaN/负无穷）时钳制为 1：Math.floor(NaN)=NaN → Math.max(1,NaN)=NaN，
  // 会传导到 Array.from({length:NaN}) 抛 RangeError（曾是真崩溃点）
  const floorLimit = Math.floor(limit);
  const safeLimit = Number.isFinite(floorLimit) ? Math.max(1, floorLimit) : 1;
  const results = new Array<R>(n);
  let cursor = 0;

  const external = options.signal;
  const abortError = (): Error =>
    external?.reason instanceof Error ? external.reason : new Error('已中止');
  // 预置位的 signal：不派发任何任务，直接以 abort 原因拒绝（既有语义）
  if (external?.aborted) throw abortError();

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(abortError());
  external?.addEventListener('abort', onExternalAbort, { once: true });
  const signal = controller.signal;

  let failed = false;
  let firstError: unknown;
  // 首个失败的「即刻返回」通道：runner 自消化异常后由它唤醒外层，
  // 既保持调用方早返回的既有语义，又不让其余 runner 继续在后台派发新任务。
  let signalFirstFailure: (error: unknown) => void = () => {};
  const firstFailure = new Promise<never>((_resolve, reject) => {
    signalFirstFailure = reject;
  });

  async function runNext(): Promise<void> {
    try {
      while (cursor < n) {
        // 已中止（调用方取消，或某个 worker 已失败）→ 不再拉取新任务
        if (signal.aborted) throw signal.reason;
        const i = cursor++;
        results[i] = await worker(items[i], i, signal);
      }
    } catch (e) {
      // 自消化：runner 永不向外 reject（否则 Promise.all 之后仍会有无人 await 的 rejection）；
      // 只记住首个错误并置位信号，让在途 worker 收手
      if (!failed) {
        failed = true;
        firstError = e;
        controller.abort(e);
        signalFirstFailure(e);
      }
    }
  }

  try {
    const runners = Array.from({ length: Math.min(safeLimit, n) }, () => runNext());
    // 等「全部完成」或「首个失败」：失败时立刻返回，不阻塞在尚未收手的在途 worker 上
    await Promise.race([Promise.all(runners), firstFailure]);
  } finally {
    // 摘除对外部 signal 的监听，避免长期持有调用方对象
    external?.removeEventListener('abort', onExternalAbort);
  }

  if (failed) throw firstError;
  return results;
}

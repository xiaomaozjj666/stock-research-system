/**
 * 限时包装：超时就 reject，并**真正取消**上游（当调用方交出 AbortController 时）。
 * index.ts、analysisPipeline.ts、watchlistBacktest.ts 均从本模块导入，
 * 避免 copy-paste 重复定义。
 *
 * 为什么必须能取消：只 race 不取消时，调用方已按「失败」降级处理，而底层 fetch / 流
 * 仍在后台跑完——上游 socket 与（LLM 场景下的）并发配额一直被占着，超时越频繁占用越久。
 * LLM 客户端路径已在 client.ts 里用 attempt controller 修好；这里把同一语义
 * 下沉到通用工具，供其它持有 AbortController 的调用方接入。
 *
 * 注意只能传 **controller** 而不是 signal：AbortSignal 是只读的，拿到 signal
 * 也无法让它 aborted——真正能取消的句柄只有 AbortController（见 client.ts 的
 * `onAttempt` 用法）。`signal` 选项仅用于「调用方只有 signal」的场合，做取消识别。
 *
 * 调用方自行持有 controller 的写法：
 *   const c = new AbortController();
 *   await withTimeout(fetch(url, { signal: c.signal }).then((r) => r.json()), 5000, {
 *     controller: c,
 *   });
 * 没有 controller 的旧调用点（如 analysisPipeline 里直接 await 的服务函数）保持
 * 两参调用，行为与从前完全一致（仅超时错误信息更明确）。
 */

export interface WithTimeoutOptions {
  /**
   * 上游请求的 AbortController（首选）：超时时 abort() 它，
   * 从而真正断开底层请求 / 流，而不只是让调用方这边提前失败。
   */
  controller?: AbortController;
  /**
   * 仅持有 signal 的调用方（如 AbortSignal.any 组合出来的信号）：
   * 用于识别「调用方已取消」并把取消原因原样透传。
   * 注意它**无法**被本模块 abort——想靠超时取消上游，请改传 controller。
   */
  signal?: AbortSignal;
  /** 超时已 abort 之后的回调：供调用方记账、打点或补充日志 */
  onTimeout?: () => void;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  opts: WithTimeoutOptions = {},
): Promise<T> {
  const { controller, onTimeout } = opts;
  const signal = opts.signal ?? controller?.signal;

  // 调用方已经取消：底层 promise 会以自己的取消原因（AbortError）结束，
  // 这里不再起定时器——否则会把「用户取消」误报成「超时」。
  if (signal?.aborted) return promise;

  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (fn: (v: never) => void, value: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value as never);
    };

    const timer = setTimeout(() => {
      // 先落定再 abort：abort 会**同步**触发下面的 abort 监听器，
      // 顺序反过来时本次超时会被监听器改写成「调用方取消」。
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller?.abort();
      // onTimeout 是调用方的记账钩子：它抛错也不能把「超时」变成永不落定的 promise
      try {
        onTimeout?.();
      } catch {
        // 有意吞掉：超时语义优先
      }
      reject(new Error(`timeout: ${ms}ms 未完成`));
    }, ms);

    const onAbort = () => {
      // 外部取消（不是本次超时）：原样透传取消原因，不吞成超时错误
      settle(reject, signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (v) => settle(resolve, v),
      (e) => settle(reject, e),
    );
  });
}

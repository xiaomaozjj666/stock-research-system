/**
 * 限时包装：超时就 reject，并**真正取消**上游（当调用方交出 AbortController 时）。
 * index.ts、analysisPipeline.ts、watchlistBacktest.ts 均从本模块导入，
 * 避免 copy-paste 重复定义。
 *
 * 两种用法按「上游函数是否接受 signal」二选一：
 *  - 上游接受 signal → 用 withAbortableTimeout((signal) => upstream(signal), ms, opts)：
 *    本模块替你建 controller 并把「超时」与「调用方取消」两个来源合并成一个 signal，
 *    超时能真正级联到 socket 级。**新代码首选这种。**
 *  - 上游不接受 signal（如共享磁盘缓存的 provider）→ 只能用 withTimeout，
 *    此时要清楚「超时只让调用方提前失败，上游仍在跑」并自行确认上游有硬上限。
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
  /** 自定义超时错误信息（默认 `timeout: ${ms}ms 未完成`）；调用方有更具体的措辞时使用 */
  message?: string;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  opts: WithTimeoutOptions = {},
): Promise<T> {
  const { controller, onTimeout, message } = opts;
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
      reject(new Error(message ?? `timeout: ${ms}ms 未完成`));
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

/** withAbortableTimeout 的选项（比 withTimeout 少了 controller：本模块自建，调用方拿不到也不需要） */
export interface AbortableTimeoutOptions {
  /**
   * 调用方的取消信号（批次中止 / 客户端断开 / 上层限时）：置位后**连上游一起取消**，
   * 并以它的 reason 拒绝——不会被误报成超时。
   */
  signal?: AbortSignal;
  /** 超时已 abort 之后的回调：供调用方记账、打点或补充日志 */
  onTimeout?: () => void;
  /** 自定义超时错误信息（默认 `timeout: ${ms}ms 未完成`） */
  message?: string;
}

/**
 * 限时包装（可取消上游）：把「本次超时」与「调用方取消」合并成一个 signal 交给上游，二者
 * 任一置位都能级联到 socket 级，不再出现「调用方已按超时降级、底层 fetch 还在跑完」的空烧。
 *
 * 与 withTimeout 的分工：withTimeout 收的是一个**已经创建**的 Promise，拿不到 signal 时
 * 无从取消；本函数收的是**惰性工厂** `run(signal)`，因此能在出发前就把 signal 交出去。
 *
 * 与 withTimeout 的一处刻意差异：调用方 signal 已置位时**不调用 run**，直接以取消原因拒绝。
 * withTimeout 那边 promise 已经创建、收不回来，只能原样返回；这里 run 尚未执行，
 * 少打一次注定白烧的上游（批量取消后每只股票都少一次网络往返）。
 */
export function withAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  opts: AbortableTimeoutOptions = {},
): Promise<T> {
  const outer = opts.signal;
  if (outer?.aborted) return Promise.reject(outer.reason ?? new Error('aborted'));

  const controller = new AbortController();
  // 合并而非二选一：超时要能取消上游，调用方取消也要能取消上游
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  let pending: Promise<T>;
  try {
    pending = run(signal);
  } catch (err) {
    // run 同步抛错时保持「本函数只返回 Promise」的契约，不把异常抛到调用栈上
    return Promise.reject(err);
  }
  // 只把 outer 交给 withTimeout：超时分支先落定再 abort，若监听的是合并 signal，
  // 本次超时会被 abort 监听器改写成「调用方取消」（见 withTimeout 内的顺序说明）。
  return withTimeout(pending, ms, {
    controller,
    signal: outer,
    onTimeout: opts.onTimeout,
    message: opts.message,
  });
}

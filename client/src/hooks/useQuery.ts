import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 「挂载即拉一次 + 加载/错误三态 + 防乱序 + 卸载中止」的最小查询封装。
 *
 * 为什么需要它：仓库里约 27 个页面各自手写同一套模式（useEffect 调接口、
 * loading/error 两个 state、再拿一个 seq ref 挡住迟到的旧响应），
 * 每处都得重新推一遍「旧响应不能覆盖新数据」这条纪律，写漏一处就是一个
 * 竞态 bug。这里把纪律收敛到一处，页面只管喂 fetcher。
 *
 * 不引入任何依赖：只用 React 自带 API，与仓库「不装 react-query/swr」的约定一致。
 */

export interface QueryResult<T> {
  data: T | undefined;
  loading: boolean;
  /** 最近一次失败的原始错误（未格式化）；成功或尚未失败时为 null */
  error: unknown;
  /** 手动重跑（错误横幅的「重试」按钮用） */
  reload: () => void;
  /**
   * 就地改写已取回的数据（如删除一条后从列表里剔除）。
   * 刻意暴露：这类"服务端已变更、需要本地同步"的更新走 refetch 会白白多打一次接口。
   */
  setData: (updater: T | ((prev: T | undefined) => T | undefined)) => void;
  /**
   * 清掉错误，保留数据。
   * 用于"数据已从别处拿到、旧错误不再成立"的场景（如监控成功后覆盖掉快照读取失败）。
   */
  clearError: () => void;
}

export interface QueryOptions {
  /** 跳过请求（例如条件未就绪）。为 true 时不发起请求，也不写入 loading */
  enabled?: boolean;
  /** 挂载前/失败后的初始值，默认 undefined */
  initialData?: unknown;
  /**
   * 每轮请求**结束**时同步回调：成功传 null，失败传原始错误。
   *
   * 为什么不叫 onError、也不让页面自己 useEffect 转发 error：
   * effect 比 state 更新晚一个 commit，页面会出现「列表已经渲染出来了，
   * 错误横幅却还挂着」的中间帧。回调与 setState 处在同一批更新里，
   * 两者同进同退，时序与手写版完全一致。
   *
   * 用途是把原始错误翻译成页面自己的文案（如"前缀 + 中文说明 + 英文原文"）。
   */
  onSettled?: (error: unknown) => void;
}

export function useQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: QueryOptions = {},
): QueryResult<T> {
  const { enabled = true, initialData, onSettled } = options;
  const [data, setDataState] = useState<T | undefined>(initialData as T | undefined);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);

  /**
   * 请求序号：只有最后一次请求有权写 state。
   * 慢请求后到时若不比对序号，就会用旧数据覆盖用户刚看到的新数据。
   */
  const seqRef = useRef(0);
  /** 组件是否仍挂载：卸载后不再 setState（避免对已卸载组件写状态） */
  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);

  // fetcher / onSettled 每次渲染都是新函数，放进 ref 才能既读到最新实现、
  // 又不让它们出现在 useEffect 依赖里（否则每帧都会重跑请求）
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const run = useCallback(async () => {
    // 新一轮请求先作废上一轮，并中止其在途连接
    seqRef.current += 1;
    const mySeq = seqRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current(controller.signal);
      if (mySeq !== seqRef.current || !mountedRef.current) return;
      setDataState(result);
      onSettledRef.current?.(null);
    } catch (err) {
      if (mySeq !== seqRef.current || !mountedRef.current) return;
      setError(err);
      onSettledRef.current?.(err);
    } finally {
      if (mySeq === seqRef.current && mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) void run();
    return () => {
      // 卸载：作废在途序号 + 中止请求，双保险防「卸载后仍 setState」
      mountedRef.current = false;
      seqRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps]);

  const reload = useCallback(() => {
    void run();
  }, [run]);

  const setData = useCallback((updater: T | ((prev: T | undefined) => T | undefined)) => {
    setDataState((prev) =>
      typeof updater === 'function'
        ? (updater as (p: T | undefined) => T | undefined)(prev)
        : updater,
    );
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { data, loading, error, reload, setData, clearError };
}

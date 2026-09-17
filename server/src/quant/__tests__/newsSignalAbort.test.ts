import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 新闻取数的取消语义（signal 贯通）
 * ----------------------------------------------------------------------------
 * 背景：这个模块的设计原则是「尽力而为，绝不抛错」——任何网络/解析失败都被吞成 []。
 * 但**调用方取消**是唯一的例外：把它也吞成「没有新闻」，批量作业取消后每只股票都会
 * 继续跑完剩下的全部流程（客户端早已断开仍在白烧上游），上层限时超时也照样白跑满
 * （逐端点 8s + LLM 打分 30s）。这里逐条钉住「取消不是失败」。
 *
 * 关键用例走**真实定时器**（超时给 50ms），因为要证明的是端到端事实：
 * 上层限时到点后，交给 fetch 的那个 signal 真的变成了 aborted。
 */
vi.mock('../../llm/index.js', () => ({
  isLLMAvailable: vi.fn(() => true),
  chatJSON: vi.fn(async () => ({ scores: [] })),
}));

import { fetchLatestNews, extractNewsSignal, scoreNewsWithLLM } from '../newsSignal.js';
import { isLLMAvailable, chatJSON } from '../../llm/index.js';
import { withAbortableTimeout } from '../../utils/timeout.js';

/** 记下 fetch 每次调用收到的 signal，供断言「取消是否级联到 socket 级」 */
function recordingFetch(impl: (url: string, init: { signal?: AbortSignal }) => Promise<unknown>): {
  fn: typeof fetch;
  signals: (AbortSignal | undefined)[];
} {
  const signals: (AbortSignal | undefined)[] = [];
  const fn = vi.fn(async (url: string, init: { signal?: AbortSignal }) => {
    signals.push(init?.signal);
    return impl(url, init);
  }) as unknown as typeof fetch;
  return { fn, signals };
}

const okAnnouncement = {
  ok: true,
  status: 200,
  json: async () => ({
    data: { list: [{ title: '公司发布超预期业绩公告', ei_time: '2026-01-01' }] },
  }),
};

const origFetch = globalThis.fetch;

beforeEach(() => {
  vi.mocked(isLLMAvailable).mockReturnValue(true);
  vi.mocked(chatJSON).mockResolvedValue({ scores: [] });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('fetchLatestNews —— 超时取消级联到 fetch', () => {
  it('上层限时到点后，交给 fetch 的 signal 真的 aborted（不是只让调用方提前失败）', async () => {
    // 上游永不产出：只有 abort 能让它结束
    const { fn, signals } = recordingFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        }),
    );
    globalThis.fetch = fn;

    const settled = withAbortableTimeout(
      (signal) => fetchLatestNews('600519', { signal }),
      50,
    ).then(
      () => 'resolved' as const,
      (err: Error) => err,
    );

    const result = await settled;

    expect(signals.length).toBe(1); // 第一个端点就卡住，不会再去打第二个
    expect(signals[0]?.aborted).toBe(true);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/timeout: 50ms/);
  });
});

describe('fetchLatestNews —— 调用方取消不是「没有新闻」', () => {
  it('调用前已取消：一次 fetch 都不打，并以取消原因 reject', async () => {
    const { fn } = recordingFetch(async () => okAnnouncement);
    globalThis.fetch = fn;
    const ctrl = new AbortController();
    ctrl.abort(new Error('批量回测已中止'));

    await expect(fetchLatestNews('600519', { signal: ctrl.signal })).rejects.toThrow(
      '批量回测已中止',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('抓取途中取消：以取消原因 reject，而不是吞成 []（否则批量会继续跑完剩余股票）', async () => {
    const ctrl = new AbortController();
    const { fn, signals } = recordingFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
          // 立刻模拟客户端断开
          setTimeout(() => ctrl.abort(new Error('客户端连接已关闭')), 5);
        }),
    );
    globalThis.fetch = fn;

    await expect(fetchLatestNews('600519', { signal: ctrl.signal })).rejects.toThrow(
      '客户端连接已关闭',
    );
    expect(signals[0]?.aborted).toBe(true); // 在途请求被真正断开
  });

  it('未取消时 signal 原样透传：非取消类失败依旧降级为 []', async () => {
    const { fn, signals } = recordingFetch(async () => {
      throw new Error('offline');
    });
    globalThis.fetch = fn;
    const ctrl = new AbortController();

    await expect(fetchLatestNews('600519', { signal: ctrl.signal })).resolves.toEqual([]);
    expect(signals.length).toBe(2); // 两个端点都试过
    expect(signals.every((s) => s && !s.aborted)).toBe(true);
  });
});

describe('fetchLatestNews —— 逐端点 8s 定时器不残留', () => {
  it('端点返回 !ok 走 continue 时也清掉定时器（原先只有成功路径清）', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    await expect(fetchLatestNews('600519')).resolves.toEqual([]);
    // 两个端点各挂一个 8s 定时器；遗漏时这里会是 2（定时器白挂 8s 并触发无人关心的 abort）
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('LLM 打分路径 —— signal 贯通', () => {
  it('scoreNewsWithLLM 把 signal 交给 chatJSON（排队中取消可立刻让出闸门配额）', async () => {
    const ctrl = new AbortController();
    await scoreNewsWithLLM([{ id: '1', title: '利好', publishedAt: '2026-01-01' }], {
      signal: ctrl.signal,
    });

    const opts = vi.mocked(chatJSON).mock.calls[0][1];
    expect(opts?.signal).toBe(ctrl.signal);
  });

  it('chatJSON 因取消而失败时上抛取消原因，不回退词典法继续算', async () => {
    const ctrl = new AbortController();
    vi.mocked(chatJSON).mockImplementation(async () => {
      ctrl.abort(new Error('批量回测已中止'));
      throw ctrl.signal.reason;
    });

    await expect(
      scoreNewsWithLLM([{ id: '1', title: '利好', publishedAt: '2026-01-01' }], {
        signal: ctrl.signal,
      }),
    ).rejects.toThrow('批量回测已中止');
  });

  it('chatJSON 因非取消原因失败时仍回退词典法（尽力而为的既有语义不变）', async () => {
    vi.mocked(chatJSON).mockRejectedValue(new Error('LLM 500'));

    await expect(
      scoreNewsWithLLM([{ id: '1', title: '利好', publishedAt: '2026-01-01' }]),
    ).resolves.toBeNull();
  });

  it('extractNewsSignal 把同一个 signal 一路传给 LLM 打分', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okAnnouncement) as unknown as typeof fetch;
    const ctrl = new AbortController();

    await extractNewsSignal('600519', { signal: ctrl.signal });

    expect(vi.mocked(chatJSON).mock.calls[0][1]?.signal).toBe(ctrl.signal);
  });
});

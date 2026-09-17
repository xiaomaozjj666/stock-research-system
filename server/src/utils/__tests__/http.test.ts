import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promisify } from 'node:util';
import { fetchJson } from '../http.js';

/**
 * 模拟 child_process.execFile。
 *
 * 重要：真实 execFile 带有 `util.promisify.custom`，经 promisify 后 resolve 出
 * `{ stdout, stderr }` 对象。若用普通 vi.fn() 模拟，promisify 会回退到默认行为
 * （多参数回调 → 解析为数组 `[stdout, stderr]`），导致 `const { stdout } = ...`
 * 解构出 undefined、随后 `stdout.toString()` 崩溃。这里用 `promisify.custom` 复刻
 * 真实契约，并经由模块级 curlImpl 注册表控制每个用例的行为，全部调用记录在 callLog。
 */
type CurlImpl = (
  file: string,
  args: string[],
  opts: unknown,
) => Promise<{ stdout: string; stderr: string }>;

// vi.mock 工厂被 hoisted 到文件顶部执行，直接引用外层 let/const 有 TDZ 风险；
// 用 vi.hoisted 在工厂之前创建共享状态（此前依赖"import 位于声明之后"才能跑，重构即碎）
const { curlImplRef, callLog } = vi.hoisted(() => ({
  curlImplRef: { impl: (async () => ({ stdout: '', stderr: '' })) as CurlImpl },
  callLog: [] as Array<{ file: string; args: string[]; opts: unknown }>,
}));

vi.mock('node:child_process', () => {
  const execFile = vi.fn((...args: unknown[]) => {
    callLog.push({ file: args[0] as string, args: args[1] as string[], opts: args[2] });
    return undefined;
  });
  Object.defineProperty(execFile, promisify.custom, {
    value: async (file: string, args: string[], opts: unknown) => {
      callLog.push({ file, args, opts });
      return curlImplRef.impl(file, args, opts);
    },
  });
  return { execFile };
});

/** 让 curl 回退返回给定 stdout */
function mockCurl(stdout: string, stderr = '') {
  curlImplRef.impl = async () => ({ stdout, stderr });
}
/** 让 curl 回退直接抛错（模拟 curl 进程失败） */
function mockCurlError(err: Error) {
  curlImplRef.impl = async () => {
    throw err;
  };
}
/** 让 curl 回退返回空响应（fetchJson 视为失败并继续重试） */
function mockCurlEmpty() {
  curlImplRef.impl = async () => ({ stdout: '', stderr: '' });
}

/**
 * 复刻真实 curl 的行为（含 `-f/--fail` 语义）：
 *  - 带 `-f` 且 HTTP ≥ 400 → curl 退出码 22、stdout 为空（execFile reject）；
 *  - **不带** `-f` → 无论状态码都退出 0，错误响应体照样写到 stdout。
 * 这正是「上游 500 被当成成功解析」的成因，用它来钉住回退分支的失败语义。
 */
function mockCurlHttpStatus(body: string, status: number) {
  curlImplRef.impl = async (_file, args) => {
    if (status >= 400) {
      if (args.includes('-f')) {
        throw new Error(
          `Command failed: curl ...\ncurl: (22) The requested URL returned error: ${status}`,
        );
      }
      return { stdout: body, stderr: '' };
    }
    return { stdout: body, stderr: '' };
  };
}

describe('fetchJson', () => {
  beforeEach(() => {
    callLog.length = 0;
    curlImplRef.impl = async () => ({ stdout: '', stderr: '' });
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetch 成功时直接返回解析后的 JSON，不触达 curl', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })),
    );
    const data = await fetchJson('https://example.com/api');
    expect(data).toEqual({ ok: 1 });
    // 成功路径不应触发 curl 回退（callLog 是权威记录；mockedExecFile 包装器恒不被调用，
    // 对它的 not.toHaveBeenCalled 断言恒真无意义，已删除）
    expect(callLog.length).toBe(0);
  });

  it('非 2xx 响应视为失败并回退 curl', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    mockCurl(JSON.stringify({ fallback: true }));
    const data = await fetchJson('https://example.com/api');
    expect(callLog.some((c) => c.file === 'curl')).toBe(true);
    expect(data).toEqual({ fallback: true });
  });

  it('fetch 抛错时回退到 curl 子进程', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    mockCurl(JSON.stringify({ fromCurl: 1 }));
    const data = await fetchJson('https://example.com/api');
    expect(data).toEqual({ fromCurl: 1 });
    expect(callLog.some((c) => c.file === 'curl')).toBe(true);
  });

  it('curl 返回空响应时视为失败（全部尝试失败则抛出）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    mockCurlEmpty();
    await expect(fetchJson('https://example.com/api', { retries: 0 })).rejects.toThrow();
  });

  it('fetch 与 curl 都失败时，抛出最后一次错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    mockCurlError(new Error('curl error 56'));
    await expect(fetchJson('https://example.com/api', { retries: 1 })).rejects.toThrow(
      /curl error 56/,
    );
  });

  it('重试：前两次 fetch 失败，第三次成功', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return new Response(JSON.stringify({ attempt: calls }), { status: 200 });
      }),
    );
    const data = await fetchJson('https://example.com/api', { retries: 2 });
    expect(data).toEqual({ attempt: 3 });
    expect(calls).toBe(3);
  });

  it('透传自定义请求头给 fetch', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await fetchJson('https://example.com/api', { headers: { 'User-Agent': 'test-agent' } });
    const init = (fetchSpy.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('test-agent');
  });

  it('curl 回退同样透传自定义请求头', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    mockCurl('{}');
    await fetchJson('https://example.com/api', { headers: { 'User-Agent': 'test-agent' } });
    const curlCall = callLog.find((c) => c.file === 'curl');
    expect(curlCall).toBeDefined();
    // curl 参数形如 ['-s', '-S', '-f', '-m', '17', '-H', 'User-Agent: test-agent', <url>]
    const hIdx = curlCall!.args.indexOf('-H');
    expect(hIdx).toBeGreaterThanOrEqual(0);
    expect(curlCall!.args[hIdx + 1]).toContain('test-agent');
  });

  it('signal 预先置位：直接拒绝，不发起 fetch 也不回退 curl', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchJson('https://example.com/api', { signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(callLog.length).toBe(0);
  });

  it('fetch 挂起期间外部中止：立即上抛且不回退 curl', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            // 复刻 fetch 对外部 signal 的行为：abort 即 reject
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('This operation was aborted')),
            );
          }),
      ),
    );
    mockCurl('{}');
    const pending = fetchJson('https://example.com/api', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(callLog.length).toBe(0);
  });
});

/* ============================================================================
 * curl 回退的失败语义必须与 fetch 分支一致（P1：非 2xx 被当成功）
 * ----------------------------------------------------------------------------
 * 修复前 curl 参数是 `-s -m <n> <url>`：上游 500 且响应体是合法 JSON 时，curl 退出码
 * 仍是 0，错误体被 JSON.parse 成功返回 —— 调用方读成「上游没有数据」，
 * 不重试、不告警、指标不体现失败；而上方的 fetch 分支对非 2xx 会 throw HTTP <status>
 * 并进入重试。加 `-f` 后两条路径语义一致。
 * ==========================================================================*/
describe('fetchJson — curl 回退的失败语义（-f）', () => {
  beforeEach(() => {
    callLog.length = 0;
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** fetch 永远失败：强制每次尝试都走 curl 回退 */
  function stubFetchFail() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
  }

  it('上游 500 且响应体是合法 JSON：按失败处理，不把错误体当数据返回', async () => {
    stubFetchFail();
    mockCurlHttpStatus(JSON.stringify({ error: 'upstream boom' }), 500);

    await expect(fetchJson('https://example.com/api', { retries: 0 })).rejects.toThrow(/500/);
    // 举证：确实走了 curl 回退，且带上了 -f（没有它 curl 对 5xx 退出码为 0）
    const curlCall = callLog.find((c) => c.file === 'curl');
    expect(curlCall).toBeDefined();
    expect(curlCall!.args).toContain('-f');
  });

  it('非 2xx 会像 fetch 分支一样重试（retries 次共 3 次尝试）', async () => {
    stubFetchFail();
    mockCurlHttpStatus(JSON.stringify({ error: 'boom' }), 503);

    await expect(fetchJson('https://example.com/api', { retries: 2 })).rejects.toThrow();
    expect(callLog.filter((c) => c.file === 'curl')).toHaveLength(3);
  });

  it('-f 不误伤成功路径：2xx 的合法 JSON 照常解析', async () => {
    stubFetchFail();
    mockCurlHttpStatus(JSON.stringify({ fromCurl: 1 }), 200);

    await expect(fetchJson('https://example.com/api', { retries: 0 })).resolves.toEqual({
      fromCurl: 1,
    });
  });
});

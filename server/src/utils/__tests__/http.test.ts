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
let curlImpl: CurlImpl = async () => ({ stdout: '', stderr: '' });
const callLog: Array<{ file: string; args: string[]; opts: unknown }> = [];

vi.mock('node:child_process', () => {
  const execFile = vi.fn((...args: unknown[]) => {
    callLog.push({ file: args[0] as string, args: args[1] as string[], opts: args[2] });
    return undefined;
  });
  Object.defineProperty(execFile, promisify.custom, {
    value: async (file: string, args: string[], opts: unknown) => {
      callLog.push({ file, args, opts });
      return curlImpl(file, args, opts);
    },
  });
  return { execFile };
});

import { execFile } from 'node:child_process';
const mockedExecFile = vi.mocked(execFile);

/** 让 curl 回退返回给定 stdout */
function mockCurl(stdout: string, stderr = '') {
  curlImpl = async () => ({ stdout, stderr });
}
/** 让 curl 回退直接抛错（模拟 curl 进程失败） */
function mockCurlError(err: Error) {
  curlImpl = async () => {
    throw err;
  };
}
/** 让 curl 回退返回空响应（fetchJson 视为失败并继续重试） */
function mockCurlEmpty() {
  curlImpl = async () => ({ stdout: '', stderr: '' });
}

describe('fetchJson', () => {
  beforeEach(() => {
    callLog.length = 0;
    curlImpl = async () => ({ stdout: '', stderr: '' });
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
    // 成功路径不应触发 curl 回退
    expect(callLog.length).toBe(0);
    expect(mockedExecFile).not.toHaveBeenCalled();
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
    // curl 参数形如 ['-s', '-m', '17', '-H', 'User-Agent: test-agent', <url>]
    const hIdx = curlCall!.args.indexOf('-H');
    expect(hIdx).toBeGreaterThanOrEqual(0);
    expect(curlCall!.args[hIdx + 1]).toContain('test-agent');
  });
});

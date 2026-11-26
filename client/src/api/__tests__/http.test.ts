// 原生 fetch 客户端：查询串、JSON 体、错误形状、超时/取消、拦截器
// 这些分支此前几乎无人覆盖（9.43%），而所有 REST 包装层都压在它上面。
import { afterEach, describe, expect, it, vi } from 'vitest';
import http, { isCancelled } from '../http';

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return impl(url, init);
    }),
  );
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('http.create — 请求构造', () => {
  it('查询串：丢弃 null/undefined，数组展开为 key[]，中文按 URL 编码', async () => {
    const calls = stubFetch(async () => json({ ok: true }));
    const api = http.create({ baseURL: '/api' });

    await api.get('/search', {
      params: {
        q: '茅台',
        page: 2,
        skip: undefined,
        nil: null,
        tags: ['a', null, 'b'],
        empty: [],
      },
    });

    expect(calls[0].url.startsWith('/api/search?')).toBe(true);
    const query = new URL(calls[0].url, 'http://x').searchParams;
    expect(query.get('q')).toBe('茅台');
    expect(query.get('page')).toBe('2');
    expect(query.has('skip')).toBe(false);
    expect(query.has('nil')).toBe(false);
    expect(query.getAll('tags[]')).toEqual(['a', 'b']);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('无参数时不留问号；自定义 header 透传', async () => {
    const calls = stubFetch(async () => json({}));
    const api = http.create({ baseURL: '/api' });

    await api.delete('/item/1', { headers: { 'x-token': 'abc' } });

    expect(calls[0].url).toBe('/api/item/1');
    expect(new Headers(calls[0].init.headers).get('x-token')).toBe('abc');
  });

  it('post/put 的 JSON body：序列化并补 content-type', async () => {
    const calls = stubFetch(async () => json({}));
    const api = http.create({ baseURL: '' });

    await api.post('/a', { n: 1 }, { headers: { 'x-a': '1' } });
    await api.put('/b', { n: 2 });

    expect(calls[0].init.body).toBe('{"n":1}');
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[1].init.body).toBe('{"n":2}');
    expect(calls[1].init.method).toBe('PUT');
  });

  it('未传 body 时不设置 content-type（GET/DELETE 保持无实体）', async () => {
    const calls = stubFetch(async () => json({}));
    const api = http.create();

    await api.get('/plain');

    expect(new Headers(calls[0].init.headers).has('content-type')).toBe(false);
    expect(calls[0].url).toBe('/plain');
  });
});

describe('http.create — 响应与错误形状', () => {
  it('JSON 响应：解析 data 并透传 status/headers', async () => {
    stubFetch(async () => json({ value: 42 }, 201));
    const api = http.create();

    const res = await api.get<{ value: number }>('/x');

    expect(res.data.value).toBe(42);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('空响应体：data 为 undefined，不尝试 JSON.parse', async () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    const api = http.create();

    const res = await api.get('/empty');

    expect(res.data).toBeUndefined();
    expect(res.status).toBe(204);
  });

  it('非 JSON 响应体：原样返回字符串（例如纯文本错误页）', async () => {
    stubFetch(async () => new Response('Bad Gateway', { status: 200 }));
    const api = http.create();

    const res = await api.get('/text');

    expect(res.data).toBe('Bad Gateway');
  });

  it('HTTP 非 2xx：抛 HttpError 形状（status/headers/data）并触发错误拦截器', async () => {
    stubFetch(async () => json({ error: 'boom' }, 500));
    const api = http.create();
    const onRejected = vi.fn();
    api.interceptors.response.use(undefined, onRejected);

    await expect(api.get('/fail')).rejects.toMatchObject({
      name: 'HttpError',
      message: 'Request failed with status code 500',
      response: { status: 500, data: { error: 'boom' } },
    });
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it('网络错误：code=ERR_NETWORK，isCancelled 为 false', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const api = http.create();

    const error = await api.get('/down').catch((e: unknown) => e);

    expect(error).toMatchObject({
      name: 'HttpError',
      code: 'ERR_NETWORK',
      message: 'Network Error',
    });
    expect(isCancelled(error)).toBe(false);
  });

  it('超时：code=ECONNABORTED，消息为 timeout exceeded', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const api = http.create({ timeout: 10 });

    const error = await api.get('/slow').catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'ECONNABORTED', message: 'timeout exceeded' });
    expect(isCancelled(error)).toBe(false);
  });

  it('外部 signal 已中止：直接按取消处理（code=ERR_CANCELED）', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = stubFetch((_url, init) => {
      // 真实 fetch 在 signal 已中止时会立即 reject；桩也照此行为
      if (init.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      return Promise.resolve(json({}));
    });
    const api = http.create();

    const error = await api.get('/cancel', { signal: controller.signal }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'ERR_CANCELED', message: 'canceled' });
    expect(isCancelled(error)).toBe(true);
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it('请求进行中外部取消：合并到同一 AbortSignal 并按取消上报', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const controller = new AbortController();
    const api = http.create();

    const pending = api.get('/long', { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();

    expect(await pending).toMatchObject({ code: 'ERR_CANCELED' });
  });
});

describe('http.create — 拦截器', () => {
  it('请求拦截器可改写 url/headers；响应拦截器可观察结果', async () => {
    const calls = stubFetch(async () => json({ ok: true }));
    const api = http.create({ baseURL: '/api' });
    api.interceptors.request.use((cfg) => {
      cfg.url += '?from=hook';
      return cfg;
    });
    const seen = vi.fn();
    api.interceptors.response.use((res) => {
      seen(res.status);
      return res;
    });

    await api.get('/hooked');

    expect(calls[0].url).toBe('/api/hooked?from=hook');
    expect(seen).toHaveBeenCalledWith(200);
  });

  it('多个请求拦截器按注册顺序串联（异步 hook 也可用）', async () => {
    const calls = stubFetch(async () => json({}));
    const api = http.create();
    const order: string[] = [];
    api.interceptors.request.use(async (cfg) => {
      await Promise.resolve();
      order.push('first');
      cfg.url += '/first';
      return cfg;
    });
    api.interceptors.request.use((cfg) => {
      order.push('second');
      cfg.url += '/second';
      return cfg;
    });

    await api.get('/start');

    expect(order).toEqual(['first', 'second']);
    expect(calls[0].url).toBe('/start/first/second');
  });
});

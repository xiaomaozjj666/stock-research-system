/**
 * 极简 HTTP 客户端（原生 fetch）
 * ----------------------------------------------------------------------------
 * 为什么自研：axios 在本项目只用到 get/post/delete + 查询参数 + 超时 +
 * AbortSignal + 401 广播，却给产物带来 ~57 kB（gzip ~21 kB）的整包运行时。
 * 这里用百余行覆盖同等能力，产物归零。
 *
 * 错误对象刻意保持 axios 的**形状**（code / response.status /
 * response.headers / response.data），因此 normalizeApiError 与所有既有
 * 调用方都不需要改判定逻辑，只是把 axios.isCancel 换成 isCancelled。
 */

export interface HttpRequestConfig {
  params?: Record<string, unknown>;
  timeout?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/** 与 axios 错误形状对齐的最小实现（只保留本项目实际读取的字段） */
class HttpError extends Error {
  /** 'ERR_CANCELED' | 'ECONNABORTED' | 'ERR_NETWORK' */
  code?: string;
  response?: { status: number; headers: Headers; data?: unknown };

  constructor(message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 与 axios.isCancel 等价：被 AbortSignal 取消的请求 */
export function isCancelled(error: unknown): boolean {
  return (error as { code?: string } | null | undefined)?.code === 'ERR_CANCELED';
}

/**
 * 查询串序列化。与 axios 默认行为保持一致：
 * null/undefined 丢弃，数组展开为 `key[]=v1&key[]=v2`。
 */
function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) search.append(`${key}[]`, String(item));
      }
    } else {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

interface InternalConfig extends Omit<HttpRequestConfig, 'headers'> {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

type RequestHook = (config: InternalConfig) => InternalConfig | Promise<InternalConfig>;
type ResponseHook = (response: HttpResponse<unknown>) => unknown;
type ErrorHook = (error: unknown) => unknown;

export default {
  /**
   * 与 axios.create 同形的最小工厂（baseURL / timeout 默认值）。
   * 拦截器只实现本项目用到的 use()，在模块加载时注册一次。
   */
  create(defaults: { baseURL?: string; timeout?: number } = {}) {
    const baseURL = defaults.baseURL ?? '';
    const defaultTimeout = defaults.timeout ?? 120000;
    const requestHooks: RequestHook[] = [];
    const responseHooks: ResponseHook[] = [];
    const errorHooks: ErrorHook[] = [];

    async function runErrorHooks(error: unknown): Promise<void> {
      for (const hook of errorHooks) await hook(error);
    }

    async function send<T>(
      method: string,
      path: string,
      body: unknown,
      config: HttpRequestConfig,
    ): Promise<HttpResponse<T>> {
      let cfg: InternalConfig = {
        ...config,
        url: `${baseURL}${path}${buildQuery(config.params)}`,
        method,
        body,
        headers: new Headers(config.headers),
      };
      for (const hook of requestHooks) cfg = await hook(cfg);

      const controller = new AbortController();
      let timedOut = false;
      const timeoutMs = cfg.timeout ?? defaultTimeout;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs)
          : null;

      // 外部 signal（用户取消）与内部超时合并到同一个 controller
      const external = cfg.signal;
      const abort = () => controller.abort();
      if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', abort, { once: true });
      }

      try {
        let payload: string | undefined;
        if (cfg.body !== undefined) {
          cfg.headers.set('content-type', 'application/json');
          payload = JSON.stringify(cfg.body);
        }

        const res = await fetch(cfg.url, {
          method,
          headers: cfg.headers,
          body: payload,
          signal: controller.signal,
        });
        const text = await res.text();
        let data: unknown;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            // 非 JSON 响应（如纯文本错误页）：原样交给调用方，不在这里吞掉
            data = text;
          }
        }

        if (!res.ok) {
          const err = new HttpError(`Request failed with status code ${res.status}`);
          err.response = { status: res.status, headers: res.headers, data };
          await runErrorHooks(err);
          throw err;
        }

        const response: HttpResponse<T> = {
          data: data as T,
          status: res.status,
          headers: res.headers,
        };
        for (const hook of responseHooks) await hook(response);
        return response;
      } catch (error) {
        if (error instanceof HttpError) throw error; // 已带 response，交给 normalizeApiError
        const aborted = controller.signal.aborted;
        const err = new HttpError(
          aborted ? (timedOut ? 'timeout exceeded' : 'canceled') : 'Network Error',
        );
        err.code = aborted ? (timedOut ? 'ECONNABORTED' : 'ERR_CANCELED') : 'ERR_NETWORK';
        await runErrorHooks(err);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        external?.removeEventListener('abort', abort);
      }
    }

    return {
      get<T>(path: string, config: HttpRequestConfig = {}) {
        return send<T>('GET', path, undefined, config);
      },
      post<T>(path: string, body?: unknown, config: HttpRequestConfig = {}) {
        return send<T>('POST', path, body, config);
      },
      put<T>(path: string, body?: unknown, config: HttpRequestConfig = {}) {
        return send<T>('PUT', path, body, config);
      },
      delete<T>(path: string, config: HttpRequestConfig = {}) {
        return send<T>('DELETE', path, undefined, config);
      },
      interceptors: {
        request: {
          use(hook: RequestHook) {
            requestHooks.push(hook);
          },
        },
        response: {
          use(onFulfilled?: ResponseHook, onRejected?: ErrorHook) {
            if (onFulfilled) responseHooks.push(onFulfilled);
            if (onRejected) errorHooks.push(onRejected);
          },
        },
      },
    };
  },
};

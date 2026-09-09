import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface FetchJsonOptions {
  /** 请求头（会同时透传给 fetch 与 curl 回退） */
  headers?: Record<string, string>;
  /** 超时时间（毫秒），默认 12000 */
  timeoutMs?: number;
  /** 失败重试次数（每次尝试内都会先 fetch 再 curl 回退），默认 2 */
  retries?: number;
  /** 外部中止信号（如 HTTP 客户端提前断开）：fetch 与 curl 回退一并取消，且不再重试 */
  signal?: AbortSignal;
}

/**
 * 弹性 JSON GET。
 *
 * 优先使用 Node 原生 `fetch`；若失败（某些运行环境/沙箱下部分主机 TLS 连接会被对端重置，
 * 表现为 `fetch failed`，但 `curl` 可正常访问），自动回退到 `curl` 子进程。
 *
 * 生产环境 `fetch` 通常直接成功，回退仅作健壮性兜底，不会改变正常路径的行为。
 * 返回已解析的 JSON 对象；若全部尝试失败则抛出最后一次错误。
 */
export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { headers = {}, timeoutMs = 12000, retries = 2 } = opts;
  const signal = opts.signal;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('fetchJson 已中止');

    // 1) Node 原生 fetch（超时与外部中止取先到者）
    try {
      const resp = await fetch(url, {
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
          : AbortSignal.timeout(timeoutMs),
        headers,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const text = await resp.text();
      return JSON.parse(text);
    } catch (e) {
      // 外部中止不属于「可重试失败」：直接上抛，不再走 curl 回退
      if (signal?.aborted) throw e;
      lastErr = e;
    }

    // 2) curl 回退（绕过沙箱 TLS 重置）；execFile 的 signal 选项会在中止时杀死子进程
    try {
      const args: string[] = ['-s', '-m', String(Math.ceil(timeoutMs / 1000) + 5)];
      for (const [k, v] of Object.entries(headers)) {
        args.push('-H', `${k}: ${v}`);
      }
      args.push(url);
      const { stdout } = await execFileP('curl', args, {
        timeout: timeoutMs + 8000,
        windowsHide: true,
        signal,
      });
      const text = stdout.toString();
      if (!text.trim()) throw new Error('curl 返回空响应');
      return JSON.parse(text);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }

    if (attempt < retries) {
      // 指数退避 + 随机抖动（借鉴 Sequoia-X「随机休眠 + 躺平重试」）：
      // 避免同时失败的重试在同一毫秒齐发，对上游表现得像独立客户端
      const base = Math.min(3000, 250 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, base * (0.5 + Math.random() * 0.5)));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('fetchJson 失败');
}

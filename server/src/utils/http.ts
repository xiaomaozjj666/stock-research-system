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
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 1) Node 原生 fetch
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const text = await resp.text();
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
    }

    // 2) curl 回退（绕过沙箱 TLS 重置）
    try {
      const args: string[] = ['-s', '-m', String(Math.ceil(timeoutMs / 1000) + 5)];
      for (const [k, v] of Object.entries(headers)) {
        args.push('-H', `${k}: ${v}`);
      }
      args.push(url);
      const { stdout } = await execFileP('curl', args, {
        timeout: timeoutMs + 8000,
        windowsHide: true,
      });
      const text = stdout.toString();
      if (!text.trim()) throw new Error('curl 返回空响应');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
    }

    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('fetchJson 失败');
}

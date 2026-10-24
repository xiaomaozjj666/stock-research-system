import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * fetch 已收到响应但状态非 2xx（上游可达且明确拒绝）。
 * M-4：此类失败**不落入 curl 回退**——fetch 侧已经确认网络可达、拿到上游应答，
 * 用 curl 重发同一 URL 只会再被拒绝一次（双通道 × 重试 = 6 次放大请求）；
 * 仅保留指数退避的 fetch 重试。网络层错误（fetch 本身 throw，如 ECONNREFUSED/
 * TLS 重置）才走 curl 双通道。
 */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

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
    let httpRejected = false; // 本轮 fetch 是否为「HTTP 状态拒绝」（非网络错误）
    try {
      const resp = await fetch(url, {
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
          : AbortSignal.timeout(timeoutMs),
        headers,
      });
      if (!resp.ok) {
        httpRejected = true;
        throw new HttpStatusError(resp.status);
      }
      const text = await resp.text();
      return JSON.parse(text);
    } catch (e) {
      // 外部中止不属于「可重试失败」：直接上抛，不再走 curl 回退
      if (signal?.aborted) throw e;
      lastErr = e;
      // M-4: 4xx/5xx 是上游明确拒绝（fetch 已确认可达）——curl 重试同一 URL 无意义，
      // 跳过 curl 双通道，直接进入退避重试（保持 fetch 重试语义）
      if (httpRejected) {
        if (attempt < retries) {
          const base = Math.min(3000, 250 * 2 ** attempt);
          await new Promise((r) => setTimeout(r, base * (0.5 + Math.random() * 0.5)));
        }
        continue;
      }
    }

    // 2) curl 回退（绕过沙箱 TLS 重置）；execFile 的 signal 选项会在中止时杀死子进程
    try {
      // `-f`（--fail）不可省：没有它时 curl 对 4xx/5xx **退出码仍为 0**，
      // 上游返回的合法 JSON 错误体（如 {"error":"..."}）会被当成成功解析，
      // 调用方读成「上游没有数据」→ 不重试、不告警、指标不体现失败；
      // 而上面 fetch 分支对非 2xx 会 `throw HTTP ${status}` 并重试，两条路径语义必须一致。
      // `-S`（--show-error）配合 `-s` 把 HTTP 错误写进 stderr，execFile 的 reject 里能带上原因。
      const args: string[] = ['-s', '-S', '-f', '-m', String(Math.ceil(timeoutMs / 1000) + 5)];
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

/**
 * SSE 响应辅助：统一处理流式响应头、客户端断开感知、安全写与静默期心跳。
 * ----------------------------------------------------------------------------
 * - send：向客户端推送一条 event；客户端已断开时抛错，
 *   供管线在阶段边界（emit 回调）感知断开并协作式取消后续计算。
 * - trySend：send 的吞错版本，用于 finally 收尾推送（done/error 不再抛错）。
 * - isClosed：查询连接是否已断开或响应已结束。
 * - stopHeartbeat：显式停止心跳定时器（收尾时可提前停，不必等 close）。
 *
 * 心跳（2026-09 补）：深度分析的 `experts → arbitration` 之间可能静默 60s+，
 * 而 nginx 的 proxy_read_timeout / ALB 的 idle_timeout 默认都是 60s——静默期没有
 * 任何字节流动时，反代会把连接当"死连接"掐断（前端表现为"分析莫名中断"）。
 * 这里按固定间隔写一行 SSE **注释帧**（以 ':' 开头，不触发客户端 message 事件，
 * 前端无感），让链路上始终有字节流动。间隔由 SSE_HEARTBEAT_MS 控制，置 0 关闭。
 */
import type { Request, Response } from 'express';

/**
 * 默认心跳间隔（毫秒）。
 * 取值依据：必须显著小于常见反代/网关的读超时（nginx 60s、ALB 60s、Cloudflare 100s），
 * 才能在两次心跳之间留出足够容错（15s × 4 = 60s）。同时不能太密——每条心跳都是
 * 一次 write 与一行潜在的 access log，5s 级别对 1~3 分钟的分析纯属噪声。
 */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** 心跳注释帧：SSE 规范中以 ':' 开头的行是注释，客户端不会派发为事件 */
export const HEARTBEAT_FRAME = ': ping\n\n';

export interface SseChannel {
  send: (data: unknown) => void;
  trySend: (data: unknown) => void;
  isClosed: () => boolean;
  /** 显式停止心跳（幂等）；通道已关闭/响应已结束时也会自动停止 */
  stopHeartbeat: () => void;
}

/**
 * 解析 SSE_HEARTBEAT_MS（每次建通道时读取，测试可逐用例改 env）：
 * - 未设置 / 空 / 非数值 → 默认 15000；
 * - <= 0（含显式的 0）→ 0，表示关闭心跳（测试与不便长连接的环境用）。
 */
export function resolveHeartbeatMs(): number {
  const raw = process.env.SSE_HEARTBEAT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HEARTBEAT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HEARTBEAT_MS;
  return parsed > 0 ? Math.floor(parsed) : 0;
}

export function createSseChannel(_req: Request, res: Response): SseChannel {
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // 'close' 在连接终止或正常 end 后都会触发；res.writableEnded 区分两者
  res.on('close', () => {
    closed = true;
    stopHeartbeat();
  });
  // 'finish'（响应已写完）同样停表：SSE 路由在 finally 里 res.end()，
  // 只等 'close' 的话，end 与 close 之间可能多写一帧到已结束的响应上
  res.on('finish', stopHeartbeat);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const heartbeatMs = resolveHeartbeatMs();
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      // 与 send/trySend 同一套"还能不能写"的判据；不能写就停表（等 close 收尾）
      if (closed || res.writableEnded || res.destroyed) {
        stopHeartbeat();
        return;
      }
      try {
        res.write(HEARTBEAT_FRAME);
      } catch {
        // EPIPE 之类：连接已废，停表即可（真正的清理由 close 事件完成）
        stopHeartbeat();
      }
    }, heartbeatMs);
    // 心跳不应成为"进程还活着"的理由：unref 后它不阻塞事件循环退出
    // （测试里未显式关闭的通道也就不会挂住 vitest 进程）
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  return {
    // 心跳不改写 closed，也不参与这里的判定：isClosed 仍然只反映"连接/响应"的真实状态
    isClosed: () => closed || res.writableEnded || res.destroyed,
    send: (data) => {
      if (closed || res.writableEnded || res.destroyed) {
        throw new Error('SSE_CLIENT_DISCONNECTED');
      }
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    trySend: (data) => {
      try {
        if (!closed && !res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      } catch {
        /* 客户端已断开，收尾推送放弃 */
      }
    },
    stopHeartbeat,
  };
}

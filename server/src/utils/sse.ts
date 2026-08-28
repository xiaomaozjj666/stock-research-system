/**
 * SSE 响应辅助：统一处理流式响应头、客户端断开感知与安全写。
 * ----------------------------------------------------------------------------
 * - send：向客户端推送一条 event；客户端已断开时抛错，
 *   供管线在阶段边界（emit 回调）感知断开并协作式取消后续计算。
 * - trySend：send 的吞错版本，用于 finally 收尾推送（done/error 不再抛错）。
 * - isClosed：查询连接是否已断开或响应已结束。
 */
import type { Request, Response } from 'express';

export interface SseChannel {
  send: (data: unknown) => void;
  trySend: (data: unknown) => void;
  isClosed: () => boolean;
}

export function createSseChannel(_req: Request, res: Response): SseChannel {
  let closed = false;
  // 'close' 在连接终止或正常 end 后都会触发；res.writableEnded 区分两者
  res.on('close', () => {
    closed = true;
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  return {
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
  };
}

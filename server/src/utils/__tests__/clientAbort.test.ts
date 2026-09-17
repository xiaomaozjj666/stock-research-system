/**
 * abortOnClientClose：客户端断开 → 级联中止在途取数
 * ----------------------------------------------------------------------------
 * 背景（审计）：routes/watchlist.ts 与 routes/quant.ts 各有一份等价实现（注释也写着
 * "未导出故各写一份"）。抽到 utils/clientAbort.ts 后，这里钉住它的三条语义：
 *   1. 监听 res 的 'close'；
 *   2. 响应已写完（writableFinished）时**不** abort（否则每个成功响应结束都会误取消）；
 *   3. 返回 AbortController（调用点用 controller.signal 级联到 fetch）。
 * 前两条用假 res（EventEmitter）覆盖，末尾再用真实 HTTP 连接覆盖端到端行为。
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import express from 'express';
import type { Response } from 'express';
import { abortOnClientClose } from '../clientAbort.js';

/** 最小可用的假 Response：只提供 helper 用到的 on/emit 与 writableFinished */
class FakeResponse extends EventEmitter {
  writableFinished = false;
}

function fakeResponse(finished = false): Response & FakeResponse {
  const res = new FakeResponse();
  res.writableFinished = finished;
  return res as unknown as Response & FakeResponse;
}

describe('abortOnClientClose（假 res）', () => {
  it('客户端断开（close 且响应未写完）→ signal 被 abort', () => {
    const res = fakeResponse(false);
    const controller = abortOnClientClose(res);

    expect(controller.signal.aborted).toBe(false);
    res.emit('close');
    expect(controller.signal.aborted).toBe(true);
  });

  it('正常结束（响应已写完后的 close）→ 不 abort', () => {
    const res = fakeResponse(false);
    const controller = abortOnClientClose(res);

    // 响应写完 → 随后 close 属正常收尾，不应取消（也不应取消已经无关的后续工作）
    // 注意 writableFinished 在 Node 类型里是只读 getter，测试里用 defineProperty 覆盖
    Object.defineProperty(res, 'writableFinished', { value: true, configurable: true });
    res.emit('close');
    expect(controller.signal.aborted).toBe(false);
  });

  it('返回 AbortController：调用方拿到的 .signal 可直接传给 fetch', async () => {
    const res = fakeResponse(false);
    const controller = abortOnClientClose(res);
    expect(controller).toBeInstanceOf(AbortController);

    const pending = new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    res.emit('close');
    await expect(pending).rejects.toThrow('aborted');
  });
});

/* ============================================================================
 * 注册时连接「已经」关闭（P1：close 是一次性事件，事后注册永远等不到）
 * ----------------------------------------------------------------------------
 * 客户端若在本函数被调用**之前**就断开（请求刚进来就取消、或前置中间件耗时较久），
 * 'close' 早已派发完毕：事后注册的监听器永不再触发，signal.aborted 恒为 false，
 * 在途取数照样全量跑完、白烧上游配额。判据见 clientAbort.ts 的 isConnectionGone。
 * ==========================================================================*/
describe('abortOnClientClose（注册时连接已关闭）', () => {
  function goneResponse(fields: Record<string, unknown>): Response & FakeResponse {
    const res = fakeResponse(false);
    for (const [k, v] of Object.entries(fields)) {
      Object.defineProperty(res, k, { value: v, configurable: true });
    }
    return res;
  }

  it('res.destroyed=true（socket 已销毁）→ 注册即 abort', () => {
    const controller = abortOnClientClose(goneResponse({ destroyed: true }));
    expect(controller.signal.aborted).toBe(true);
  });

  it('res.closed=true（close 已经发生过）→ 注册即 abort', () => {
    const controller = abortOnClientClose(goneResponse({ closed: true }));
    expect(controller.signal.aborted).toBe(true);
  });

  it('res.socket.destroyed=true（底层连接已断）→ 注册即 abort', () => {
    const controller = abortOnClientClose(goneResponse({ socket: { destroyed: true } }));
    expect(controller.signal.aborted).toBe(true);
  });

  it('响应已正常写完（writableFinished）→ 即使 destroyed 也不 abort（保持既有语义）', () => {
    const controller = abortOnClientClose(
      goneResponse({ writableFinished: true, destroyed: true }),
    );
    expect(controller.signal.aborted).toBe(false);
  });

  it('连接仍健在（各判据均为假）→ 不 abort，仍靠后续 close 触发', () => {
    const res = goneResponse({ destroyed: false, closed: false, socket: { destroyed: false } });
    const controller = abortOnClientClose(res);
    expect(controller.signal.aborted).toBe(false);
    res.emit('close');
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('abortOnClientClose（真实 HTTP 连接）', () => {
  /** 起一个真实 server：路由挂上 helper，把 signal 状态暴露给测试 */
  async function withServer(
    run: (ctx: {
      url: string;
      close: () => Promise<void>;
      abortedFlags: boolean[];
      finishedCount: () => number;
    }) => Promise<void>,
  ): Promise<void> {
    const abortedFlags: boolean[] = [];
    let finished = 0;
    const app = express();
    app.get('/slow', (_req, res) => {
      const abort = abortOnClientClose(res);
      abortedFlags.push(abort.signal.aborted);
      // 模拟"在途取数"：客户端若断开，close 会在响应写回前触发 cancel
      setTimeout(() => {
        if (abort.signal.aborted) return; // 客户端已不在：不写响应
        finished += 1;
        res.json({ ok: true });
      }, 50);
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const close = () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    try {
      await run({
        url: `http://127.0.0.1:${port}/slow`,
        close,
        abortedFlags,
        finishedCount: () => finished,
      });
    } finally {
      await close();
    }
  }

  it('客户端中途断开 → route 内的 signal 被 abort（响应不再写回）', async () => {
    await withServer(async ({ url, abortedFlags, finishedCount }) => {
      await new Promise<void>((resolve) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolve();
        });
        // 主动断开时客户端自身会收到 socket hang up（ECONNRESET）：这是预期现象，吞掉即可，
        // 否则会以 unhandled error 形式污染测试结果
        req.on('error', () => resolve());
        // 连接建立后立刻断开：模拟用户关页/取消
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 20);
      });
      // 等业务定时器到点，确认它因 abort 而没有写回响应
      await new Promise((r) => setTimeout(r, 80));
      expect(abortedFlags[0]).toBe(false); // 断开前未 abort
      expect(finishedCount()).toBe(0); // 断开后业务被取消，没有"白跑完"
    });
  });

  it('正常请求完整结束 → 不 abort，响应照常返回', async () => {
    await withServer(async ({ url, finishedCount }) => {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(url, (res) => {
            let data = '';
            res.on('data', (c) => (data += String(c)));
            res.on('end', () => resolve(data));
          })
          .on('error', reject);
      });
      expect(JSON.parse(body)).toEqual({ ok: true });
      await new Promise((r) => setTimeout(r, 30));
      expect(finishedCount()).toBe(1);
    });
  });

  it('客户端先断开、路由事后才注册（close 已发生过）→ signal 立即为 aborted', async () => {
    const app = express();
    let seenClose = false;
    const registered = new Promise<boolean>((resolve) => {
      app.get('/late', (req, res) => {
        // 等连接真的关闭之后再注册 helper：正是「调用之前客户端就已断开」的时序
        req.socket.on('close', () => {
          seenClose = true;
          setTimeout(() => resolve(abortOnClientClose(res).signal.aborted), 5);
        });
      });
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await new Promise<void>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/late`, (res) => res.resume());
        req.on('error', () => {
          /* 主动断开时客户端会收到 ECONNRESET：预期现象 */
        });
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 20);
      });
      const aborted = await Promise.race([
        registered,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(seenClose).toBe(true); // 前置条件成立：注册时连接确实已经关闭
      expect(aborted).toBe(true); // 修复前这里是 false（恒不 abort）
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('两条路由共用同一份实现（去重后无本地副本）', () => {
  it('watchlist.ts / quant.ts 不再各自定义 abortOnClientClose，而是从 utils/clientAbort 引入', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const routesDir = path.join(import.meta.dirname, '..', '..', 'routes');
    for (const file of ['watchlist.ts', 'quant.ts']) {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf-8');
      expect(src).toContain("from '../utils/clientAbort.js'");
      // 本地定义应已删除（避免两份实现再次分叉）
      expect(src).not.toMatch(/function abortOnClientClose\s*\(/);
    }
  });
});

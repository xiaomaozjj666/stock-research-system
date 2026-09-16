import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { createSseChannel, resolveHeartbeatMs, DEFAULT_HEARTBEAT_MS } from '../sse.js';

// ============================================================================
// SSE 共享原语的直接单测。
// 背景：createSseChannel 是深度分析流式链路的唯一出口（1~3 分钟任务的进度播报
// 与"客户端断开即协作式取消"都依赖它），但此前没有任何测试覆盖——
// utils/__tests__/ 下只有 concurrency/env/http 三个文件。
// 这里用最小假 res 对象（EventEmitter + write/setHeader 记录）直接验证契约，
// 不经过 HTTP 层，因此能精确断言断连后的行为。
// ============================================================================

/** 构造一个够用的假 Response：能触发 'close'、记录写入与响应头 */
function fakeRes(overrides: Partial<Record<string, unknown>> = {}) {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  let flushed = false;
  const res = Object.assign(emitter, {
    writableEnded: false,
    destroyed: false,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
      return res;
    },
    flushHeaders: () => {
      flushed = true;
    },
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    ...overrides,
  });
  return {
    res: res as unknown as Response,
    writes,
    headers,
    isFlushed: () => flushed,
    close: () => emitter.emit('close'),
  };
}

describe('createSseChannel 契约', () => {
  it('建立通道时设置 SSE 响应头并立即 flush（反代不缓冲）', () => {
    const f = fakeRes();
    createSseChannel({} as Request, f.res);

    expect(f.headers['Content-Type']).toBe('text/event-stream');
    expect(f.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(f.headers['Connection']).toBe('keep-alive');
    // nginx 默认会缓冲响应体，必须显式关闭，否则进度事件会被攒着一起下发
    expect(f.headers['X-Accel-Buffering']).toBe('no');
    expect(f.isFlushed()).toBe(true);
  });

  it('send 按 SSE 帧格式写入（data: <json> + 双换行）', () => {
    const f = fakeRes();
    const sse = createSseChannel({} as Request, f.res);

    sse.send({ phase: 'data', message: '数据获取中' });

    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toBe('data: {"phase":"data","message":"数据获取中"}\n\n');
  });

  it('连续多次 send 逐条分帧，不会被合并', () => {
    const f = fakeRes();
    const sse = createSseChannel({} as Request, f.res);

    sse.send({ phase: 'data' });
    sse.send({ phase: 'experts' });
    sse.send({ phase: 'arbitration' });

    expect(f.writes).toHaveLength(3);
    expect(f.writes.every((w) => w.startsWith('data: ') && w.endsWith('\n\n'))).toBe(true);
  });

  it('客户端断开（close 事件）后：isClosed 为真，send 抛 SSE_CLIENT_DISCONNECTED', () => {
    const f = fakeRes();
    const sse = createSseChannel({} as Request, f.res);
    expect(sse.isClosed()).toBe(false);

    f.close();

    expect(sse.isClosed()).toBe(true);
    // 管线依赖这个异常在阶段边界中止后续计算，因此错误消息是契约的一部分
    expect(() => sse.send({ phase: 'experts' })).toThrow('SSE_CLIENT_DISCONNECTED');
    expect(f.writes).toHaveLength(0);
  });

  it('响应已结束（writableEnded）或连接已销毁（destroyed）同样视为关闭', () => {
    const ended = fakeRes({ writableEnded: true });
    expect(createSseChannel({} as Request, ended.res).isClosed()).toBe(true);

    const destroyed = fakeRes({ destroyed: true });
    expect(createSseChannel({} as Request, destroyed.res).isClosed()).toBe(true);
  });

  it('trySend 在断开后静默放弃，不抛错也不写入', () => {
    const f = fakeRes();
    const sse = createSseChannel({} as Request, f.res);
    f.close();

    expect(() => sse.trySend({ phase: 'error', message: '收尾推送' })).not.toThrow();
    expect(f.writes).toHaveLength(0);
  });

  it('trySend 在正常连接时正常写入', () => {
    const f = fakeRes();
    const sse = createSseChannel({} as Request, f.res);

    sse.trySend({ phase: 'done' });

    expect(f.writes).toEqual(['data: {"phase":"done"}\n\n']);
  });

  it('write 抛错时 trySend 吞掉异常（收尾推送不影响响应结束）', () => {
    const f = fakeRes({
      write: () => {
        throw new Error('EPIPE');
      },
    });
    const sse = createSseChannel({} as Request, f.res);

    expect(() => sse.trySend({ phase: 'done' })).not.toThrow();
  });

  it('send 的 JSON 序列化支持嵌套结构与数组', () => {
    const f = fakeRes();
    const sse = createSseChannel({} as Request, f.res);

    sse.send({ phase: 'done', result: { stock_pool: [{ stock_code: '600519' }] } });

    expect(f.writes[0]).toBe(
      'data: {"phase":"done","result":{"stock_pool":[{"stock_code":"600519"}]}}\n\n',
    );
    expect(JSON.parse(f.writes[0].slice(6))).toEqual({
      phase: 'done',
      result: { stock_pool: [{ stock_code: '600519' }] },
    });
  });
});

// ============================================================================
// 心跳（防反向代理在静默期掐断长连接）
// 背景（审计）：此前只设了 X-Accel-Buffering: no，没有任何心跳。深度分析的
// experts → arbitration 之间可能静默 60s+，而 nginx proxy_read_timeout 默认 60s，
// 静默期一过反代就掐连接（前端表现为"分析莫名中断"）。
// 这里用假时钟精确断言"按间隔写注释帧"与"关闭后不再写"。
// ============================================================================
describe('createSseChannel 心跳', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SSE_HEARTBEAT_MS;
  });

  it('默认 15s 写一行 SSE 注释帧（: ping），不写 data 帧', () => {
    vi.useFakeTimers();
    const f = fakeRes();
    createSseChannel({} as Request, f.res);

    expect(f.writes).toHaveLength(0);
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS - 1);
    expect(f.writes).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(f.writes).toEqual([': ping\n\n']);
    // 以 ':' 开头是注释帧：客户端不会派发 message 事件（否则前端会收到空事件）
    expect(f.writes[0].startsWith(':')).toBe(true);
    expect(f.writes[0].startsWith('data:')).toBe(false);

    // 持续心跳：下一周期再来一条（60s 静默期内共 4 条）
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS * 3);
    expect(f.writes).toHaveLength(4);
  });

  it('SSE_HEARTBEAT_MS 可调（例如 1000ms）', () => {
    vi.useFakeTimers();
    process.env.SSE_HEARTBEAT_MS = '1000';
    const f = fakeRes();
    createSseChannel({} as Request, f.res);

    vi.advanceTimersByTime(3000);
    expect(f.writes).toEqual([': ping\n\n', ': ping\n\n', ': ping\n\n']);
  });

  it('SSE_HEARTBEAT_MS=0 时关闭心跳（完全不写）', () => {
    vi.useFakeTimers();
    process.env.SSE_HEARTBEAT_MS = '0';
    const f = fakeRes();
    createSseChannel({} as Request, f.res);

    vi.advanceTimersByTime(120_000);
    expect(f.writes).toHaveLength(0);
  });

  it('SSE_HEARTBEAT_MS 非法（非数值/负数）时回落：非法→默认，负数→关闭', () => {
    expect(resolveHeartbeatMs()).toBe(DEFAULT_HEARTBEAT_MS);
    process.env.SSE_HEARTBEAT_MS = 'abc';
    expect(resolveHeartbeatMs()).toBe(DEFAULT_HEARTBEAT_MS);
    process.env.SSE_HEARTBEAT_MS = '-1';
    expect(resolveHeartbeatMs()).toBe(0);

    vi.useFakeTimers();
    process.env.SSE_HEARTBEAT_MS = 'abc';
    const f = fakeRes();
    createSseChannel({} as Request, f.res);
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS);
    expect(f.writes).toEqual([': ping\n\n']);
  });

  it('通道关闭（close 事件）后心跳定时器被清理，不再写入', () => {
    vi.useFakeTimers();
    const f = fakeRes();
    createSseChannel({} as Request, f.res);

    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS);
    expect(f.writes).toHaveLength(1);

    f.close(); // 客户端断开

    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS * 4);
    expect(f.writes).toHaveLength(1); // 关闭后一帧都不该再写
  });

  it('响应已结束（writableEnded / destroyed）后不再写心跳', () => {
    vi.useFakeTimers();

    const ended = fakeRes();
    const sseEnded = createSseChannel({} as Request, ended.res);
    (ended.res as unknown as { writableEnded: boolean }).writableEnded = true;
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS * 2);
    expect(ended.writes).toHaveLength(0);
    expect(sseEnded.isClosed()).toBe(true);

    const destroyed = fakeRes();
    createSseChannel({} as Request, destroyed.res);
    (destroyed.res as unknown as { destroyed: boolean }).destroyed = true;
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS * 2);
    expect(destroyed.writes).toHaveLength(0);
  });

  it('显式 stopHeartbeat 立即停表（幂等，可重复调用）', () => {
    vi.useFakeTimers();
    const f = fakeRes();
    const sse = createSseChannel({} as Request, f.res);

    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS);
    expect(f.writes).toHaveLength(1);

    sse.stopHeartbeat();
    sse.stopHeartbeat();
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS * 3);
    expect(f.writes).toHaveLength(1);
    // 停心跳 ≠ 关闭通道：send 仍可用
    expect(sse.isClosed()).toBe(false);
    sse.send({ phase: 'done' });
    expect(f.writes).toHaveLength(2);
  });

  it('心跳不干扰 send / trySend / isClosed 契约', () => {
    vi.useFakeTimers();
    const f = fakeRes();
    const sse = createSseChannel({} as Request, f.res);

    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS * 2);
    // 心跳只写注释帧，不把连接标成已关闭
    expect(sse.isClosed()).toBe(false);
    expect(f.writes).toEqual([': ping\n\n', ': ping\n\n']);

    sse.send({ phase: 'experts' });
    sse.trySend({ phase: 'done' });
    expect(f.writes.slice(2)).toEqual([
      'data: {"phase":"experts"}\n\n',
      'data: {"phase":"done"}\n\n',
    ]);

    // 断开后：心跳停、send 抛既有错误码、trySend 静默
    f.close();
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS * 2);
    expect(f.writes).toHaveLength(4);
    expect(() => sse.send({ phase: 'arbitration' })).toThrow('SSE_CLIENT_DISCONNECTED');
    expect(() => sse.trySend({ phase: 'error' })).not.toThrow();
    expect(f.writes).toHaveLength(4);
  });

  it('心跳写入抛错（EPIPE）时停表，不会把异常抛给调用方', () => {
    vi.useFakeTimers();
    const f = fakeRes({
      write: () => {
        throw new Error('EPIPE');
      },
    });
    createSseChannel({} as Request, f.res);

    expect(() => vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS * 3)).not.toThrow();
  });
});

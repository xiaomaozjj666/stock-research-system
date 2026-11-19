/**
 * MCP SSE 帧解析纯函数测试（与外部协议对接的手写边界，此前零覆盖）
 * ----------------------------------------------------------------------------
 * 覆盖：CRLF/LF/CR 三种事件边界、跨 chunk 的半事件保留、多行 data 拼接、
 * event/data 行取值规则、注释行忽略。
 */
import { describe, it, expect } from 'vitest';
import { parseSseEvent, splitSseEvents } from '../mcpClient.js';

describe('splitSseEvents — 事件边界切分', () => {
  it('CRLF 边界（严格 SSE 规范）', () => {
    const { events, rest } = splitSseEvents('data: a\r\n\r\ndata: b\r\n\r\n');
    expect(events).toEqual(['data: a', 'data: b']);
    expect(rest).toBe('');
  });

  it('LF 边界与 CR 边界（宽松服务端兼容）', () => {
    expect(splitSseEvents('data: a\n\ndata: b\n\n').events).toEqual(['data: a', 'data: b']);
    expect(splitSseEvents('data: a\r\rdata: b\r\r').events).toEqual(['data: a', 'data: b']);
  });

  it('跨 chunk 的半事件保留在 rest 中（不丢失、不提前分发）', () => {
    const first = splitSseEvents('data: he');
    expect(first.events).toEqual([]);
    expect(first.rest).toBe('data: he');
    const second = splitSseEvents(first.rest + 'llo\n\n');
    expect(second.events).toEqual(['data: hello']);
    expect(second.rest).toBe('');
  });

  it('混合换行风格（\r\n 与 \n 混用）仍按各自边界切分', () => {
    // 事件原文按 SSE 规范保留行终止符（如 \r 留在原文内），断言走「切分→解析」组合
    const { events, rest } = splitSseEvents('data: 1\r\n\ndata: 2\n\ndata: 3\r\n\r\n');
    expect(rest).toBe('');
    expect(events.map((e) => parseSseEvent(e).data)).toEqual(['1', '2', '3']);
  });
});

describe('parseSseEvent — 行级解析', () => {
  it('event 行取类型（默认 message）', () => {
    expect(parseSseEvent('event: endpoint\ndata: /post')).toEqual({
      event: 'endpoint',
      data: '/post',
    });
    expect(parseSseEvent('data: {}').event).toBe('message');
  });

  it('多行 data 按 SSE 规范以 LF 拼接', () => {
    expect(parseSseEvent('data: line1\ndata: line2').data).toBe('line1\nline2');
  });

  it('data 冒号后的单个空格被剥掉，其余空格保留', () => {
    expect(parseSseEvent('data:  two spaces').data).toBe(' two spaces');
    expect(parseSseEvent('data:nospace').data).toBe('nospace');
  });

  it('CRLF 行内的 event/data 行同样解析', () => {
    expect(parseSseEvent('event: endpoint\r\ndata: /rpc')).toEqual({
      event: 'endpoint',
      data: '/rpc',
    });
  });

  it('注释行（: ping）与 id/retry 行被忽略', () => {
    const ev = parseSseEvent(': heartbeat\nid: 7\ndata: {"x":1}\nretry: 100');
    expect(ev.event).toBe('message');
    expect(ev.data).toBe('{"x":1}');
  });
});

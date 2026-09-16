/**
 * ============================================================================
 * 请求日志脱敏的回归测试（index.ts 的 "HTTP request" 日志 + utils/logSanitize.ts）
 *
 * 背景（审计）：请求日志此前记录完整 req.originalUrl，而本系统把用户原文放在
 * query 里 —— GET /api/chat/stream?message=<用户原话>、GET /api/stocks/search?keyword=<人名>。
 * 这些值一旦写进日志文件就外泄了（span 侧见 services/__tests__/telemetry.test.ts）。
 *
 * 做法：把 process.stdout.write（logger 的 info 出口）在**请求期间**短暂劫持，
 * 取出这一条 "HTTP request" JSON 行，断言"看不到值、看得到路径与键名"。
 * ============================================================================
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { setLogLevel } from '../utils/logger.js';

const mocks = vi.hoisted(() => ({
  chatRunStream: vi.fn(),
  chatRun: vi.fn(),
  searchStocks: vi.fn(),
}));

vi.mock('../services/chatAgent.js', () => ({
  chatAgent: { run: mocks.chatRun, runStream: mocks.chatRunStream },
}));

vi.mock('../services/dataService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dataService.js')>();
  return { ...actual, searchStocks: mocks.searchStocks };
});

import { app } from '../index.js';

// setup.ts 默认把日志压到 error（路由测试降噪）；本文件必须真正看到 info 级请求日志
setLogLevel('info');
afterAll(() => {
  setLogLevel('error');
});

beforeEach(() => {
  mocks.chatRun.mockReset();
  mocks.chatRunStream.mockReset();
  mocks.searchStocks.mockReset();
  mocks.chatRunStream.mockResolvedValue(undefined);
  mocks.searchStocks.mockResolvedValue([]);
});

/** 在请求期间劫持 stdout，收集 logger 写出的 JSON 行（请求结束后立刻还回去） */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

/** 取出这一次请求的 "HTTP request" 日志行（JSON 一行） */
function httpRequestLine(lines: string[], path: string): string {
  const line = lines.find((l) => l.includes('"HTTP request"') && l.includes(path));
  expect(line, `未找到路径为 ${path} 的请求日志：${lines.join('')}`).toBeDefined();
  return line as string;
}

describe('请求日志：敏感 query 不入日志', () => {
  it('GET /api/chat/stream?message=<用户原话>：值被抹掉，路径与键名仍在', async () => {
    const secret = '敏感内容ABC-LEAK';
    const lines = await captureStdout(async () => {
      await request(app).get('/api/chat/stream').query({ message: secret, sessionId: 'sess-1' });
    });

    const line = httpRequestLine(lines, '/api/chat/stream');

    // 明文与百分号编码两种形态都不能出现（LEAK 是 ASCII，编码后仍在 URL 里）
    expect(line).not.toContain('LEAK');
    expect(line).not.toContain(encodeURIComponent(secret));
    expect(line).not.toContain('sess-1');
    // 排障信息保留：路径、参数键名、占位符
    expect(line).toContain('/api/chat/stream');
    expect(line).toContain('message=[redacted]');
    expect(line).toContain('sessionId=[redacted]');
    // 日志行本身仍是合法 JSON，结构化采集不受影响
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('GET /api/stocks/search?keyword=<搜索词>：值被抹掉，白名单参数保留原值', async () => {
    const keyword = '张三LEAK';
    const lines = await captureStdout(async () => {
      await request(app).get('/api/stocks/search').query({ keyword, limit: 5 });
    });

    const line = httpRequestLine(lines, '/api/stocks/search');

    expect(line).not.toContain('LEAK');
    expect(line).not.toContain(encodeURIComponent(keyword));
    expect(line).toContain('/api/stocks/search');
    expect(line).toContain('keyword=[redacted]');
    // limit 在白名单内：值照旧记录（无隐私，丢了反而没法排障）
    expect(line).toContain('limit=5');
  });

  it('无敏感参数的请求不受影响：url 字段与改动前逐字一致', async () => {
    const lines = await captureStdout(async () => {
      await request(app).get('/api/history').query({ limit: 5 });
    });

    const line = httpRequestLine(lines, '/api/history');
    const parsed = JSON.parse(line) as { context: { url: string; method: string } };

    expect(parsed.context.method).toBe('GET');
    expect(parsed.context.url).toBe('/api/history?limit=5');
  });

  it('无 query 的请求 url 字段保持路径原样（不额外加问号）', async () => {
    const lines = await captureStdout(async () => {
      await request(app).get('/api/nonexistent-for-log-test');
    });

    const line = httpRequestLine(lines, '/api/nonexistent-for-log-test');
    const parsed = JSON.parse(line) as { context: { url: string } };

    expect(parsed.context.url).toBe('/api/nonexistent-for-log-test');
  });
});

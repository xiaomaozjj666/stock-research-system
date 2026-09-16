/**
 * ============================================================================
 * 生产环境 detail 泄漏统一收口的回归测试（utils/errorDetail.ts）
 *
 * 背景（审计）：index.ts 的通用错误中间件早就按 NODE_ENV 决定是否回传 detail，
 * 但**路由内 catch** 绕过它、无条件回传 `error.message`。而 error.message 里
 * 常有上游 URL（push2.eastmoney.com/...）、本机文件路径（/app/server/src/*.ts:255）、
 * 内部标识——生产环境回给调用方就是信息泄漏。
 *
 * 本文件锁定两点：
 *   1) errorDetail 自身的 prod/non-prod 语义；
 *   2) 两个真实路由（/api/chat、/api/audit）在两种 NODE_ENV 下的响应体差异——
 *      生产环境**不带 detail 字段**，非生产环境带（本地排障需要）。
 * ============================================================================
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { errorDetail } from '../utils/errorDetail.js';

/** 带"泄漏特征"的错误：上游域名 + 文件路径 + 行号 */
const LEAK_MESSAGE =
  '上游 http://push2.eastmoney.com/api/qt/stock/get 返回 500，at fetchQuote (/app/server/src/services/dataService.ts:255)';
const LEAK = new Error(LEAK_MESSAGE);

const mocks = vi.hoisted(() => ({
  chatRun: vi.fn(),
  chatRunStream: vi.fn(),
}));

vi.mock('../services/chatAgent.js', () => ({
  chatAgent: { run: mocks.chatRun, runStream: mocks.chatRunStream },
}));

import { app } from '../index.js';
import { auditLogger } from '../services/auditLog.js';

const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  mocks.chatRun.mockReset();
  mocks.chatRunStream.mockReset();
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

/** 断言响应体里没有泄漏特征（生产环境的通用检查） */
function expectNoLeak(body: unknown): void {
  const raw = JSON.stringify(body);
  expect(raw).not.toContain('eastmoney');
  expect(raw).not.toContain('/app/server');
  expect(raw).not.toContain('.ts:255');
  expect(raw).not.toContain('http://');
}

describe('errorDetail() 语义', () => {
  it('生产环境返回 undefined（detail 字段会从响应体消失）', () => {
    process.env.NODE_ENV = 'production';
    expect(errorDetail(LEAK)).toBeUndefined();
  });

  it('非生产环境返回 err.message（本地/测试需要完整原因）', () => {
    process.env.NODE_ENV = 'test';
    expect(errorDetail(LEAK)).toBe(LEAK_MESSAGE);
    process.env.NODE_ENV = 'development';
    expect(errorDetail(LEAK)).toBe(LEAK_MESSAGE);
  });

  it('非 Error 抛出物：字符串原样、null/undefined 归 undefined、其余 String 化', () => {
    process.env.NODE_ENV = 'test';
    expect(errorDetail('boom')).toBe('boom');
    expect(errorDetail(null)).toBeUndefined();
    expect(errorDetail(undefined)).toBeUndefined();
    expect(errorDetail({ code: 'E_X' })).toBe('[object Object]');
  });
});

describe('路由内 catch 的 detail 收口', () => {
  it('/api/chat：生产环境 500 响应体不含 detail（也不含上游 URL / 路径）', async () => {
    mocks.chatRun.mockRejectedValue(LEAK);
    process.env.NODE_ENV = 'production';

    const res = await request(app).post('/api/chat').send({ message: '茅台怎么样' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('对话处理失败');
    expect(res.body).not.toHaveProperty('detail');
    expectNoLeak(res.body);
  });

  it('/api/chat：非生产环境 500 响应体带 detail（排障口径不变）', async () => {
    mocks.chatRun.mockRejectedValue(LEAK);
    process.env.NODE_ENV = 'test';

    const res = await request(app).post('/api/chat').send({ message: '茅台怎么样' });

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe(LEAK_MESSAGE);
  });

  it('/api/audit：生产环境 500 响应体不含 detail', async () => {
    vi.spyOn(auditLogger, 'query').mockImplementation(() => {
      throw LEAK;
    });
    process.env.NODE_ENV = 'production';

    const res = await request(app).get('/api/audit');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('审计查询失败');
    expect(res.body).not.toHaveProperty('detail');
    expectNoLeak(res.body);
  });

  it('/api/audit：非生产环境 500 响应体带 detail', async () => {
    vi.spyOn(auditLogger, 'query').mockImplementation(() => {
      throw LEAK;
    });
    process.env.NODE_ENV = 'test';

    const res = await request(app).get('/api/audit');

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe(LEAK_MESSAGE);
  });

  it('业务上有意设计的固定中文 detail 不受影响（400 校验提示照旧回传）', async () => {
    process.env.NODE_ENV = 'production';

    const res = await request(app)
      .post('/api/paper/order')
      .send({ code: '600519', side: 'buy', type: 'limit', quantity: 100 });

    expect(res.status).toBe(400);
    // 「限价单需提供正价格」是给调用方的可操作指引，生产环境也必须原样返回
    expect(res.body.detail).toBe('限价单需提供正价格');
  });
});

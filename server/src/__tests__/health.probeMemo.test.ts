import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * /api/health 外呼 memo（P1：健康探针每次请求都外呼 + GET 写盘）
 * ----------------------------------------------------------------------------
 * 背景（审计）：GET /api/health 对每次请求都发一次 eastmoney HEAD——监控探针的频率
 * 直接等于对外请求频率；早期实现还在 GET 里 mkdirSync 缓存目录（读接口写盘）。
 *
 * 本文件锁定两件事：
 *  1) 外呼 memo：窗口内重复探测只外呼一次，第二次如实标 cached=true；窗口过期或
 *     显式清缓存后能重新外呼（memo 不能变成"永远不更新"）；
 *  2) GET 只读：缓存目录不存在时只报告 missing，**不会创建目录**。
 */

// memo 窗口在本文件里显式指定（与 health.degraded.test.ts 用窗口 0 关闭 memo 的做法互补）：
// 默认值是 60s，这里写明是为了让「窗口内 / 过期后」两个分支都可确定性验证。
vi.hoisted(() => {
  process.env.HEALTH_PROBE_MEMO_MS = '60000';
});

import { app } from '../index.js';
import { resetHealthProbeCache } from '../routes/health.js';

const fetchMock = vi.fn();

const origMemoMs = process.env.HEALTH_PROBE_MEMO_MS;
const origCacheDir = process.env.DATA_CACHE_DIR;

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (origMemoMs === undefined) delete process.env.HEALTH_PROBE_MEMO_MS;
  else process.env.HEALTH_PROBE_MEMO_MS = origMemoMs;
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
});

beforeEach(() => {
  // 用 mockReset（而非 mockClear）：并发用例会换成"手动放行"的挂起实现，
  // 必须连同实现一起复位，否则会串到后续用例。
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  process.env.HEALTH_PROBE_MEMO_MS = '60000';
  resetHealthProbeCache();
});

afterEach(() => {
  resetHealthProbeCache();
});

describe('GET /api/health 外呼 memo', () => {
  it('窗口内重复请求只外呼一次，第二次如实标注 cached=true（且 checkedAt 是同一时刻）', async () => {
    const first = await request(app).get('/api/health');
    const second = await request(app).get('/api/health');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.body.externalApi).toMatchObject({ status: 'reachable', cached: false });
    expect(second.body.externalApi).toMatchObject({ status: 'reachable', cached: true });
    // 复用 memo 时不能伪造"刚刚探测过"：checkedAt 必须是真实探测那一刻
    expect(second.body.externalApi.checkedAt).toBe(first.body.externalApi.checkedAt);
    expect(typeof first.body.externalApi.checkedAt).toBe('string');
  });

  it('失败结论同样进 memo（上游不可达时不会每个探针都打一次外呼）', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    const first = await request(app).get('/api/health');
    const second = await request(app).get('/api/health');

    expect(first.status).toBe(503);
    expect(first.body.externalApi).toMatchObject({ status: 'unreachable', cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(503);
    expect(second.body.externalApi).toMatchObject({ status: 'unreachable', cached: true });
  });

  it('窗口过期后重新外呼（memo 不是"永不更新"）', async () => {
    process.env.HEALTH_PROBE_MEMO_MS = '5';
    await request(app).get('/api/health');
    await new Promise((r) => setTimeout(r, 30));
    await request(app).get('/api/health');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resetHealthProbeCache 后重新外呼（测试/运维排查入口可用）', async () => {
    await request(app).get('/api/health');
    resetHealthProbeCache();
    await request(app).get('/api/health');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('并发探针共享同一次外呼（10 个并发不发 10 个 HEAD）', async () => {
    const pending: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));

    const requests = Promise.all(Array.from({ length: 10 }, () => request(app).get('/api/health')));
    // 等所有请求都进到探测点（同一在途 promise），再放行
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    pending.forEach((resolve) => resolve(new Response(null, { status: 200 })));
    const results = await requests;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const res of results) expect(res.status).toBe(200);
  });
});

describe('GET /api/health 只读（不写盘）', () => {
  it('缓存目录不存在：只报告 missing，不会创建目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srs-health-nowrite-'));
    const missing = join(dir, 'not-created-yet');
    process.env.DATA_CACHE_DIR = missing;

    try {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.cacheDir).toEqual({ status: 'missing', path: missing });
      expect(res.body.quantCacheDir).toEqual({ status: 'missing', path: missing });
      // 关键：读接口不产生写盘副作用（早期实现在 GET 里 mkdirSync，把 missing 掩盖成 ok）
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

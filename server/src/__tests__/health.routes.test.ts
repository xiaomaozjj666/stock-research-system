/**
 * /api/health 的缓存目录检查：
 * - 目录解析必须复用各缓存模块自身的逻辑（DATA_CACHE_DIR 生效），而不是硬编码路径；
 * - GET 只读：不得在健康检查里创建目录（早期实现 mkdirSync，读接口带写副作用，
 *   还会把「目录尚未创建」掩盖成 ok）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../index.js';

// /api/health 会对外网发 HEAD 请求，stub fetch 隔离网络（离线 CI 下避免撞 5s 超时）
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const origCacheDir = process.env.DATA_CACHE_DIR;
let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'srs-health-'));
});
afterEach(() => {
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/health — 缓存目录检查', () => {
  it('DATA_CACHE_DIR 生效：报告真实缓存目录，并同时给出量化缓存目录', async () => {
    process.env.DATA_CACHE_DIR = tmpDir;
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.cacheDir).toMatchObject({ status: 'ok', path: tmpDir });
    // 量化缓存走同一口径解析：共享 DATA_CACHE_DIR 时两处路径一致（修复前此处看不到量化目录）
    expect(res.body.quantCacheDir).toMatchObject({ status: 'ok', path: tmpDir });
  });

  it('目录不存在时只报告 missing，且不在 GET 里创建目录', async () => {
    const missing = join(tmpDir, 'not-created');
    process.env.DATA_CACHE_DIR = missing;

    const res = await request(app).get('/api/health');

    // 目录尚未创建（全新部署/尚无任何分析）不算故障，但必须如实报告状态
    expect(res.status).toBe(200);
    expect(res.body.cacheDir).toMatchObject({ status: 'missing', path: missing });
    expect(fs.existsSync(missing)).toBe(false); // 只读探针不得写盘
  });
});

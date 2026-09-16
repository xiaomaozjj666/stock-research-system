/**
 * ============================================================================
 * GET /api/health 降级（503）分支测试 —— 防的是「健康检查永远返回 ok」。
 *
 * 背景（审计）：routes/health.ts 的 503 判定（外部行情源不可达 或 缓存目录
 * 有错误）此前无任何测试；既有 health.routes.test.ts 只覆盖了 200 的缓存目录报告。
 * 若该判定被改坏（例如 hasErrors 恒 false、或 status 忘记置 503），监控会把
 * 「行情源已断、无法出报告」的实例当成健康实例，本文件让这种回归立刻变红。
 *
 * 隔离：外部探测（fetch eastmoney HEAD）用 stubGlobal 打桩为"不可达"，不触网络；
 * 缓存目录权限失败用 fs 模块的部分 mock（accessSync 抛 EACCES）注入——真去 chmod
 * 在 Windows 上不可靠，改用注入是唯一跨平台的确定性做法。缓存目录用 tmpdir 真实路径，
 * GET 只读探测不写盘。
 * ============================================================================
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// routes/health.ts 的外呼探测带 60 秒 memo（HEALTH_PROBE_MEMO_MS，见 health.probeMemo.test.ts）。
// 本文件会在用例之间切换 fetch 打桩结果（不可达 → 可达），进程级 memo 会把用例 1 的
// 「不可达」结论串味到用例 2；故这里显式把窗口设为 0 关闭 memo——memo 自身的行为
// 由 health.probeMemo.test.ts 用显式窗口独立验证，不靠这里的默认值。
vi.hoisted(() => {
  process.env.HEALTH_PROBE_MEMO_MS = '0';
});

/** 指定的"不可写目录"：只有它访问失败，其余路径走真实 fs */
const blockedDir = { value: '' };

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    // 显式标出被 mock 的函数，让"权限失败"成为受控输入而非环境依赖
    accessSync: vi.fn(((target: unknown, mode?: number) => {
      if (blockedDir.value && String(target) === blockedDir.value) {
        const err = new Error(
          `EACCES: permission denied, access '${String(target)}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return actual.accessSync(target as Parameters<typeof actual.accessSync>[0], mode);
    }) as unknown as typeof actual.accessSync),
  };
});

import { app } from '../index.js';

/** 让外部探测表现为"不可达"：fetch 直接抛错（等价 DNS/连接失败） */
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    }),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const origCacheDir = process.env.DATA_CACHE_DIR;
let tmpDir = '';

afterEach(() => {
  blockedDir.value = '';
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('GET /api/health — 503 降级分支', () => {
  it('外部行情源不可达 → 503，且响应体仍含 status/cacheDir/quantCacheDir/externalApi 等既有字段', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'srs-health-503-'));
    process.env.DATA_CACHE_DIR = tmpDir;

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    // 降级时结构不能被裁掉：监控/前端仍按同一 schema 解析
    expect(res.body.status).toBe('ok'); // 进程自身健康
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.memory).toBe('object');
    expect(res.body.externalApi).toMatchObject({ status: 'unreachable' });
    expect(res.body.externalApi.error).toContain('ECONNREFUSED');
    // 缓存目录字段照常报告（目录存在 → ok）
    expect(res.body.cacheDir).toMatchObject({ status: 'ok', path: tmpDir });
    expect(res.body.quantCacheDir).toMatchObject({ status: 'ok', path: tmpDir });
  });

  it('外部可达但缓存目录不可写 → 503，cacheDir.status=error 且带 error 详情', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'srs-health-503-'));
    process.env.DATA_CACHE_DIR = tmpDir;
    blockedDir.value = tmpDir;
    // 外部探测恢复正常，只让缓存目录权限检查失败
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.externalApi).toMatchObject({ status: 'reachable' });
    expect(res.body.cacheDir).toMatchObject({ status: 'error', path: tmpDir });
    expect(res.body.cacheDir.error).toContain('EACCES');
    // 同一路径下两套缓存共用目录，故此处也会是 error；关键是它必须与 cacheDir 分别报告
    expect(res.body.quantCacheDir.status).toBe('error');
  });

  it('两个探测都正常 → 200（对照组，确认 503 不是恒真）', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'srs-health-503-'));
    process.env.DATA_CACHE_DIR = tmpDir;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.externalApi).toMatchObject({ status: 'reachable', httpStatus: 200 });
    expect(res.body.cacheDir.status).toBe('ok');
  });
});

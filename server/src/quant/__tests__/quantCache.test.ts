import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getQuantCacheDir,
  isCacheFresh,
  pruneQuantCache,
  readCacheEntry,
  sanitizeCacheKey,
  withQuantCache,
  writeCacheEntry,
} from '../quantCache.js';

/**
 * 量化缓存工具单测：TTL 读写、key 清洗、损坏容错、withQuantCache 的命中/旁路、
 * prune 的逐文件过期删除与容量淘汰。
 * 目录经 DATA_CACHE_DIR 重定向到进程专属临时目录，杜绝写真实 quant/cache。
 */
let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;

beforeEach(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-quant-cache-util-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/** 把缓存文件的时间戳改旧，模拟「已过期」 */
function ageFile(key: string, ageMs: number): void {
  const file = join(getQuantCacheDir(), `${sanitizeCacheKey(key)}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { timestamp: number };
  parsed.timestamp = Date.now() - ageMs;
  fs.writeFileSync(file, JSON.stringify(parsed));
}

describe('读写与新鲜度', () => {
  it('write → read 往返，携带写入时刻的 timestamp', () => {
    writeCacheEntry('k_a', { v: 1 }, 60_000);
    const hit = readCacheEntry<{ v: number }>('k_a');
    expect(hit).not.toBeNull();
    expect(hit?.data).toEqual({ v: 1 });
    expect(Math.abs((hit?.timestamp ?? 0) - Date.now())).toBeLessThan(5_000);
  });

  it('key 经白名单清洗：路径穿越被拦截，读写走同一清洗', () => {
    writeCacheEntry('../../etc/passwd', { v: 1 }, 60_000);
    const files = fs.readdirSync(getQuantCacheDir());
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('..');
    expect(files[0]).toBe(`${sanitizeCacheKey('../../etc/passwd')}.json`);
    // 读也走同一清洗，能命中同一文件
    expect(readCacheEntry('../../etc/passwd')).not.toBeNull();
  });

  it('损坏的缓存文件读取返回 null（交由 prune 物理删除）', () => {
    fs.writeFileSync(join(getQuantCacheDir(), 'broken.json'), 'not-json{{', 'utf-8');
    expect(readCacheEntry('broken')).toBeNull();
  });

  it('isCacheFresh：窗口内 true / 超窗 false / 非法 timestamp false', () => {
    expect(isCacheFresh(Date.now() - 1_000, 60_000)).toBe(true);
    expect(isCacheFresh(Date.now() - 120_000, 60_000)).toBe(false);
    expect(isCacheFresh(Number.NaN, 60_000)).toBe(false);
  });
});

describe('withQuantCache — TTL 与旁路', () => {
  it('命中且新鲜 → 不执行 producer', async () => {
    writeCacheEntry('w_a', { n: 1 }, 60_000);
    const producer = vi.fn(async () => ({ n: 2 }));
    const r = await withQuantCache('w_a', 60_000, producer);
    expect(r).toEqual({ n: 1 });
    expect(producer).not.toHaveBeenCalled();
  });

  it('未命中 → 执行 producer 并回写', async () => {
    const producer = vi.fn(async () => ({ n: 7 }));
    const r = await withQuantCache('w_b', 60_000, producer);
    expect(r).toEqual({ n: 7 });
    expect(producer).toHaveBeenCalledTimes(1);
    expect(readCacheEntry<{ n: number }>('w_b')?.data).toEqual({ n: 7 });
  });

  it('超 TTL → 再次执行 producer 并覆盖', async () => {
    writeCacheEntry('w_c', { n: 1 }, 60_000);
    ageFile('w_c', 120_000);
    const producer = vi.fn(async () => ({ n: 9 }));
    const r = await withQuantCache('w_c', 60_000, producer);
    expect(r).toEqual({ n: 9 });
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('ttlMs <= 0 → 缓存关闭：每次都执行 producer 且不写文件', async () => {
    const producer = vi.fn(async () => ({ n: 3 }));
    await withQuantCache('w_d', 0, producer);
    await withQuantCache('w_d', 0, producer);
    expect(producer).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(getQuantCacheDir())).toHaveLength(0);
  });

  it('producer 抛错 → 不写缓存，错误原样上抛', async () => {
    await expect(
      withQuantCache('w_e', 60_000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(readCacheEntry('w_e')).toBeNull();
  });
});

describe('pruneQuantCache — 过期删除与容量淘汰', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('过期与损坏文件删除，未过期保留', async () => {
    writeCacheEntry('p_fresh', { v: 1 }, 30 * DAY);
    writeCacheEntry('p_old', { v: 2 }, 1 * DAY);
    ageFile('p_old', 2 * DAY); // 超过其 1 天 TTL
    fs.writeFileSync(join(getQuantCacheDir(), 'p_broken.json'), 'zzz', 'utf-8');

    const { removed } = await pruneQuantCache();
    expect(removed).toBe(2);
    expect(fs.existsSync(join(getQuantCacheDir(), 'p_old.json'))).toBe(false);
    expect(fs.existsSync(join(getQuantCacheDir(), 'p_broken.json'))).toBe(false);
    expect(readCacheEntry('p_fresh')).not.toBeNull();
  });

  it('存活数超上限 → 按写入时间从最旧淘汰', async () => {
    writeCacheEntry('c_a', { v: 1 }, 30 * DAY);
    writeCacheEntry('c_b', { v: 2 }, 30 * DAY);
    writeCacheEntry('c_c', { v: 3 }, 30 * DAY);

    const { removed } = await pruneQuantCache({ maxFiles: 2 });
    expect(removed).toBe(1);
    const remaining = fs.readdirSync(getQuantCacheDir()).filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(2);
    // 被淘汰的应是最旧的 c_a
    expect(fs.existsSync(join(getQuantCacheDir(), 'c_a.json'))).toBe(false);
    expect(fs.existsSync(join(getQuantCacheDir(), 'c_c.json'))).toBe(true);
  });

  it('旧格式文件（缺 ttlMs）视为过期删除——历史残留自愈式清理', async () => {
    // 2026-09-05 之前的分片缓存文件格式 {data, timestamp}，无 ttlMs 字段
    fs.writeFileSync(
      join(getQuantCacheDir(), '600519_2024-01-01_2026-09-05.json'),
      JSON.stringify({ data: [], timestamp: Date.now() }),
      'utf-8',
    );
    const { removed } = await pruneQuantCache();
    expect(removed).toBe(1);
  });

  it('目录不存在 → 静默降级返回 0', async () => {
    process.env.DATA_CACHE_DIR = join(CACHE_DIR, 'no-such-dir');
    const { removed } = await pruneQuantCache();
    expect(removed).toBe(0);
  });

  it('共享 DATA_CACHE_DIR 时不误删 dataService 股票缓存（本类不清异类）', async () => {
    // 新格式：带 kind='stocks'，文件名为 6 位股票代码（dataService 的写法）
    fs.writeFileSync(
      join(getQuantCacheDir(), '600519.json'),
      JSON.stringify({ kind: 'stocks', data: { info: { code: '600519' } }, timestamp: Date.now() }),
      'utf-8',
    );
    // 旧格式（无 kind、无 ttlMs）：历史股票缓存也不能当成「缺 ttlMs 的旧量化条目」删掉
    fs.writeFileSync(
      join(getQuantCacheDir(), '000858.json'),
      JSON.stringify({ data: { info: { code: '000858' } }, timestamp: Date.now() }),
      'utf-8',
    );
    // 本类里真正过期的条目：仍然要删
    writeCacheEntry('k_old', { v: 1 }, 1_000);
    ageFile('k_old', 60_000);

    const { removed } = await pruneQuantCache();
    expect(removed).toBe(1);
    const left = fs.readdirSync(getQuantCacheDir()).sort();
    expect(left).toEqual(['000858.json', '600519.json']);
  });

  it('容量淘汰只统计本类条目（跨类不互相挤占、也不误删）', async () => {
    fs.writeFileSync(
      join(getQuantCacheDir(), '600519.json'),
      JSON.stringify({ kind: 'stocks', data: {}, timestamp: Date.now() - 10_000 }),
      'utf-8',
    );
    writeCacheEntry('c_x', { v: 1 }, 30 * DAY);
    writeCacheEntry('c_y', { v: 2 }, 30 * DAY);
    writeCacheEntry('c_z', { v: 3 }, 30 * DAY);

    // 上限 2：本类 3 条 → 淘汰 1 条；异类（股票缓存）不计入也不被淘汰
    const { removed } = await pruneQuantCache({ maxFiles: 2 });
    expect(removed).toBe(1);
    expect(fs.existsSync(join(getQuantCacheDir(), '600519.json'))).toBe(true);
  });
});

describe('quantCache — 与 dataService 条目互不误读', () => {
  it('同名文件若是股票缓存条目 → 视为未命中（不把股票数据集当量化缓存用）', () => {
    fs.writeFileSync(
      join(getQuantCacheDir(), '600519.json'),
      JSON.stringify({ kind: 'stocks', data: { info: {} }, timestamp: Date.now() }),
      'utf-8',
    );
    expect(readCacheEntry('600519')).toBeNull();
  });

  it('旧格式量化条目（无 kind 但有 ttlMs）仍可读——升级不丢缓存', () => {
    fs.writeFileSync(
      join(getQuantCacheDir(), 'legacy_k.json'),
      JSON.stringify({ data: { v: 5 }, timestamp: Date.now(), ttlMs: 60_000 }),
      'utf-8',
    );
    expect(readCacheEntry<{ v: number }>('legacy_k')?.data).toEqual({ v: 5 });
  });
});

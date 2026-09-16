import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('pruneFileCache 磁盘缓存清理（H-05）', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-cache-'));
    process.env.DATA_CACHE_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_CACHE_DIR;
    delete process.env.CACHE_TTL_HOURS;
    vi.resetModules();
  });

  async function loadModule() {
    const mod = await import('../dataService.js');
    return mod;
  }

  function writeCache(file: string, timestamp: number) {
    fs.writeFileSync(
      path.join(tmpDir, file),
      JSON.stringify({ data: { info: {} }, timestamp }, null, 2),
      'utf-8',
    );
  }

  it('删除已过 TTL 的缓存文件与损坏文件，保留有效文件', async () => {
    const now = Date.now();
    writeCache('valid.json', now); // 未过期
    writeCache('expired.json', now - 25 * 60 * 60 * 1000); // 超 24h TTL
    fs.writeFileSync(path.join(tmpDir, 'corrupt.json'), '{not-json', 'utf-8');

    const { pruneFileCache } = await loadModule();
    const { removed } = await pruneFileCache();

    expect(removed).toBe(2);
    const left = fs.readdirSync(tmpDir).sort();
    expect(left).toEqual(['valid.json']);
  });

  it('数量超过上限时按写入时间淘汰最旧文件', async () => {
    process.env.FILE_CACHE_MAX = '3';
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      writeCache(`s${i}.json`, now - (5 - i) * 1000); // s0 最旧，s4 最新
    }

    const { pruneFileCache } = await loadModule();
    const { removed } = await pruneFileCache();

    expect(removed).toBe(2);
    const left = fs.readdirSync(tmpDir).sort();
    expect(left).toEqual(['s2.json', 's3.json', 's4.json']);
  });

  it('空目录不报错', async () => {
    const { pruneFileCache } = await loadModule();
    const { removed } = await pruneFileCache();
    expect(removed).toBe(0);
  });

  it('共享 DATA_CACHE_DIR 时不误删量化缓存条目（异类条目一律跳过）', async () => {
    const now = Date.now();
    // 量化 K 线：TTL 30 天，但已写入 25 小时（超过股票缓存 24h TTL）
    fs.writeFileSync(
      path.join(tmpDir, 'kline_600519.json'),
      JSON.stringify({
        kind: 'quant',
        data: { bars: [] },
        timestamp: now - 25 * 60 * 60 * 1000,
        ttlMs: 30 * 24 * 60 * 60 * 1000,
      }),
      'utf-8',
    );
    // 旧格式量化条目（无 kind，但有 ttlMs）：同样必须跳过，否则升级瞬间会丢缓存
    fs.writeFileSync(
      path.join(tmpDir, 'fundamental_600519.json'),
      JSON.stringify({
        data: { rows: [] },
        timestamp: now - 25 * 60 * 60 * 1000,
        ttlMs: 30 * 24 * 60 * 60 * 1000,
      }),
      'utf-8',
    );
    // 本类里真正过期的条目：仍然要删
    writeCache('expired.json', now - 25 * 60 * 60 * 1000);

    const { pruneFileCache } = await loadModule();
    const { removed } = await pruneFileCache();

    expect(removed).toBe(1);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(['fundamental_600519.json', 'kline_600519.json']);
  });

  it('容量淘汰只统计本类条目（异类不计入、也不被淘汰）', async () => {
    process.env.FILE_CACHE_MAX = '1';
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `quant_${i}.json`),
        JSON.stringify({ kind: 'quant', data: {}, timestamp: now - i * 1000, ttlMs: 60_000 }),
        'utf-8',
      );
    }
    writeCache('s_old.json', now - 2000);
    writeCache('s_new.json', now);

    const { pruneFileCache } = await loadModule();
    const { removed } = await pruneFileCache();

    // 本类 2 个 > 上限 1 → 淘汰最旧的本类条目；异类 3 个原样保留
    expect(removed).toBe(1);
    const left = fs.readdirSync(tmpDir).sort();
    expect(left).toContain('s_new.json');
    expect(left).not.toContain('s_old.json');
    expect(left.filter((f) => f.startsWith('quant_'))).toHaveLength(3);
  });
});

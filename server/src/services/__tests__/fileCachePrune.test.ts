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
});

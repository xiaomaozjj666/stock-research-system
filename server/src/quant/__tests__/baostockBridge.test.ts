import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchIndexConstituentsCached,
  baostockHealth,
  BAOSTOCK_INDEXES,
} from '../baostockBridge.js';

/**
 * Baostock 桥接单测：spawn 协议（stdin JSON → stdout 一行 JSON）、sidecar 协议内
 * 错误、Python 缺失（ENOENT）的友好报错、缓存命中与陈旧兜底。
 * 子进程经 vi.mock('node:child_process') 模拟——真实 sidecar 的行为已由
 * 实机验证覆盖（见 baostock-sidecar.py 头注释），这里只验证桥接协议本身。
 */

const mockedSpawn = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => mockedSpawn(...args),
}));

let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
const origTtl = process.env.QUANT_BAOSTOCK_CACHE_TTL_HOURS;

beforeEach(() => {
  mockedSpawn.mockReset();
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-baostock-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
  delete process.env.QUANT_BAOSTOCK_CACHE_TTL_HOURS;
});
afterEach(() => {
  vi.useRealTimers();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  if (origTtl === undefined) delete process.env.QUANT_BAOSTOCK_CACHE_TTL_HOURS;
  else process.env.QUANT_BAOSTOCK_CACHE_TTL_HOURS = origTtl;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

const OK_PAYLOAD = {
  ok: true,
  index: 'hs300',
  requestedDate: '2024-06-28',
  updateDate: '2024-06-24',
  count: 2,
  constituents: [
    { code: '600000', name: '浦发银行' },
    { code: '600005', name: '武钢股份' },
  ],
};

/** 一次性假子进程：stdin 收到请求后，按脚本输出 JSON（或模拟 ENOENT） */
function fakeChild(stdoutText: string, opts: { enoent?: boolean; exitCode?: number } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = {
    write: vi.fn(),
    on: vi.fn(),
    end: vi.fn(() => {
      if (opts.enoent) {
        const e = new Error('spawn python ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        child.emit('error', e);
        return;
      }
      process.nextTick(() => {
        child.stdout.emit('data', stdoutText);
        child.emit('close', opts.exitCode ?? 0);
      });
    }),
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('baostockBridge — spawn 协议与缓存纪律', () => {
  it('BAOSTOCK_INDEXES 与 sidecar 支持面一致', () => {
    expect([...BAOSTOCK_INDEXES]).toEqual(['hs300', 'zz500', 'sz50']);
  });

  it('成功路径：请求经 stdin 传入，stdout JSON 解析为成分结果；缓存命中后不再 spawn', async () => {
    mockedSpawn.mockImplementation(() => fakeChild(JSON.stringify(OK_PAYLOAD) + '\n'));
    const a = await fetchIndexConstituentsCached('hs300', '2024-06-28');
    expect(a.count).toBe(2);
    expect(a.constituents[1]).toEqual({ code: '600005', name: '武钢股份' });
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    // 请求体经 stdin 传入（绕开 Windows argv 引号转义）
    const child = mockedSpawn.mock.results[0].value as ReturnType<typeof fakeChild>;
    expect(child.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ index: 'hs300', date: '2024-06-28' }),
    );
    const b = await fetchIndexConstituentsCached('hs300', '2024-06-28');
    expect(b).toEqual(a);
    expect(mockedSpawn).toHaveBeenCalledTimes(1); // 缓存命中
  });

  it('协议内错误（ok:false）→ 抛出 sidecar 的原始错误信息', async () => {
    mockedSpawn.mockImplementation(() =>
      fakeChild(JSON.stringify({ ok: false, error: 'baostock 登录失败 [x] 网络不可达' })),
    );
    await expect(fetchIndexConstituentsCached('hs300', '2015-06-30')).rejects.toThrow(/登录失败/);
  });

  it('Python 缺失（ENOENT）→ 报错含 PYTHON_BIN 指引', async () => {
    mockedSpawn.mockImplementation(() => fakeChild('', { enoent: true }));
    await expect(fetchIndexConstituentsCached('zz500')).rejects.toThrow(/PYTHON_BIN/);
  });

  it('stdout 无 JSON（崩溃）→ 抛「无 JSON 输出」并附 stderr 末行', async () => {
    mockedSpawn.mockImplementation(() => fakeChild('', { exitCode: 1 }));
    await expect(fetchIndexConstituentsCached('sz50')).rejects.toThrow(/无 JSON 输出/);
  });

  it('历史快照缓存过期 + 上游失败 → 回落陈旧缓存；baostockHealth 如实披露', async () => {
    vi.useFakeTimers();
    mockedSpawn.mockImplementation(() => fakeChild(JSON.stringify(OK_PAYLOAD) + '\n'));
    await fetchIndexConstituentsCached('hs300', '2024-06-28');
    await fetchIndexConstituentsCached('hs300'); // health 探针走 latest key，一并预填

    // 推进 31 天：不可变快照缓存（30 天）过期 → 重打上游且失败 → 陈旧兜底
    vi.setSystemTime(new Date(Date.now() + 31 * 24 * 3600 * 1000));
    mockedSpawn.mockImplementation(() =>
      fakeChild(JSON.stringify({ ok: false, error: 'login 失败' })),
    );
    const stale = await fetchIndexConstituentsCached('hs300', '2024-06-28');
    expect(stale.count).toBe(2);

    // health：上游失败但有陈旧缓存 → available:true（走同一缓存）
    const h = await baostockHealth();
    expect(h.available).toBe(true);
    expect(h.hs300Count).toBe(2);
  });

  it('完全不可用 → baostockHealth available:false + 原始 detail', async () => {
    mockedSpawn.mockImplementation(() => fakeChild('', { enoent: true }));
    const h = await baostockHealth();
    expect(h.available).toBe(false);
    expect(String(h.detail)).toContain('PYTHON_BIN');
  });
});

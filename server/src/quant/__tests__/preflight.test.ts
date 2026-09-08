import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchJson } from '../../utils/http.js';
import { runPreflight, probeUpstream, cacheEntryCount, resetPreflightCache } from '../preflight.js';

vi.mock('../../utils/http.js', () => ({ fetchJson: vi.fn() }));
const mockedFetchJson = vi.mocked(fetchJson);

const CACHE_DIR = path.join(os.tmpdir(), `preflight-cache-test-${process.pid}`);

beforeAll(() => {
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});

beforeEach(() => {
  resetPreflightCache();
  mockedFetchJson.mockReset();
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
});

describe('probeUpstream', () => {
  it('源可达 → ok=true', async () => {
    mockedFetchJson.mockResolvedValue({ data: { klines: [] } });
    const check = await probeUpstream();
    expect(check).toMatchObject({ key: 'upstream', ok: true });
  });

  it('源不可达 → ok=false 且带上原因', async () => {
    mockedFetchJson.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const check = await probeUpstream();
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('ENOTFOUND');
  });

  it('60 秒内复用探测结果（预检本身不该放大网络）', async () => {
    mockedFetchJson.mockResolvedValue({});
    await probeUpstream();
    await probeUpstream();
    expect(mockedFetchJson).toHaveBeenCalledTimes(1);
  });
});

describe('cacheEntryCount', () => {
  it('目录不存在 → 0', () => {
    expect(cacheEntryCount()).toBe(0);
  });

  it('只统计 .json 缓存条目', () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, 'a.json'), '{}');
    fs.writeFileSync(path.join(CACHE_DIR, 'b.json'), '{}');
    fs.writeFileSync(path.join(CACHE_DIR, 'c.txt'), 'x');
    expect(cacheEntryCount()).toBe(2);
  });
});

describe('runPreflight', () => {
  it('返回三项检查（upstream / llm / cache）', async () => {
    mockedFetchJson.mockResolvedValue({});
    const r = await runPreflight();
    expect(r.checks.map((c) => c.key)).toEqual(['upstream', 'llm', 'cache']);
    expect(typeof r.ok).toBe('boolean');
    expect(r.checkedAt).toBeTruthy();
  });

  it('源不可达且无缓存 → 明确提示无法装配面板', async () => {
    mockedFetchJson.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await runPreflight();
    expect(r.degraded.some((d) => d.includes('均不可用'))).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('源不可达但有缓存 → 提示回落陈旧数据而非直接失败', async () => {
    mockedFetchJson.mockRejectedValue(new Error('ECONNREFUSED'));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, 'kline_x.json'), '{}');
    const r = await runPreflight();
    expect(r.degraded.some((d) => d.includes('陈旧数据'))).toBe(true);
    const cache = r.checks.find((c) => c.key === 'cache');
    expect(cache?.ok).toBe(true);
  });
});

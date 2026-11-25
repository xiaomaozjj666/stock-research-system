import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../../utils/logger.js';
import { fetchOHLCVData, marketOf, resolveSecid } from '../dataProvider.js';
import {
  DEFAULT_PROVIDER_ID,
  eastmoneyProvider,
  getProvider,
  listProviders,
  providerSupports,
  registerProvider,
  type DataProvider,
  type KlineRequest,
} from '../providers/index.js';
import type { OHLCVData } from '../types.js';

/**
 * 数据源 provider 注册表测试。
 * - 默认等价：未配置 DATA_PROVIDERS 时取东财，URL / 解析 / 抛错口径与改造前一致；
 * - 注册表：注册 / 查找 / 列表 / 同 id 原位覆盖 / 未知 id 告警回落；
 * - 能力声明：声明与实现必须同时满足才可调用（可选能力不应导致 TypeError）；
 * - 委托：DATA_PROVIDERS 选中的 provider 真的接管 resolveSecid / fetchKline，
 *   且缓存键仍是 `kline_<token>`（换源时靠缓存条目里的 provider 归属失效）。
 *
 * 缓存目录经 DATA_CACHE_DIR 重定向到进程专属临时目录，不写真实 quant/cache。
 */
let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
const origDataProviders = process.env.DATA_PROVIDERS;

beforeAll(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-providers-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterAll(() => {
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});
beforeEach(() => {
  // 每个用例从「默认配置」出发；需要换源的用例自行设置
  delete process.env.DATA_PROVIDERS;
});
afterEach(() => {
  if (origDataProviders === undefined) delete process.env.DATA_PROVIDERS;
  else process.env.DATA_PROVIDERS = origDataProviders;
  vi.restoreAllMocks();
});

const klineCacheFile = (token: string) => join(CACHE_DIR, `kline_${token}.json`);

function bar(date: string, close: number): OHLCVData {
  return { date, open: close, close, high: close, low: close, volume: 1000 };
}

/** 最小可注册 provider：必需方法齐备，可选能力按需覆盖 */
function makeProvider(id: string, overrides: Partial<DataProvider> = {}): DataProvider {
  return {
    id,
    capabilities: { kline: true, quote: false, financial: false },
    resolveSecid: (code: string) => `test.${code.trim()}`,
    fetchKline: async () => null,
    ...overrides,
  };
}

function mockEastmoneyResponse(klines: string[]): Response {
  return { json: async () => ({ data: { klines } }) } as Response;
}

describe('默认 provider：eastmoney 行为等价', () => {
  it('未配置 DATA_PROVIDERS 时默认选中 eastmoney，且能力声明为 K 线', () => {
    expect(getProvider().id).toBe(DEFAULT_PROVIDER_ID);
    expect(getProvider().id).toBe('eastmoney');
    expect(listProviders()[0].id).toBe('eastmoney');
    expect(eastmoneyProvider.capabilities).toMatchObject({ kline: true, quote: false });
    expect(providerSupports(eastmoneyProvider, 'kline')).toBe(true);
  });

  it('resolveSecid / marketOf 口径与改造前一致（A / HK / US / 非法字符）', () => {
    expect(marketOf('600519')).toBe('A');
    expect(marketOf('00700')).toBe('HK');
    expect(marketOf('BRK.B')).toBe('US');
    expect(resolveSecid('600519')).toBe('1.600519');
    expect(resolveSecid('000001')).toBe('0.000001');
    expect(resolveSecid('00700')).toBe('116.00700');
    expect(resolveSecid('aapl')).toBe('107.AAPL');
    expect(resolveSecid('BRK.B')).toBe('107.BRK.B');
    expect(() => resolveSecid('1&lmt=99999')).toThrow(
      '非法股票代码（含不允许的字符）：1&lmt=99999',
    );
  });

  it('fetchOHLCVData 与直接调用 eastmoneyProvider.fetchKline 发出同一 URL、返回同一结果', async () => {
    const code = '910001';
    const start = '2024-01-01';
    const end = '2024-02-01';
    const klines = [
      '2024-01-02,10.00,10.50,11.00,9.80,123456',
      '2024-02-01,10.50,10.60,10.80,10.40,234567',
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockEastmoneyResponse(klines));

    const viaRegistered = await fetchOHLCVData(code, start, end);
    const viaDirect = await eastmoneyProvider.fetchKline({
      secid: '0.910001',
      startDate: start,
      endDate: end,
      timeoutMs: 15000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const registeredUrl = String(fetchSpy.mock.calls[0][0]);
    const directUrl = String(fetchSpy.mock.calls[1][0]);
    // 与改造前手写的 URL 逐字一致（secid / fields / klt / fqt / beg / end / lmt）
    expect(registeredUrl).toBe(
      'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.910001&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=20240101&end=20240201&lmt=1000',
    );
    expect(registeredUrl).toBe(directUrl);
    expect(viaRegistered).toEqual(viaDirect);
    expect(viaRegistered.map((b) => b.close)).toEqual([10.5, 10.6]);
  });

  it('默认路径缓存键仍是 kline_<token>，缓存条目记录 provider 归属', async () => {
    const code = '910005';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockEastmoneyResponse(['2024-01-02,10.00,10.50,11.00,9.80,123456']),
    );

    const bars = await fetchOHLCVData(code, '2024-01-01', '2024-01-31');
    const file = klineCacheFile(code);
    expect(fs.existsSync(file)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      data: { bars: OHLCVData[]; provider?: string };
    };
    expect(raw.data.bars).toEqual(bars);
    expect(raw.data.provider).toBe('eastmoney');
  });

  it('旧缓存（无 provider 字段）按「来源未知」兼容读取，保持零网络调用', async () => {
    const code = '910006';
    const bars = [bar('2024-01-01', 5), bar('2024-01-31', 6)];
    fs.writeFileSync(
      klineCacheFile(code),
      JSON.stringify({
        data: { bars },
        timestamp: Date.now(),
        ttlMs: 30 * 24 * 60 * 60 * 1000,
      }),
      'utf-8',
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockEastmoneyResponse([]));

    const result = await fetchOHLCVData(code, '2024-01-01', '2024-01-31');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual(bars);
  });
});

describe('注册表：注册 / 查找 / 列表', () => {
  it('注册后可按 id 查找（大小写不敏感），并出现在列表中', () => {
    const fake = makeProvider('fake-alpha', { fetchKline: async () => [bar('2024-01-02', 1)] });
    registerProvider(fake);

    expect(getProvider('fake-alpha')).toBe(fake);
    expect(getProvider('FAKE-ALPHA')).toBe(fake);
    expect(listProviders().map((p) => p.id)).toContain('fake-alpha');
  });

  it('DATA_PROVIDERS 只选择/排序已注册 provider：首个可用项生效，列表按配置顺序前置', () => {
    const first = makeProvider('fake-first');
    const second = makeProvider('fake-second');
    registerProvider(first);
    registerProvider(second);

    process.env.DATA_PROVIDERS = ' fake-second, fake-first ';
    expect(getProvider()).toBe(second);
    const ids = listProviders().map((p) => p.id);
    expect(ids.slice(0, 2)).toEqual(['fake-second', 'fake-first']);
    expect(ids).toContain('eastmoney');
  });

  it('同 id 重复注册原位覆盖，列表不产生重复项', () => {
    const before = listProviders().map((p) => p.id);
    const replacement = makeProvider('eastmoney', {
      resolveSecid: (code: string) => `0.override.${code}`,
    });
    registerProvider(replacement);
    try {
      expect(getProvider()).toBe(replacement);
      expect(getProvider('eastmoney')).toBe(replacement);
      expect(listProviders().map((p) => p.id)).toEqual(before);
    } finally {
      registerProvider(eastmoneyProvider);
    }
    expect(getProvider()).toBe(eastmoneyProvider);
  });
});

describe('DATA_PROVIDERS：未知 id 告警并回落默认', () => {
  it('全部未知 → warning 并回落 eastmoney', () => {
    process.env.DATA_PROVIDERS = 'ghost-unknown-a';
    const warn = vi.spyOn(logger, 'warn');

    expect(getProvider().id).toBe('eastmoney');
    expect(warn).toHaveBeenCalledWith(
      'DATA_PROVIDERS 含未注册的数据源 provider，已忽略',
      expect.objectContaining({ unknown: ['ghost-unknown-a'] }),
    );
  });

  it('未知 + 已知混合 → 未知记 warning，选第一个已知项', () => {
    const known = makeProvider('fake-known');
    registerProvider(known);
    process.env.DATA_PROVIDERS = 'ghost-unknown-b,fake-known';
    const warn = vi.spyOn(logger, 'warn');

    expect(getProvider()).toBe(known);
    expect(warn).toHaveBeenCalledWith(
      'DATA_PROVIDERS 含未注册的数据源 provider，已忽略',
      expect.objectContaining({ unknown: ['ghost-unknown-b'] }),
    );
  });

  it('显式 getProvider(未知 id) 同样告警并回落默认', () => {
    const warn = vi.spyOn(logger, 'warn');

    expect(getProvider('ghost-unknown-c').id).toBe('eastmoney');
    expect(warn).toHaveBeenCalledWith(
      '未注册的数据源 provider，已回落默认',
      expect.objectContaining({ requested: 'ghost-unknown-c', fallback: 'eastmoney' }),
    );
  });
});

describe('能力声明：可选调用', () => {
  it('声明了 quote 且实现了 fetchQuote → 可调用；未声明 financial → 不可调用', async () => {
    const quoted = makeProvider('fake-quote', {
      capabilities: { kline: true, quote: true, financial: false },
      fetchQuote: async ({ secid }) => ({ code: secid, price: 12.3 }),
    });
    registerProvider(quoted);

    expect(providerSupports(quoted, 'quote')).toBe(true);
    expect(providerSupports(quoted, 'financial')).toBe(false);
    await expect(quoted.fetchQuote!({ secid: '1.600519' })).resolves.toEqual({
      code: '1.600519',
      price: 12.3,
    });
  });

  it('声明了能力但未实现方法 → 按不可用处理（不抛 TypeError）', () => {
    const declaredOnly = makeProvider('fake-declared-only', {
      capabilities: { kline: true, quote: true, financial: true },
    });

    expect(providerSupports(declaredOnly, 'kline')).toBe(true);
    expect(providerSupports(declaredOnly, 'quote')).toBe(false);
    expect(providerSupports(declaredOnly, 'financial')).toBe(false);
  });

  it('东财 provider 声明 K 线可用、可选能力不可用', () => {
    expect(providerSupports(eastmoneyProvider, 'kline')).toBe(true);
    expect(providerSupports(eastmoneyProvider, 'quote')).toBe(false);
    expect(providerSupports(eastmoneyProvider, 'financial')).toBe(false);
  });
});

describe('委托：选中 provider 真正接管取数', () => {
  it('DATA_PROVIDERS 切到自定义源：resolveSecid / fetchKline 均由该源执行，缓存键不变', async () => {
    const code = '910002';
    const fetchKline = vi.fn(async (request: KlineRequest) => [bar(request.startDate, 3.21)]);
    const fake = makeProvider('fake-kline', {
      resolveSecid: (c: string) => `7.${c.trim()}`,
      fetchKline,
    });
    registerProvider(fake);
    process.env.DATA_PROVIDERS = 'fake-kline';

    const result = await fetchOHLCVData(code, '2024-03-01', '2024-03-31');

    expect(fetchKline).toHaveBeenCalledWith({
      secid: '7.910002',
      startDate: '2024-03-01',
      endDate: '2024-03-31',
      timeoutMs: 15000,
      signal: undefined,
    });
    expect(result.map((b) => b.close)).toEqual([3.21]);
    // 缓存键仍是 kline_<token>（与源无关），条目记录当前 provider
    const raw = JSON.parse(fs.readFileSync(klineCacheFile(code), 'utf-8')) as {
      data: { provider?: string };
    };
    expect(raw.data.provider).toBe('fake-kline');
  });

  it('换源后同一 token 不复用旧源缓存：忽略并全量重拉', async () => {
    const code = '910003';
    registerProvider(
      makeProvider('fake-kline-switch', {
        fetchKline: async () => [bar('2024-01-02', 1)],
      }),
    );
    process.env.DATA_PROVIDERS = 'fake-kline-switch';
    await fetchOHLCVData(code, '2024-01-01', '2024-01-31');

    delete process.env.DATA_PROVIDERS;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockEastmoneyResponse(['2024-01-02,2.00,2.00,2.00,2.00,100']));
    const warn = vi.spyOn(logger, 'warn');

    const bars = await fetchOHLCVData(code, '2024-01-01', '2024-01-31');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bars[0].close).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      'K线缓存属于其他数据源 provider，已忽略并全量重拉',
      expect.objectContaining({ cachedProvider: 'fake-kline-switch', provider: 'eastmoney' }),
    );
  });
});

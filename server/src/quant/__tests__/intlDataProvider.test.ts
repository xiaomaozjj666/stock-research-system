import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  detectMarket,
  formatIntlCode,
  fetchIntlFundamentals,
  fetchBatchFundamentals,
} from '../intlDataProvider.js';

// 隔离网络：intlDataProvider 直接调用全局 fetch，统一 mock globalThis.fetch。
// 备份原始 fetch，afterAll 恢复，避免污染其它测试套件。
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // 降级路径会 console.warn，这里统一静默，避免污染测试输出
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** 构造一个成功的 fetch Response mock */
function mockOkJson(payload: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(payload),
  }) as unknown as ReturnType<typeof vi.fn>;
}

describe('detectMarket', () => {
  it('5 位纯数字 → HK', () => {
    expect(detectMarket('00700')).toBe('HK');
    expect(detectMarket('09988')).toBe('HK');
    expect(detectMarket('03690')).toBe('HK');
  });

  it('字母代码 → US（大小写不敏感）', () => {
    expect(detectMarket('AAPL')).toBe('US');
    expect(detectMarket('TSLA')).toBe('US');
    expect(detectMarket('aapl')).toBe('US');
    expect(detectMarket('Msft')).toBe('US');
  });

  it('6 位纯数字 → A 股', () => {
    expect(detectMarket('600519')).toBe('A');
    expect(detectMarket('000001')).toBe('A');
    expect(detectMarket('300750')).toBe('A');
  });

  it('前后空格被 trim', () => {
    expect(detectMarket('  00700 ')).toBe('HK');
    expect(detectMarket('  AAPL  ')).toBe('US');
  });

  it('未知格式回退到 A 股', () => {
    expect(detectMarket('123')).toBe('A');
    expect(detectMarket('')).toBe('A');
    expect(detectMarket('ABC123')).toBe('A');
  });
});

describe('formatIntlCode', () => {
  it('HK 5 位数字 → 116.{code}', () => {
    expect(formatIntlCode('00700', 'HK')).toBe('116.00700');
    expect(formatIntlCode('09988', 'HK')).toBe('116.09988');
  });

  it('US 字母 → 107.{CODE}（强制大写）', () => {
    expect(formatIntlCode('AAPL', 'US')).toBe('107.AAPL');
    expect(formatIntlCode('aapl', 'US')).toBe('107.AAPL');
    expect(formatIntlCode('msft', 'US')).toBe('107.MSFT');
  });

  it('前后空格被 trim', () => {
    expect(formatIntlCode('  00700 ', 'HK')).toBe('116.00700');
    expect(formatIntlCode('  aapl ', 'US')).toBe('107.AAPL');
  });
});

describe('fetchIntlFundamentals', () => {
  it('成功解析港股估值（市值/营收以元计需 /1e8 转亿元）', async () => {
    globalThis.fetch = mockOkJson({
      data: {
        f57: '00700',
        f58: '腾讯控股',
        f116: 3.6e12, // 总市值（元）→ 36000 亿
        f117: 3.6e12,
        f162: 15,
        f163: 18.5, // PE TTM
        f164: 4.2, // PB
        f173: 6e11, // 营收（元）→ 6000 亿
        f184: 5e11, // 总负债（元）→ 5000 亿
        f187: 1.5e11, // 净利润（元）→ 1500 亿
        f193: 1.8e12, // 总资产（元）→ 18000 亿
      },
    }) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('00700', 'HK');
    expect(r.degraded).toBe(false);
    expect(r.source).toBe('eastmoney-push2');
    expect(r.fundamentals).not.toBeNull();
    const f = r.fundamentals!;
    expect(f.code).toBe('00700');
    expect(f.market).toBe('HK');
    expect(f.name).toBe('腾讯控股');
    expect(f.pe).toBe(18.5);
    expect(f.pb).toBe(4.2);
    expect(f.marketCap).toBe(36000);
    expect(f.revenue).toBe(6000);
    expect(f.netIncome).toBe(1500);
    expect(f.totalAssets).toBe(18000);
    expect(f.totalLiabilities).toBe(5000);
    expect(f.currency).toBe('HKD');
    expect(f.dataSource).toBe('eastmoney-push2');
    // fetchedAt 是合法 ISO 时间
    expect(new Date(r.fetchedAt).getTime()).not.toBeNaN();
  });

  it('成功解析美股估值，代码强制大写、货币=USD', async () => {
    const mock = mockOkJson({
      data: {
        f57: 'AAPL',
        f58: '苹果',
        f116: 2.8e12, // 28000 亿
        f163: 30.1,
        f164: 45.7,
        f173: 4e11, // 4000 亿
        f187: 1e11, // 1000 亿
        f193: 3.5e12, // 35000 亿
        f184: 3e11, // 3000 亿
      },
    });
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('aapl', 'US');
    expect(r.degraded).toBe(false);
    const f = r.fundamentals!;
    expect(f.code).toBe('AAPL');
    expect(f.market).toBe('US');
    expect(f.currency).toBe('USD');
    expect(f.pe).toBe(30.1);
    expect(f.pb).toBe(45.7);
    expect(f.marketCap).toBe(28000);
    // 验证 secid 大写：URL 中应含 secid=107.AAPL
    const calledUrl = String(mock.mock.calls[0]?.[0] ?? '');
    expect(calledUrl).toContain('secid=107.AAPL');
  });

  it('PE TTM(f163) 缺失时回退到动态 PE(f162)', async () => {
    globalThis.fetch = mockOkJson({
      data: {
        f57: '09988',
        f58: '阿里巴巴',
        f116: 2e12,
        f162: 22.5, // 动态 PE
        f163: 0, // TTM 缺失
        f164: 3.1,
        f173: 8e11,
        f187: 6e10,
        f193: 1.6e12,
        f184: 4e11,
      },
    }) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('09988', 'HK');
    expect(r.degraded).toBe(false);
    expect(r.fundamentals?.pe).toBe(22.5);
  });

  it('fetch 失败 → 降级（fundamentals=null, degraded=true）', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('00700', 'HK');
    expect(r.degraded).toBe(true);
    expect(r.fundamentals).toBeNull();
    expect(r.source).toBe('none');
    expect(new Date(r.fetchedAt).getTime()).not.toBeNaN();
  });

  it('HTTP 非 2xx → 降级', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('AAPL', 'US');
    expect(r.degraded).toBe(true);
    expect(r.fundamentals).toBeNull();
  });

  it('eastmoney 返回空 data → 降级', async () => {
    globalThis.fetch = mockOkJson({ data: null }) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('00700', 'HK');
    expect(r.degraded).toBe(true);
    expect(r.fundamentals).toBeNull();
  });

  it('eastmoney 返回空名称 → 降级', async () => {
    globalThis.fetch = mockOkJson({
      data: { f57: '00700', f58: '' },
    }) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('00700', 'HK');
    expect(r.degraded).toBe(true);
    expect(r.fundamentals).toBeNull();
  });

  it('超时（AbortSignal.timeout 抛错）→ 降级', async () => {
    // 模拟 AbortSignal.timeout 触发的 TIMEOUT 错误
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(timeoutErr) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('00700', 'HK');
    expect(r.degraded).toBe(true);
    expect(r.fundamentals).toBeNull();
  });

  it('JSON 解析失败 → 降级', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('Unexpected token <')),
    }) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('AAPL', 'US');
    expect(r.degraded).toBe(true);
    expect(r.fundamentals).toBeNull();
  });
});

describe('fetchBatchFundamentals', () => {
  it('按 detectMarket 分流，A 股代码不发起网络请求', async () => {
    const mock = mockOkJson({
      data: {
        f57: '00700',
        f58: '腾讯控股',
        f163: 18.5,
        f164: 4.2,
        f116: 3.6e12,
      },
    });
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const results = await fetchBatchFundamentals(['00700', '600519', 'AAPL']);
    expect(results).toHaveLength(3);
    // 00700 HK 成功
    expect(results[0].degraded).toBe(false);
    expect(results[0].fundamentals?.market).toBe('HK');
    // 600519 A 股降级，未发起网络请求
    expect(results[1].degraded).toBe(true);
    expect(results[1].fundamentals).toBeNull();
    // AAPL US 成功
    expect(results[2].degraded).toBe(false);
    expect(results[2].fundamentals?.market).toBe('US');
    // fetch 仅被调用 2 次（00700 + AAPL），A 股不调用
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('单只失败不影响其余', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { f57: '00700', f58: '腾讯控股', f163: 18, f164: 4, f116: 3.6e12 },
          }),
      })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { f57: 'AAPL', f58: '苹果', f163: 30, f164: 45, f116: 2.8e12 },
          }),
      }) as unknown as typeof globalThis.fetch;

    const results = await fetchBatchFundamentals(['00700', '09988', 'AAPL']);
    expect(results).toHaveLength(3);
    expect(results[0].degraded).toBe(false);
    expect(results[1].degraded).toBe(true);
    expect(results[2].degraded).toBe(false);
  });

  it('空数组返回空数组', async () => {
    const results = await fetchBatchFundamentals([]);
    expect(results).toEqual([]);
  });

  it('全部 A 股代码 → 全部降级，不发起网络请求', async () => {
    const mock = vi.fn();
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const results = await fetchBatchFundamentals(['600519', '000001', '300750']);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.degraded)).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  it('超过 BATCH_CONCURRENCY 时仍能正常完成', async () => {
    // 7 个港美股代码，超过 BATCH_CONCURRENCY=5，验证分批并发不丢结果
    const mock = mockOkJson({
      data: { f57: 'X', f58: '测试', f163: 10, f164: 2, f116: 1e11 },
    });
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const codes = ['00700', '09988', '03690', 'AAPL', 'MSFT', 'TSLA', 'GOOG'];
    const results = await fetchBatchFundamentals(codes);
    expect(results).toHaveLength(codes.length);
    // 全部成功（响应统一有名称）
    expect(results.every((r) => r.degraded)).toBe(false);
    expect(mock).toHaveBeenCalledTimes(codes.length);
  });
});

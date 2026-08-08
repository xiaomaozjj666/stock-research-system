import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  detectMarket,
  formatIntlCode,
  fetchIntlFundamentals,
  fetchBatchFundamentals,
} from '../intlDataProvider.js';
import { setLogLevel } from '../../utils/logger.js';

// 隔离网络：intlDataProvider 直接调用全局 fetch，统一 mock globalThis.fetch。
// 备份原始 fetch，afterAll 恢复，避免污染其它测试套件。
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // 降级路径会 logger.warn（写 stdout），这里提升日志级别过滤 warn，避免污染测试输出
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setLogLevel('error');
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  setLogLevel('info');
});

/** 构造一个 HTTP 200 + JSON payload 的 Response mock 对象 */
function okJsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(payload),
  };
}

/** 构造一个恒成功的 fetch mock（每次调用返回同一 payload） */
function mockOkJson(payload: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(okJsonResponse(payload)) as unknown as ReturnType<typeof vi.fn>;
}

/** 构造东方财富数据中心 RPT 网关成功响应（data.result.data 数组） */
function rptOk(data: Array<Record<string, unknown>> | null): unknown {
  return {
    version: 'test',
    result: { pages: data && data.length > 0 ? 1 : 0, data },
    success: true,
    message: 'ok',
    code: 0,
  };
}

/** RPT 网关错误响应（报表不存在 / 其它网关错误，result 缺失） */
function rptError(): unknown {
  return {
    success: false,
    code: 9501,
    message: '报表配置不存在',
    result: null,
  };
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
  it('成功解析港股估值（RPT 主要指标，市值/营收以元计需 /1e8 转亿元）', async () => {
    const mock = mockOkJson(
      rptOk([
        {
          SECUCODE: '00700.HK',
          SECURITY_CODE: '00700',
          SECURITY_NAME_ABBR: '腾讯控股',
          STD_REPORT_DATE: '2026-03-31 00:00:00',
          PE_TTM: 18.5,
          PB_TTM: 4.2,
          TOTAL_MARKET_CAP: 3.6e12, // 总市值（元）→ 36000 亿
          OPERATE_INCOME: 6e11, // 营收（元）→ 6000 亿
          HOLDER_PROFIT: 1.5e11, // 净利润（元）→ 1500 亿
          TOTAL_ASSETS: 1.8e12, // 总资产（元）→ 18000 亿
          TOTAL_LIABILITIES: 5e11, // 总负债（元）→ 5000 亿
          CURRENCY: 'HKD',
        },
      ]),
    );
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('00700', 'HK');
    expect(r.degraded).toBe(false);
    expect(r.source).toBe('eastmoney-datacenter');
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
    expect(f.dataSource).toBe('eastmoney-datacenter');
    // fetchedAt 是合法 ISO 时间
    expect(new Date(r.fetchedAt).getTime()).not.toBeNaN();
    // 名称已由主要指标提供，不再回查证券资料 → 仅 1 次请求
    const calledUrl = String(mock.mock.calls[0]?.[0] ?? '');
    expect(calledUrl).toContain('RPT_HKF10_FN_MAININDICATOR');
    expect(calledUrl).toContain('SECUCODE');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('成功解析美股估值（ORGPROFILE 查 SECUCODE + GMAININDICATOR 补财务，代码大写、货币=USD）', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([
            { SECUCODE: 'AAPL.O', SECURITY_CODE: 'AAPL', SECURITY_NAME_ABBR: '苹果' },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([
            {
              SECUCODE: 'AAPL.O',
              SECURITY_CODE: 'AAPL',
              SECURITY_NAME_ABBR: '苹果',
              OPERATE_INCOME: 4e11, // 营收（美元）→ 4000 亿
              PARENT_HOLDER_NETPROFIT: 1e11, // 净利润（美元）→ 1000 亿
              CURRENCY_ABBR: 'USD',
            },
          ]),
        ),
      );
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('aapl', 'US');
    expect(r.degraded).toBe(false);
    const f = r.fundamentals!;
    expect(f.code).toBe('AAPL');
    expect(f.market).toBe('US');
    expect(f.name).toBe('苹果');
    expect(f.currency).toBe('USD');
    expect(f.revenue).toBe(4000);
    expect(f.netIncome).toBe(1000);
    // 数据中心未提供美股 PE/PB/市值/资产负债估值快照 → 归零
    expect(f.pe).toBe(0);
    expect(f.pb).toBe(0);
    expect(f.marketCap).toBe(0);
    expect(f.totalAssets).toBe(0);
    expect(f.totalLiabilities).toBe(0);
    expect(mock).toHaveBeenCalledTimes(2);
    // 第一步用 SECURITY_CODE 查 SECUCODE
    const firstUrl = String(mock.mock.calls[0]?.[0] ?? '');
    expect(firstUrl).toContain('RPT_USF10_INFO_ORGPROFILE');
    expect(firstUrl).toContain('SECURITY_CODE');
    // 第二步用 SECUCODE 查主要财务指标
    const secondUrl = String(mock.mock.calls[1]?.[0] ?? '');
    expect(secondUrl).toContain('RPT_USF10_FN_GMAININDICATOR');
    expect(secondUrl).toContain('SECUCODE');
  });

  it('港股主要指标缺名称时回查证券资料兜底', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([
            {
              SECUCODE: '09988.HK',
              SECURITY_CODE: '09988',
              PE_TTM: 22.5, // 主要指标无名称
              PB_TTM: 3.1,
              TOTAL_MARKET_CAP: 2e12,
              OPERATE_INCOME: 8e11,
              HOLDER_PROFIT: 6e10,
              TOTAL_ASSETS: 1.6e12,
              TOTAL_LIABILITIES: 4e11,
              CURRENCY: 'HKD',
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([
            { SECUCODE: '09988.HK', SECURITY_CODE: '09988', SECURITY_NAME_ABBR: '阿里巴巴' },
          ]),
        ),
      );
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('09988', 'HK');
    expect(r.degraded).toBe(false);
    expect(r.fundamentals?.name).toBe('阿里巴巴');
    expect(r.fundamentals?.pe).toBe(22.5);
    expect(mock).toHaveBeenCalledTimes(2);
    const secondUrl = String(mock.mock.calls[1]?.[0] ?? '');
    expect(secondUrl).toContain('RPT_HKF10_INFO_SECURITYINFO');
  });

  it('名称缺失且证券资料兜底也为空 → 降级', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(okJsonResponse(rptOk([{ SECURITY_CODE: '00700' }])))
      .mockResolvedValueOnce(
        okJsonResponse(rptOk([{ SECURITY_CODE: '00700', SECURITY_NAME_ABBR: '' }])),
      ) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('00700', 'HK');
    expect(r.degraded).toBe(true);
    expect(r.fundamentals).toBeNull();
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

  it('RPT 网关错误（result 缺失）→ 降级', async () => {
    globalThis.fetch = mockOkJson(rptError()) as unknown as typeof globalThis.fetch;

    const r = await fetchIntlFundamentals('00700', 'HK');
    expect(r.degraded).toBe(true);
    expect(r.fundamentals).toBeNull();
  });

  it('RPT 返回空 data → 降级', async () => {
    globalThis.fetch = mockOkJson(rptOk([])) as unknown as typeof globalThis.fetch;

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
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([
            {
              SECURITY_CODE: '00700',
              SECURITY_NAME_ABBR: '腾讯控股',
              PE_TTM: 18.5,
              PB_TTM: 4.2,
              TOTAL_MARKET_CAP: 3.6e12,
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([{ SECUCODE: 'AAPL.O', SECURITY_CODE: 'AAPL', SECURITY_NAME_ABBR: '苹果' }]),
        ),
      )
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([
            { SECURITY_CODE: 'AAPL', OPERATE_INCOME: 4e11, PARENT_HOLDER_NETPROFIT: 1e11 },
          ]),
        ),
      );
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
    // fetch 仅被调用 3 次（00700 + AAPL 的 ORGPROFILE + AAPL 的 GMAININDICATOR），A 股不调用
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('单只失败不影响其余', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([
            {
              SECURITY_CODE: '00700',
              SECURITY_NAME_ABBR: '腾讯控股',
              PE_TTM: 18,
              PB_TTM: 4,
              TOTAL_MARKET_CAP: 3.6e12,
            },
          ]),
        ),
      )
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([{ SECUCODE: 'AAPL.O', SECURITY_CODE: 'AAPL', SECURITY_NAME_ABBR: '苹果' }]),
        ),
      )
      .mockResolvedValueOnce(
        okJsonResponse(
          rptOk([
            { SECURITY_CODE: 'AAPL', OPERATE_INCOME: 4e11, PARENT_HOLDER_NETPROFIT: 1e11 },
          ]),
        ),
      ) as unknown as typeof globalThis.fetch;

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
    // 7 个港美股代码，超过 BATCH_CONCURRENCY=5，验证分批并发不丢结果。
    // 统一 mock：HK 每只 1 次请求（MAININDICATOR），US 每只 2 次（ORGPROFILE + GMAININDICATOR）
    const mock = mockOkJson(
      rptOk([
        {
          SECURITY_CODE: 'X',
          SECURITY_NAME_ABBR: '测试',
          PE_TTM: 10,
          PB_TTM: 2,
          TOTAL_MARKET_CAP: 1e11,
          OPERATE_INCOME: 5e9,
          HOLDER_PROFIT: 1e9,
          TOTAL_ASSETS: 8e10,
          TOTAL_LIABILITIES: 3e10,
          CURRENCY: 'HKD',
        },
      ]),
    );
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;

    const codes = ['00700', '09988', '03690', 'AAPL', 'MSFT', 'TSLA', 'GOOG'];
    const results = await fetchBatchFundamentals(codes);
    expect(results).toHaveLength(codes.length);
    // 全部成功（响应统一有名称）
    expect(results.every((r) => r.degraded)).toBe(false);
    // HK 3 只各 1 次 + US 4 只各 2 次 = 11 次
    expect(mock).toHaveBeenCalledTimes(11);
  });
});

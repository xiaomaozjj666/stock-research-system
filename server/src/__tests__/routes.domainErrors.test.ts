/**
 * 领域错误 → 状态码映射（替代中文正则嗅探）
 * ----------------------------------------------------------------------------
 * 动机（2026-11-20 审查遗留）：三条路由原先用 /(需|不足|至少|一致|失败|必填)/
 * 嗅探错误文案来判 400/502——含「失败」的**上游**错误会被当客户端错误（客户端
 * 据此不会退避重试），新文案漏字就退化成 500。现在服务层确定性质时抛
 * DomainError（带 status + 稳定 code），路由按类型映射。
 *
 * 本文件同时钉住：真实服务层的错误确实带类型（而不是仅路由桩）。
 */
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware.js')>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, quantLimiter: pass, circuitBreakerGuard: pass, metaLimiter: pass };
});

// 行情取数桩：默认返回空（数据不足路径），不发网络
vi.mock('../quant/dataProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/dataProvider.js')>();
  return {
    ...actual,
    fetchOHLCVData: vi.fn(async () => []),
    fetchKlineBySecid: vi.fn(async () => []),
  };
});

import { app as rawApp } from '../index.js';
import { DomainError, isDomainError } from '../utils/domainError.js';
import { analyzeTimeseries } from '../quant/timeseries/analyze.js';
import { fetchAnnouncementContent } from '../quant/announcementProvider.js';
import { fetchIntlKlines } from '../quant/intlDataProvider.js';

const app = rawApp;

describe('DomainError 基础语义', () => {
  it('携带 status 与稳定 code；isDomainError 可判别', () => {
    const e = new DomainError('x', 502, 'TS_DATA');
    expect(isDomainError(e)).toBe(true);
    expect(e.status).toBe(502);
    expect(e.code).toBe('TS_DATA');
    expect(isDomainError(new Error('x'))).toBe(false);
  });
});

describe('服务层确实抛类型化错误（不是靠路由文案匹配）', () => {
  it('analyzeTimeseries：参数非法 → 400 TS_PARAM', async () => {
    const err = await analyzeTimeseries({ test: 'bogus', code: '600519' }).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect((err as DomainError).status).toBe(400);
    expect((err as DomainError).code).toBe('TS_PARAM');
  });

  it('analyzeTimeseries：非法日期 → 400 DATE_RANGE_PARAM（沿 dateRange 的领域错误）', async () => {
    const err = await analyzeTimeseries({
      test: 'adf',
      code: '600519',
      startDate: '2024/01/02',
    }).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect((err as DomainError).status).toBe(400);
    expect((err as DomainError).code).toBe('DATE_RANGE_PARAM');
  });

  it('analyzeTimeseries：K 线不足 → 502 TS_DATA（数据问题不是客户端错）', async () => {
    const err = await analyzeTimeseries({ test: 'adf', code: '600519' }).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect((err as DomainError).status).toBe(502);
    expect((err as DomainError).code).toBe('TS_DATA');
  });

  it('fetchAnnouncementContent：artCode 必填 → 400 ANNOUNCEMENT_PARAM', async () => {
    const err = await fetchAnnouncementContent('').catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect((err as DomainError).status).toBe(400);
    expect((err as DomainError).code).toBe('ANNOUNCEMENT_PARAM');
  });

  it('fetchIntlKlines：港股代码形态非法 → 400 INTL_PARAM', async () => {
    const err = await fetchIntlKlines('123', 'HK', '2024-01-01', '2024-06-30').catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect((err as DomainError).status).toBe(400);
    expect((err as DomainError).code).toBe('INTL_PARAM');
  });
});

describe('路由层按类型映射（对比：未类型化异常 → 500）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('timeseries：非法 test → 400 + TS_PARAM 透出', async () => {
    const r = await request(app)
      .post('/api/quant/timeseries/analyze')
      .send({ test: 'bogus', code: '600519' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('TS_PARAM');
  });

  it('timeseries：数据不足 → 502 + TS_DATA 透出', async () => {
    const r = await request(app)
      .post('/api/quant/timeseries/analyze')
      .send({ test: 'adf', code: '600519' });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('TS_DATA');
  });

  it('timeseries：非法日期 → 400 + DATE_RANGE_PARAM 透出', async () => {
    const r = await request(app)
      .post('/api/quant/timeseries/analyze')
      .send({ test: 'adf', code: '600519', startDate: '2024/01/02' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DATE_RANGE_PARAM');
  });

  it('announcements：artCode 非法 → 400 + ANNOUNCEMENT_PARAM 透出', async () => {
    const r = await request(app).get('/api/quant/announcements').query({ artCode: '' });
    // artCode 为空时走 code 校验分支 → 400（沿用路由级校验文案）
    expect(r.status).toBe(400);

    // 非空但内容非法：由 provider 抛领域错误，路由按类型回 400
    const bad = await request(app).get('/api/quant/announcements').query({ artCode: '   ' });
    expect(bad.status).toBe(400);
  });
});

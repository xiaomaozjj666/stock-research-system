import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';

/**
 * /api/intl/* 出站参数校验（P1：出站 URL 参数未校验）
 * ----------------------------------------------------------------------------
 * 背景（审计）：intlDataProvider 把 code 直接拼进上游 URL / 过滤表达式
 * （K 线 `secid=116.${code}`，估值 `(SECUCODE="${code}.HK")`）。`?code=1&lmt=99999&market=HK`
 * 会往东财 K 线请求里多塞一个 lmt 参数（放大单次拉取量），`code=x") OR (SECUCODE="y`
 * 会改写 RPT 过滤表达式。
 *
 * 本文件的核心断言不是「返回 400」，而是**畸形入参不产生任何对外请求**：
 * 用 fetch 打桩计数，证明闸门拦在拼接之前（而不是把畸形串发出去再等上游报错）。
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // 打桩：合法的港美股请求也走降级路径（result.data 为空 → degraded），不触真实网络
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ result: { data: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/intl/klines —— 入参闸门', () => {
  it('code=1&lmt=99999（改写上游查询参数）→ 400 且零外呼', async () => {
    const res = await request(app)
      .get('/api/intl/klines')
      .query({ code: '1&lmt=99999', market: 'HK' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('code 格式无效');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('code=00700&lmt=99999（合法前缀 + 注入后缀）→ 400 且零外呼', async () => {
    const res = await request(app)
      .get('/api/intl/klines')
      .query({ code: '00700&lmt=99999', market: 'HK' });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('super-long code（1000 字符）→ 400 且零外呼', async () => {
    const res = await request(app)
      .get('/api/intl/klines')
      .query({ code: '7'.repeat(1000), market: 'HK' });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('含引号/括号（可改写 RPT 过滤表达式）→ 400 且零外呼', async () => {
    const res = await request(app)
      .get('/api/intl/klines')
      .query({ code: '00700") OR (SECUCODE="00001', market: 'HK' });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('market 非白名单（XX）→ 400，提示可选值', async () => {
    const res = await request(app).get('/api/intl/klines').query({ code: '00700', market: 'XX' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('market');
    expect(res.body.error).toContain('HK');
  });

  it('A 股代码 → 400 且提示走既有接口（不落到港美股通道）', async () => {
    const res = await request(app).get('/api/intl/klines').query({ code: '600519' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('A 股');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('合法港股（00700 + market=HK）→ 放行到数据层（证明闸门没把功能修坏）', async () => {
    const res = await request(app).get('/api/intl/klines').query({ code: '00700', market: 'HK' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe('00700');
    expect(res.body.market).toBe('HK');
    // 数据源不可用时会降级为模拟 K 线（既有行为），关键是请求确实发到了上游通道
    expect(fetchMock).toHaveBeenCalled();
  });

  it('合法美股（AAPL，无 market）→ 放行', async () => {
    const res = await request(app).get('/api/intl/klines').query({ code: 'aapl' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe('AAPL');
    expect(res.body.market).toBe('US');
  });
});

describe('GET /api/intl/fundamentals —— 入参闸门', () => {
  it('缺少 code → 400（保持既有提示），零外呼', async () => {
    const res = await request(app).get('/api/intl/fundamentals');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('请提供代码 code');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('注入过滤表达式 → 400 且零外呼', async () => {
    const res = await request(app)
      .get('/api/intl/fundamentals')
      .query({ code: 'x") OR (SECUCODE="y', market: 'HK' });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('超长 code → 400 且零外呼', async () => {
    const res = await request(app)
      .get('/api/intl/fundamentals')
      .query({ code: 'A'.repeat(500) });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('A 股代码（600519）→ 400 且提示走 /api/analyze（既有分流契约）', async () => {
    const res = await request(app).get('/api/intl/fundamentals').query({ code: '600519' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('/api/analyze');
  });

  it('合法港股（00700 + market=HK）→ 200（降级结构），且确实发起了受控请求', async () => {
    const res = await request(app)
      .get('/api/intl/fundamentals')
      .query({ code: '00700', market: 'HK' });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    // 上游 URL 里的 code 已被规范化：不得出现注入字符
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    for (const url of calledUrls) {
      expect(url).not.toContain('&lmt=');
      expect(url).toContain('00700');
    }
  });
});

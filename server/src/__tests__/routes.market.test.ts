/**
 * ============================================================================
 * market 路由功能测试：GET /api/stocks、GET /api/stocks/search、POST /api/compare
 *
 * 背景（审计）：这三个端点此前零功能测试（只有 /api/stocks/search 的「入参校验」
 * 在 routes.validation.test.ts 里被覆盖过）。本文件锁定的既有契约：
 *   1) /api/stocks 上游失败必须兜底返回茅台而不是 500；
 *   2) /api/stocks/search 上游失败返回空数组（不是错误码）；
 *   3) /api/compare 逐只容错（Promise.allSettled）：成功项进 stocks、失败项进 failures，
 *      单只失败不再拖垮整批。
 *
 * 【契约变更 2026 年 P0 体验修复】原契约是「/api/compare 用 Promise.all，
 * 任一标的失败即整体 500，不做部分成功」。改为部分成功后，本文件对应用例同步改写为
 * 新契约断言：两只成功一只失败 → 200 + stocks 2 项 + failures 1 项；全部失败 →
 * 200 + stocks: []（不选 502/500，理由见 routes/market.ts 里 compare 处理块的注释）；
 * failures 为空时响应体与旧契约逐字一致（不含 failures 字段），老客户端零改动。
 *
 * 隔离策略：getSupportedStocks / searchStocks / runAnalysis 全部打桩，不触真实网络；
 * 限流器在模块层替换为直通中间件（compareLimiter 仅 3 req/min，本文件请求数远超该值）。
 * 限流 429 分支本身由 routes.rateLimit.test.ts 专门覆盖。
 * ============================================================================
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { AnalysisResult } from '../types.js';
import { QueueTimeoutError } from '../utils/limitGate.js';

vi.mock('../middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    ...actual,
    searchLimiter: passthrough,
    compareLimiter: passthrough,
  };
});

const mocks = vi.hoisted(() => ({
  getSupportedStocks: vi.fn(),
  searchStocks: vi.fn(),
  runAnalysis: vi.fn(),
}));

vi.mock('../services/dataService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dataService.js')>();
  return {
    ...actual,
    getSupportedStocks: mocks.getSupportedStocks,
    searchStocks: mocks.searchStocks,
  };
});

vi.mock('../services/analysisPipeline.js', () => ({
  runAnalysis: mocks.runAnalysis,
}));

import { app } from '../index.js';

/** runAnalysis 的返回值只需 stock_pool[0]（compare 路由取它作为单只结果） */
function analysisResult(code: string, name: string): AnalysisResult {
  return {
    generatedAt: '2026-09-16T00:00:00.000Z',
    stock_pool: [{ stock_code: code, stock_name: name, rating: '优先跟踪', total_score: 82 }],
    data_sources: [],
    research_confidence: '测试置信度',
    limitation_explain: '测试局限性',
  } as unknown as AnalysisResult;
}

beforeEach(() => {
  mocks.getSupportedStocks.mockReset();
  mocks.searchStocks.mockReset();
  mocks.runAnalysis.mockReset();
});

describe('GET /api/stocks — 支持股票列表', () => {
  it('正常路径：200 且原样返回服务层列表', async () => {
    const list = [
      { code: '600519', name: '贵州茅台', industry: '白酒' },
      { code: '000858', name: '五粮液', industry: '白酒' },
    ];
    mocks.getSupportedStocks.mockResolvedValue(list);

    const res = await request(app).get('/api/stocks');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(list);
    expect(mocks.getSupportedStocks).toHaveBeenCalledTimes(1);
  });

  it('上游失败：兜底返回茅台单条（200，而非 500）', async () => {
    mocks.getSupportedStocks.mockRejectedValue(new Error('缓存目录不可读'));

    const res = await request(app).get('/api/stocks');

    // 契约：列表接口失败也不能让前端下拉框为空/报错，兜底至少给出茅台
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ code: '600519', name: '贵州茅台', industry: '白酒' }]);
  });
});

describe('GET /api/stocks/search — 关键词搜索', () => {
  it('正常路径：200 且返回命中结果', async () => {
    mocks.searchStocks.mockResolvedValue([
      { code: '600519', name: '贵州茅台' },
      { code: '000858', name: '五粮液' },
    ]);

    const res = await request(app).get('/api/stocks/search').query({ keyword: '白酒' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { code: '600519', name: '贵州茅台' },
      { code: '000858', name: '五粮液' },
    ]);
    expect(mocks.searchStocks).toHaveBeenCalledWith('白酒');
  });

  it('上游失败：兜底返回空数组（200，而非 500/502）', async () => {
    mocks.searchStocks.mockRejectedValue(new Error('searchapi 不可达'));

    const res = await request(app).get('/api/stocks/search').query({ keyword: '茅台' });

    // 契约：搜索是弱依赖，失败降级为空结果，由前端展示"无匹配"
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/compare — 2-3 只股票横向对比', () => {
  it('2 只合法股票 → 200，返回 { stocks: [...] } 且顺序与入参一致', async () => {
    mocks.runAnalysis.mockImplementation((code: string) =>
      Promise.resolve(analysisResult(code, code === '600519' ? '贵州茅台' : '五粮液')),
    );

    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858'] });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.stocks)).toBe(true);
    expect(res.body.stocks).toHaveLength(2);
    expect(res.body.stocks[0].stock_code).toBe('600519');
    expect(res.body.stocks[1].stock_code).toBe('000858');
    expect(mocks.runAnalysis).toHaveBeenCalledTimes(2);
  });

  it('3 只合法股票 → 200（上限边界内）', async () => {
    mocks.runAnalysis.mockImplementation((code: string) =>
      Promise.resolve(analysisResult(code, `股票${code}`)),
    );

    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858', '603288'] });

    expect(res.status).toBe(200);
    expect(res.body.stocks).toHaveLength(3);
  });

  it('少于 2 只 / 多于 3 只 / 非数组 → 400（且不触发任何分析）', async () => {
    const one = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519'] });
    expect(one.status).toBe(400);
    expect(one.body.error).toBe('请选择2-3只股票进行对比');

    const four = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858', '603288', '600809'] });
    expect(four.status).toBe(400);
    expect(four.body.error).toBe('请选择2-3只股票进行对比');

    const notArray = await request(app).post('/api/compare').send({ stockCodes: '600519' });
    expect(notArray.status).toBe(400);
    expect(notArray.body.error).toBe('请选择2-3只股票进行对比');

    const missing = await request(app).post('/api/compare').send({});
    expect(missing.status).toBe(400);

    expect(mocks.runAnalysis).not.toHaveBeenCalled();
  });

  it('代码格式非法 → 400 且错误里指名具体代码', async () => {
    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', 'abc'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无效的股票代码：abc');
    expect(mocks.runAnalysis).not.toHaveBeenCalled();
  });

  it('单只失败 → 200 部分成功（新契约：失败只进 failures，不拖垮整批）', async () => {
    // 【契约变更】原用例断言「单只失败即整体 500（Promise.all 无部分成功）」，
    // 现改为 Promise.allSettled 逐只容错：成功的照常返回，失败的进 failures。
    // 变更原因：2~3 只各需 1~3 分钟，一只失败就丢弃另外两只已跑完的结果、用户只能整批重试，
    // 属 P0 体验问题（见 routes/market.ts compare 处理块注释）。
    mocks.runAnalysis.mockImplementation((code: string) =>
      code === '000858'
        ? Promise.reject(
            new Error(
              '无法获取股票数据: 000858，上游 http://push2.eastmoney.com/api/qt 返回 500，at fetchQuote (/app/server/src/services/dataService.ts:255)',
            ),
          )
        : Promise.resolve(analysisResult(code, '贵州茅台')),
    );

    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858', '603288'] });

    expect(res.status).toBe(200);
    // 成功的两只照常返回，顺序与请求一致（失败的 000858 不在其中）
    expect(res.body.stocks).toHaveLength(2);
    expect(res.body.stocks.map((s: { stock_code: string }) => s.stock_code)).toEqual([
      '600519',
      '603288',
    ]);
    // 失败的记进 failures：code 回填请求代码，error 是可读中文
    expect(res.body.failures).toHaveLength(1);
    expect(res.body.failures[0].code).toBe('000858');
    expect(typeof res.body.failures[0].error).toBe('string');
    expect(res.body.failures[0].error).toContain('数据不可用');
    // 生产安全：error 不得带堆栈 / 上游 URL / 文件路径（本文件此前刚修过 detail 泄漏，
    // 逐只回传等于把泄漏面从 1 条放大到每只 1 条，故此处必须锁死）
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('http://');
    expect(raw).not.toContain('https://');
    expect(raw).not.toContain('eastmoney');
    expect(raw).not.toContain('at ');
    expect(raw).not.toContain('.ts:');
    expect(raw).not.toContain('node_modules');
    // 三只都真的被尝试过（并行，不因一只失败而提前放弃）
    expect(mocks.runAnalysis).toHaveBeenCalledTimes(3);
  });

  it('全部成功 → 不返回 failures 字段（与旧契约逐字兼容，老客户端零改动）', async () => {
    mocks.runAnalysis.mockImplementation((code: string) =>
      Promise.resolve(analysisResult(code, `股票${code}`)),
    );

    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858'] });

    expect(res.status).toBe(200);
    expect(res.body.stocks).toHaveLength(2);
    // 刻意不返回 failures: []：老客户端/老契约的响应体里根本没有这个字段，
    // 只有"全部成功"时保持逐字一致，才是真正的向后兼容（而不是"多了一个空数组"）
    expect(res.body).not.toHaveProperty('failures');
    expect(Object.keys(res.body).sort()).toEqual(['stocks']);
  });

  it('全部失败 → 200 + stocks: [] + failures（不选 502/500 的理由见路由注释）', async () => {
    // 契约选择：请求本身合法，失败只发生在逐只分析阶段；逐只原因必须回传，502/500
    // 只能给一条整体 error（前端就丢了"哪只为什么失败"）。前端约定 stocks 为空即走
    // 既有整体错误提示路径，不渲染空表格。
    mocks.runAnalysis.mockRejectedValue(new Error('无法获取股票数据: 000858，上游超时'));

    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858'] });

    expect(res.status).toBe(200);
    expect(res.body.stocks).toEqual([]);
    expect(res.body.failures).toHaveLength(2);
    expect(res.body.failures.map((f: { code: string }) => f.code)).toEqual(['600519', '000858']);
    for (const f of res.body.failures as { error: string }[]) {
      expect(f.error).toBe('行情或财务数据不可用（可能已停牌或数据源异常）');
    }
    expect(res.body.detail).toBeUndefined();
  });

  it('失败原因分类：未知错误走稳定兜底文案，不把原始 message 透给客户端', async () => {
    mocks.runAnalysis.mockRejectedValue(
      new Error('ECONNREFUSED 127.0.0.1:8000 at Object.<anonymous> (/srv/app/dist/x.js:12)'),
    );

    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858'] });

    expect(res.status).toBe(200);
    expect(res.body.stocks).toEqual([]);
    expect(res.body.failures).toHaveLength(2);
    for (const f of res.body.failures as { error: string }[]) {
      expect(f.error).toBe('该股分析未完成，请稍后重试');
    }
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toContain('/srv/app');
  });

  it('LLM 排队超时：仍走 429（系统繁忙可退避），不能被当成部分成功吞掉', async () => {
    // compare 原契约里"排队超时 → 429 + Retry-After"是刻意保留的：客户端只有看到 429
    // 才会按 Retry-After 退避。改成逐只容错后，若把 QueueTimeoutError 也归到 failures，
    // 429 语义就静默消失了，故这里显式锁死。
    mocks.runAnalysis.mockImplementation((code: string) =>
      code === '000858'
        ? Promise.reject(new QueueTimeoutError('llm', 30_000, 45_000))
        : Promise.resolve(analysisResult(code, '贵州茅台')),
    );

    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858', '603288'] });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('LLM_QUEUE_TIMEOUT');
    expect(res.headers['retry-after']).toBe('45');
    expect(res.body.stocks).toBeUndefined();
  });

  it('runAnalysis 同步抛错 → 同样算单只失败（不会绕过 allSettled 打成 500）', async () => {
    mocks.runAnalysis.mockImplementation((code: string) => {
      if (code === '000858') throw new Error('invalid code');
      return Promise.resolve(analysisResult(code, '贵州茅台'));
    });

    const res = await request(app)
      .post('/api/compare')
      .send({ stockCodes: ['600519', '000858'] });

    expect(res.status).toBe(200);
    expect(res.body.stocks).toHaveLength(1);
    expect(res.body.stocks[0].stock_code).toBe('600519');
    expect(res.body.failures).toEqual([
      { code: '000858', error: '该股分析未完成，请稍后重试', errorCode: 'ANALYSIS_FAILED' },
    ]);
  });
});

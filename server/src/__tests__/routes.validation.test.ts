import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from '../index.js';

// /api/stocks/search 的服务层打桩。真实链路在 CI 上要先等东财 suggest 超时、再回落本地
// 全表 5000+ 只股票的最长公共子串 DP，耗时随机器负载在数秒到数十秒间浮动——同一提交在
// 两次 CI 上会得出相反结论（本文件此前为此把超时放宽到 30s，仍被打穿）。本文件要锁的是
// 「路由层闸门」，与上游是否可用无关，故与 routes.market.test.ts、routes.rateLimit.test.ts
// 采用同一套打桩口径，顺带守住 ci.yml 里「测试均已 mock 网络」这条约定。
const mocks = vi.hoisted(() => ({ searchStocks: vi.fn() }));

vi.mock('../services/dataService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dataService.js')>();
  return { ...actual, searchStocks: mocks.searchStocks };
});

// ============================================================================
// 入参校验回归测试（防"畸形输入污染持久化状态"）
//   背景：审计发现两处缺闸门的写接口——
//     1) /api/paper/settle 的收盘价未做数值校验：{"600519":"abc"} 会经
//        Math.round(NaN*100)/100 传染 cash/持仓/净值，落盘时序列化成 null 且不可自愈；
//     2) 非法 side 会跳过卖出的 T+1 校验、并在结算时被当作卖出处理。
//     3) /api/stocks/search 关键词无长度上限：全表最长公共子串 DP 会阻塞事件循环。
//   本文件锁定这三处的修复，避免回归。
//   隔离：全部用例不触真实网络（/api/stocks/search 的服务层打桩，其余路由只走校验分支）。
// ============================================================================

const tmpPaperFile = path.join(
  os.tmpdir(),
  `paper-validation-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
);

describe('模拟盘入参校验（/api/paper）', () => {
  beforeAll(() => {
    process.env.PAPER_TRADING_FILE = tmpPaperFile;
  });

  afterAll(() => {
    delete process.env.PAPER_TRADING_FILE;
    try {
      if (fs.existsSync(tmpPaperFile)) fs.unlinkSync(tmpPaperFile);
    } catch {
      /* 临时文件清理失败不影响用例 */
    }
  });

  it('结算价非数值（"abc"）→ 400，且账户 cash 不被污染成 NaN', async () => {
    const before = await request(app).get('/api/paper/portfolio');
    const cashBefore = before.body.cash;

    const res = await request(app)
      .post('/api/paper/settle')
      .send({ date: '2026-08-03', closePrices: { '600519': 'abc' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('结算参数无效');
    // 报错要指名道姓，用户才知道该改哪个字段
    expect(res.body.detail).toContain('600519');

    const after = await request(app).get('/api/paper/portfolio');
    expect(after.body.cash).toBe(cashBefore);
    expect(Number.isFinite(after.body.cash)).toBe(true);
  });

  it('结算价为 0 或负数 → 400（价格必须为正）', async () => {
    const zero = await request(app)
      .post('/api/paper/settle')
      .send({ date: '2026-08-03', closePrices: { '600519': 0 } });
    expect(zero.status).toBe(400);

    const negative = await request(app)
      .post('/api/paper/settle')
      .send({ date: '2026-08-03', closePrices: { '600519': -1 } });
    expect(negative.status).toBe(400);
  });

  it('结算价条目超过上限（500）→ 400', async () => {
    const closePrices: Record<string, number> = {};
    for (let i = 0; i < 501; i++) closePrices[String(600000 + i)] = 10;
    const res = await request(app)
      .post('/api/paper/settle')
      .send({ date: '2026-08-03', closePrices });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('条目过多');
  });

  it('closesPrices 为数组 → 400（类型不符）', async () => {
    const res = await request(app)
      .post('/api/paper/settle')
      .send({ date: '2026-08-03', closePrices: [1, 2, 3] });
    expect(res.status).toBe(400);
  });

  it('prevClosePrices 非法同样被拦截', async () => {
    const res = await request(app)
      .post('/api/paper/settle')
      .send({
        date: '2026-08-03',
        closePrices: { '600519': 1500 },
        prevClosePrices: { '600519': null },
      });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('prevClosePrices');
  });

  it('合法结算价仍正常通过 → 200', async () => {
    const res = await request(app)
      .post('/api/paper/settle')
      .send({ date: '2026-08-03', closePrices: { '600519': 1500 } });
    expect(res.status).toBe(200);
    expect(Number.isFinite(res.body.cash)).toBe(true);
  });

  it('非法 side → 400（不得被当作卖出处理，从而绕过 T+1）', async () => {
    const res = await request(app)
      .post('/api/paper/order')
      .send({ code: '600519', side: 'X', type: 'market', quantity: 100, date: '2026-08-04' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('买卖方向');
  });

  it('非法 type → 400', async () => {
    const res = await request(app)
      .post('/api/paper/order')
      .send({ code: '600519', side: 'buy', type: 'whatever', quantity: 100, date: '2026-08-04' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('订单类型');
  });

  it('限价单缺价格 → 400；数量非正 → 400', async () => {
    const noPrice = await request(app)
      .post('/api/paper/order')
      .send({ code: '600519', side: 'buy', type: 'limit', quantity: 100, date: '2026-08-04' });
    expect(noPrice.status).toBe(400);
    expect(noPrice.body.detail).toContain('限价单');

    const badQty = await request(app)
      .post('/api/paper/order')
      .send({ code: '600519', side: 'buy', type: 'market', quantity: 0, date: '2026-08-04' });
    expect(badQty.status).toBe(400);
    expect(badQty.body.detail).toContain('数量');
  });
});

describe('股票搜索入参校验（/api/stocks/search）', () => {
  beforeEach(() => {
    mocks.searchStocks.mockReset();
  });

  // 闸门的意义是「拦在昂贵匹配之前」：被拒的请求必须不触达服务层。
  it('缺少关键词 → 400，且不触达服务层', async () => {
    const res = await request(app).get('/api/stocks/search');
    expect(res.status).toBe(400);
    expect(mocks.searchStocks).not.toHaveBeenCalled();
  });

  it('关键词超长（>32 字符）→ 400，避免全表 DP 阻塞事件循环', async () => {
    const res = await request(app)
      .get('/api/stocks/search')
      .query({ keyword: '贵'.repeat(200) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('过长');
    expect(mocks.searchStocks).not.toHaveBeenCalled();
  });

  // 上限不能误伤正常词：≤32 字符必须放行到服务层，并原样回传其结果。
  it('正常关键词（≤32 字符）→ 放行到服务层并原样返回数组', async () => {
    const hits = [{ code: '600519', name: '贵州茅台' }];
    mocks.searchStocks.mockResolvedValue(hits);

    const res = await request(app).get('/api/stocks/search').query({ keyword: '茅台' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual(hits);
    expect(mocks.searchStocks).toHaveBeenCalledWith('茅台');
  });
});

describe('量化入参的代码形态校验（出站 URL 注入防护）', () => {
  // stockCode 最终会经 resolveSecid 拼进上游查询串（secid=...），
  // 此前只判非空 → `1&lmt=99999` 可改写上游的 lmt/fs 参数。
  it('POST /api/quant/factor/composite 非法代码 → 400 且给出形态要求', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite')
      .send({ stockCode: '1&lmt=99999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('6 位数字');
  });

  it('POST /api/quant/factor/composite/batch 含非法代码 → 400 并指出具体代码', async () => {
    const res = await request(app)
      .post('/api/quant/factor/composite/batch')
      .send({ stockCodes: ['600519', '600519?x=1'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('600519?x=1');
  });
});

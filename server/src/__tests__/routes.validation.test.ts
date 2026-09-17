import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from '../index.js';

// ============================================================================
// 入参校验回归测试（防"畸形输入污染持久化状态"）
//   背景：审计发现两处缺闸门的写接口——
//     1) /api/paper/settle 的收盘价未做数值校验：{"600519":"abc"} 会经
//        Math.round(NaN*100)/100 传染 cash/持仓/净值，落盘时序列化成 null 且不可自愈；
//     2) 非法 side 会跳过卖出的 T+1 校验、并在结算时被当作卖出处理。
//     3) /api/stocks/search 关键词无长度上限：全表最长公共子串 DP 会阻塞事件循环。
//   本文件锁定这三处的修复，避免回归。
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
  it('缺少关键词 → 400', async () => {
    const res = await request(app).get('/api/stocks/search');
    expect(res.status).toBe(400);
  });

  it('关键词超长（>32 字符）→ 400，避免全表 DP 阻塞事件循环', async () => {
    const res = await request(app)
      .get('/api/stocks/search')
      .query({ keyword: '贵'.repeat(200) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('过长');
  });

  // 真实打到 /api/stocks/search：CI 无外网时它会先等东财 suggest 超时，再回落本地全表
  // 模糊匹配（5000+ 只的最长公共子串 DP）。CI 机器慢时整条链路会超过默认的 5s，
  // 与代码无关（同一提交在另一次 CI 上就是通过的）——故给足超时而不是压缩断言。
  it('正常关键词（≤32 字符）→ 200 且返回数组', { timeout: 30_000 }, async () => {
    const res = await request(app).get('/api/stocks/search').query({ keyword: '茅台' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
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

/**
 * 模拟盘稳定性：损坏快照自愈 + 并发写入不丢订单/净值
 * ----------------------------------------------------------------------------
 * 与 routes.paper.test.ts 分开成文件，利用 vitest 的文件级隔离拿到**全新模块单例**
 * （模拟盘账户是模块级 `_paperAccount`），否则前面用例已经初始化过账户，
 * 无法验证“首次加载即损坏”的恢复路径。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 写请求较多：先放开限流，避免测试本身把配额打满（与真实阈值无关）
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX_WRITE = '100';
  process.env.RATE_LIMIT_MAX_META = '100';
});

import { app as rawApp } from '../index.js';
import { withContract } from '../test/contractSupertest.js';

const app = withContract(rawApp);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-resilience-'));
const accountFile = path.join(tmpDir, 'paperTrading.json');

beforeAll(() => {
  process.env.PAPER_TRADING_FILE = accountFile;
  // 首次加载就遇到半写/损坏快照：真实场景是磁盘写满或进程被强杀
  fs.writeFileSync(accountFile, '{ broken json', 'utf-8');
});

afterAll(() => {
  delete process.env.PAPER_TRADING_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('模拟盘快照损坏自愈', () => {
  it('损坏快照被留档后按新账户继续服务，而不是持续 500', async () => {
    const res = await request(app).get('/api/paper/portfolio').expect(200);
    expect(res.body.initialCapital).toBeGreaterThan(0);
    expect(res.body.cash).toBe(res.body.initialCapital);

    const backups = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('paperTrading.json.corrupt-'));
    expect(backups).toHaveLength(1);

    // 重建后的快照必须是合法 JSON，重启可正常加载
    const rebuilt = JSON.parse(fs.readFileSync(accountFile, 'utf-8')) as { cash: number };
    expect(rebuilt.cash).toBe(res.body.initialCapital);
  });
});

describe('模拟盘并发写入', () => {
  it('并发下单：所有订单都进流水，不互相覆盖', async () => {
    const codes = Array.from({ length: 12 }, (_, i) => String(600100 + i));
    const results = await Promise.all(
      codes.map((code) =>
        request(app)
          .post('/api/paper/order')
          .send({ code, side: 'buy', type: 'market', quantity: 100, date: '2026-08-10' }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const portfolio = await request(app).get('/api/paper/portfolio').expect(200);
    const orderCodes = new Set(
      (portfolio.body.orders as { code: string }[]).map((order) => order.code),
    );
    for (const code of codes) expect(orderCodes.has(code)).toBe(true);
    expect(portfolio.body.orders).toHaveLength(codes.length);
  });

  it('同一交易日并发结算：净值点只记一次（幂等），不虚增天数', async () => {
    const settle = () =>
      request(app)
        .post('/api/paper/settle')
        .send({ date: '2026-08-10', closePrices: { '600100': 10, '600101': 11 } });
    const results = await Promise.all([settle(), settle(), settle()]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const portfolio = await request(app).get('/api/paper/portfolio').expect(200);
    const points = (portfolio.body.equity as { date: string }[]).filter(
      (p) => p.date === '2026-08-10',
    );
    expect(points).toHaveLength(1);

    const stats = await request(app).get('/api/paper/stats').expect(200);
    expect(stats.body.totalDays).toBe(1);
  });
});

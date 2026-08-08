import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from '../index.js';
import { auditLogger } from '../services/auditLog.js';

// ============================================================================
// 新 API 路由集成测试（不触真实外部依赖）：模拟盘 / 合规审计 / 港美股财务估值
//   - 模拟盘：账户为模块级单例 + JSON 文件持久化。用 PAPER_TRADING_FILE 重定向到
//     系统临时目录（beforeAll 设、afterAll 清理），避免污染真实账户数据
//     server/src/data/paperTrading.json（参考 watchlist 的 WATCHLIST_FILE 隔离模式）。
//   - 审计：复用全局 auditLogger 单例（与 index.ts 同一实例），beforeEach clear 后
//     写入受控条目，验证查询与 riskLevel 过滤。
//   - 港美股：intlDataProvider 直接调用全局 fetch，mock globalThis.fetch 返回东财
//     RPT 结构（data.result.data 数组），afterEach 恢复原始 fetch。
// ============================================================================

// 模拟盘持久化文件：重定向到临时路径
const tmpPaperFile = path.join(
  os.tmpdir(),
  `paper-route-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
);

// 备份全局 fetch（港美股测试用），afterEach 恢复
const originalFetch = globalThis.fetch;

/** 构造一个 HTTP 200 + JSON payload 的 Response mock 对象 */
function okJsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(payload),
  };
}

/** 构造东方财富数据中心 RPT 网关成功响应（data.result.data 数组） */
function rptOk(data: Array<Record<string, unknown>>): unknown {
  return {
    version: 'test',
    result: { pages: data.length > 0 ? 1 : 0, data },
    success: true,
    message: 'ok',
    code: 0,
  };
}

describe('模拟盘路由（/api/paper）', () => {
  beforeAll(() => {
    // 清理上一次运行可能残留的临时快照，确保账户以全新状态加载
    try {
      if (fs.existsSync(tmpPaperFile)) fs.unlinkSync(tmpPaperFile);
    } catch {
      /* 清理失败不影响用例 */
    }
    // 重定向持久化文件到临时路径，隔离真实账户数据
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

  it('GET /api/paper/portfolio → 200，返回 initialCapital/cash/positions/equity', async () => {
    const res = await request(app).get('/api/paper/portfolio');
    expect(res.status).toBe(200);
    // 全新账户：现金 = 初始资金，无持仓无净值
    expect(typeof res.body.initialCapital).toBe('number');
    expect(res.body.initialCapital).toBeGreaterThan(0);
    expect(res.body.cash).toBe(res.body.initialCapital);
    expect(Array.isArray(res.body.positions)).toBe(true);
    expect(Array.isArray(res.body.equity)).toBe(true);
  });

  it('POST /api/paper/order 合法市价买单 → 200，订单进挂单（pending）', async () => {
    const res = await request(app)
      .post('/api/paper/order')
      .send({ code: '600519', side: 'buy', type: 'market', quantity: 100, date: '2026-08-01' });
    expect(res.status).toBe(200);
    expect(res.body.order).toBeDefined();
    expect(res.body.order.code).toBe('600519');
    // 市价单当日收盘前为挂单，日终 settle 按收盘价撮合
    expect(res.body.order.status).toBe('pending');
  });

  it('POST /api/paper/order 缺少 code → 400', async () => {
    const res = await request(app)
      .post('/api/paper/order')
      .send({ side: 'buy', type: 'market', quantity: 100, date: '2026-08-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('POST /api/paper/settle → 200，返回 cash / latestEquity', async () => {
    const res = await request(app)
      .post('/api/paper/settle')
      .send({ date: '2026-08-01', closePrices: { '600519': 1500 } });
    expect(res.status).toBe(200);
    expect(typeof res.body.cash).toBe('number');
    // latestEquity 为最新净值点对象 { date, value }
    expect(res.body.latestEquity).toBeDefined();
    expect(typeof res.body.latestEquity).toBe('object');
    expect(typeof res.body.latestEquity.value).toBe('number');
    expect(Array.isArray(res.body.history)).toBe(true);
  });
});

describe('合规审计查询路由（/api/audit）', () => {
  beforeEach(() => {
    // 清空全局审计日志，确保每次断言基于受控条目
    auditLogger.clear();
  });

  it('GET /api/audit → 200，返回 { count, entries }', async () => {
    auditLogger.log({
      sessionId: 'route-test',
      action: 'llm.chat',
      category: 'llm_call',
      detail: '测试审计条目',
      riskLevel: 'info',
    });
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(200);
    expect(typeof res.body.count).toBe('number');
    expect(res.body.count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries[0].riskLevel).toBe('info');
  });

  it('GET /api/audit?riskLevel=critical → 200，按风险等级过滤正常', async () => {
    auditLogger.log({
      sessionId: 'route-test',
      action: 'llm.chat',
      category: 'llm_call',
      detail: '低风险',
      riskLevel: 'info',
    });
    auditLogger.log({
      sessionId: 'route-test',
      action: 'trade.signal',
      category: 'trade_signal',
      detail: '高风险',
      riskLevel: 'critical',
    });
    const res = await request(app).get('/api/audit').query({ riskLevel: 'critical' });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].riskLevel).toBe('critical');
  });
});

describe('港美股财务估值路由（/api/intl/fundamentals）', () => {
  beforeEach(() => {
    // 统一 mock 全局 fetch：港股 RPT 主要指标一次返回名称 + 完整估值字段
    globalThis.fetch = vi.fn().mockResolvedValue(
      okJsonResponse(
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
      ),
    ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('GET /api/intl/fundamentals?code=00700&market=HK → 200，返回 fundamentals 字段', async () => {
    const res = await request(app)
      .get('/api/intl/fundamentals')
      .query({ code: '00700', market: 'HK' });
    expect(res.status).toBe(200);
    expect(res.body.fundamentals).toBeDefined();
    expect(res.body.fundamentals.code).toBe('00700');
    expect(res.body.fundamentals.market).toBe('HK');
    expect(res.body.fundamentals.name).toBe('腾讯控股');
    expect(res.body.fundamentals.pe).toBe(18.5);
    expect(res.body.fundamentals.pb).toBe(4.2);
    expect(res.body.fundamentals.marketCap).toBe(36000); // 3.6e12 元 → 亿元
    expect(res.body.degraded).toBe(false);
  });

  it('缺少 code → 400', async () => {
    const res = await request(app).get('/api/intl/fundamentals');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('A 股代码（600519，无 market）→ 400，提示走 /api/analyze', async () => {
    const res = await request(app).get('/api/intl/fundamentals').query({ code: '600519' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

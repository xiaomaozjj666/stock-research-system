/**
 * quantOps 昂贵操作的护栏（此前审查的三处缺口）
 * ----------------------------------------------------------------------------
 *  1. run 类端点无并发护栏：限流按 IP 计管不住并发，多开/连点可让全市场扫描
 *     同时跑多份（共享上游配额与 CPU）→ 进程内闸，超出 429；
 *  2. maxStocks 非有限/非正数此前被 screener 当 undefined → **静默升级成全市场
 *     扫描**（最贵路径）且照样 200 → 入口 400；
 *  3. 实验补录 entries 只校验数组形状，元素零校验 → 未校验行会进入改进循环的
 *     回放证据（可伪造 kept/evidence 让自动判据漂移）→ 逐条 schema 校验。
 */
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware.js')>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    ...actual,
    quantLimiter: pass,
    watchlistLimiter: pass,
    circuitBreakerGuard: pass,
  };
});

vi.mock('../quant/screener.js', () => ({
  runMarketScreener: vi.fn(),
  readLatestScreenerRun: vi.fn(() => null),
  ScreenerParamError: class ScreenerParamError extends Error {},
}));

import { app as rawApp } from '../index.js';
import { runMarketScreener } from '../quant/screener.js';
import { clearFactorExperiments } from '../quant/factorLedger.js';
import { resetGates } from '../utils/heavyGate.js';

const app = rawApp;
// 台账文件重定向到临时目录（getFile 惰性读 env，每次调用时解析）
const qd = fs.mkdtempSync(path.join(os.tmpdir(), 'quantops-guards-'));
const mockedScreener = vi.mocked(runMarketScreener);

beforeAll(() => {
  process.env.FACTOR_LEDGER_FILE = path.join(qd, 'factorExperiments.json');
});
afterAll(() => {
  try {
    fs.rmSync(qd, { recursive: true, force: true });
  } catch {
    /* 清理失败可忽略 */
  }
});

beforeEach(() => {
  resetGates();
  clearFactorExperiments();
  mockedScreener.mockReset();
});

describe('/api/quant/screener/run 护栏', () => {
  it('maxStocks 非整数/非正 → 400，且不触发全市场扫描', async () => {
    for (const bad of ['abc', 0, -5, 1.5]) {
      const r = await request(app).post('/api/quant/screener/run').send({ maxStocks: bad });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('maxStocks');
    }
    expect(mockedScreener).not.toHaveBeenCalled();
  });

  it('并发闸（上限 2）：两份额度用满时第三份 429；完成后放行', async () => {
    const releases: ((v: unknown) => void)[] = [];
    mockedScreener.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }) as unknown as ReturnType<typeof runMarketScreener>,
    );

    // supertest 的 Test 是惰性的：不订阅不会真正发请求——先 .then 启动它们
    const startReq = () =>
      request(app)
        .post('/api/quant/screener/run')
        .send({ maxStocks: 10 })
        .then((r) => r);
    const first = startReq();
    const second = startReq();
    // 让两个请求进入 handler 并占满闸门
    await new Promise((r) => setTimeout(r, 50));

    const third = await request(app).post('/api/quant/screener/run').send({ maxStocks: 10 });
    expect(third.status).toBe(429);
    expect(third.body.retryAfterSeconds).toBe(30);

    // 两份都放行完成后，闸门释放 → 新请求可跑
    for (const release of releases) {
      release({ ranAt: 'x', universe: { total: 10, scanned: 10, coverage: 1 }, hits: [] });
    }
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    mockedScreener.mockResolvedValue({
      ranAt: 'x',
      universe: { total: 10, scanned: 10, coverage: 1 },
      hits: [],
    } as unknown as Awaited<ReturnType<typeof runMarketScreener>>);
    const fourth = await request(app).post('/api/quant/screener/run').send({ maxStocks: 10 });
    expect(fourth.status).toBe(200);
  });
});

describe('/api/quant/factor/experiments 逐条校验', () => {
  const validEntry = {
    source: 'expression',
    name: 'roe_momentum',
    expression: 'close / mean(close, 20) - 1',
    universe: { requested: 10, included: 10 },
    horizon: 21,
    sampleSize: 100,
    icMean: 0.03,
    pValue: 0.04,
    oosStable: true,
    kept: true,
  };

  it('合法条目 → 200 且入账', async () => {
    const r = await request(app)
      .post('/api/quant/factor/experiments')
      .send({ entries: [validEntry] });
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(1);
  });

  it('source 非法 → 400 且带下标定位', async () => {
    const r = await request(app)
      .post('/api/quant/factor/experiments')
      .send({ entries: [validEntry, { ...validEntry, source: 'forged' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('entries[1]');
    expect(r.body.error).toContain('source');
  });

  it('evidence 形态非法 / 超长 name → 400（可伪造的判据证据不得入台账）', async () => {
    // NaN 经 JSON 序列化会变 null（服务端无法区分），用 JSON 可表达的非法形态：
    // evidence 不是对象 → 拒绝
    const badEvidence = await request(app)
      .post('/api/quant/factor/experiments')
      .send({ entries: [{ ...validEntry, evidence: 'not-an-object' }] });
    expect(badEvidence.status).toBe(400);
    expect(badEvidence.body.error).toContain('evidence');

    const longName = await request(app)
      .post('/api/quant/factor/experiments')
      .send({ entries: [{ ...validEntry, name: 'x'.repeat(200) }] });
    expect(longName.status).toBe(400);
    expect(longName.body.error).toContain('name');
  });

  it('pValue 越界 / kept 非布尔 → 400', async () => {
    const badP = await request(app)
      .post('/api/quant/factor/experiments')
      .send({ entries: [{ ...validEntry, pValue: 1.5 }] });
    expect(badP.status).toBe(400);
    const badKept = await request(app)
      .post('/api/quant/factor/experiments')
      .send({ entries: [{ ...validEntry, kept: 'true' }] });
    expect(badKept.status).toBe(400);
  });
});

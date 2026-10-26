import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { app as rawApp } from '../index.js';
import { withContract } from '../test/contractSupertest.js';
import type { ThesisRecord } from '../services/thesisService.js';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn(async () => []) }));
vi.mock('../quant/dataProvider.js', () => ({ fetchOHLCVData: fetchMock }));
const app = withContract(rawApp);
const tmpDir = mkdtempSync(join(tmpdir(), 'thesis-route-'));
const tmpFile = join(tmpDir, 'theses.json');
const originalFile = process.env.THESIS_FILE;

const validBody = {
  stockCode: '600519',
  thesis: '真实收盘证据若达到证伪线则撤销假设',
  rating: '持续观察',
  totalScore: 66,
  metric: 'return_pct',
  comparator: 'lte',
  threshold: -5,
  horizonDays: 20,
  evidenceSource: 'real_ohlcv',
  invalidationAction: '撤销假设并复核风险',
  benchmarkCode: '000300',
  execution: {
    side: 'buy',
    orderType: 'market',
    entryPrice: 100,
    quantity: 100,
    commissionRate: 0.0003,
    stampDutyRate: 0.0005,
  },
};

beforeEach(() => {
  process.env.THESIS_FILE = tmpFile;
  writeFileSync(tmpFile, JSON.stringify({ items: [] }));
  fetchMock.mockClear();
});

afterAll(() => {
  if (originalFile === undefined) delete process.env.THESIS_FILE;
  else process.env.THESIS_FILE = originalFile;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('/api/theses 预注册 API', () => {
  it('创建 active 记录并忽略客户端注入的 id/status/dueAt/evaluatedAt', async () => {
    const res = await request(app)
      .post('/api/theses')
      .send({
        ...validBody,
        id: 'forged',
        status: 'invalidated',
        dueAt: '2000-01-01',
        evaluatedAt: '2000-01-01',
      });
    expect(res.status).toBe(201);
    expect(res.body.thesis.id).not.toBe('forged');
    expect(res.body.thesis.status).toBe('active');
    expect(res.body.thesis.evidenceStatus).toBe('pending');
    expect(res.body.thesis.evaluatedAt).toBeUndefined();
    expect(new Date(res.body.thesis.dueAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.thesis.benchmarkCode).toBe('000300');
    expect(res.body.thesis.execution).toEqual(validBody.execution);
  });

  it('拒绝非法证据源/比较符/成交规则，未到期评估保持 active', async () => {
    const bad = await request(app)
      .post('/api/theses')
      .send({ ...validBody, evidenceSource: 'future_oracle' });
    expect(bad.status).toBe(400);

    const created = await request(app).post('/api/theses').send(validBody);
    const evaluated = await request(app).post(`/api/theses/${created.body.thesis.id}/evaluate`);
    expect(evaluated.status).toBe(200);
    expect(evaluated.body.thesis.status).toBe('active');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('无修改路由；篡改请求返回 404 且冻结字段不变', async () => {
    const created = await request(app).post('/api/theses').send(validBody);
    const id = created.body.thesis.id as string;
    const patch = await request(app)
      .patch(`/api/theses/${id}`)
      .send({ threshold: 999, horizonDays: 1, benchmarkCode: '999999' });
    expect(patch.status).toBe(404);

    const listed = await request(app).get('/api/theses?stockCode=600519');
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      id,
      threshold: -5,
      horizonDays: 20,
      benchmarkCode: '000300',
      status: 'active',
    });
  });

  it('到期缺真实行情时返回 expired + insufficient_evidence，不返回收益', async () => {
    const created = await request(app).post('/api/theses').send(validBody);
    const id = created.body.thesis.id as string;
    const stored = JSON.parse(readFileSync(tmpFile, 'utf-8')) as { items: ThesisRecord[] };
    stored.items[0].dueAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(tmpFile, JSON.stringify(stored));

    const evaluated = await request(app).post(`/api/theses/${id}/evaluate`);
    expect(evaluated.status).toBe(200);
    expect(evaluated.body.thesis.status).toBe('expired');
    expect(evaluated.body.thesis.evidenceStatus).toBe('insufficient_evidence');
    expect(evaluated.body.thesis.returnPct).toBeUndefined();
    expect(evaluated.body.thesis.observedValue).toBeUndefined();
  });
});

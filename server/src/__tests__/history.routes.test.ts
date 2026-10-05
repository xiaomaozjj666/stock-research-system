import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// app 经 withContract 包装：所有 2xx JSON 响应自动接受契约校验（见 test/contractSupertest.ts）
import { app as rawApp } from '../index.js';
import { withContract } from '../test/contractSupertest.js';
import { analysisResult } from '../test/contractFixtures.js';
const app = withContract(rawApp);

import { saveHistoryEntry } from '../services/historyService.js';

// 历史落盘重定向到临时文件（与单测同模式），路由测试经真实 app 验证 CRUD
const tmpDir = mkdtempSync(join(tmpdir(), 'history-route-'));
const origFile = process.env.HISTORY_FILE;

beforeAll(() => {
  process.env.HISTORY_FILE = join(tmpDir, 'history.json');
});
afterAll(() => {
  if (origFile === undefined) delete process.env.HISTORY_FILE;
  else process.env.HISTORY_FILE = origFile;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/history 研究历史路由', () => {
  it('空历史返回空列表', async () => {
    const res = await request(app).get('/api/history');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('列表返回摘要条目（含股票/时间/评级/评分）', async () => {
    const saved = saveHistoryEntry({
      stockCode: '600519',
      stockName: '贵州茅台',
      industry: '白酒',
      rating: '优先跟踪',
      totalScore: 92,
      result: analysisResult(),
    });
    const res = await request(app).get('/api/history');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: saved!.id,
      stockCode: '600519',
      stockName: '贵州茅台',
      rating: '优先跟踪',
      totalScore: 92,
    });
    expect(res.body.items[0]).not.toHaveProperty('result');
  });

  it('详情返回完整 result', async () => {
    const saved = saveHistoryEntry({
      stockCode: '000001',
      stockName: '平安银行',
      rating: '持续观察',
      totalScore: 60,
      result: analysisResult('000001', '平安银行'),
    });
    const res = await request(app).get(`/api/history/${saved!.id}`);
    expect(res.status).toBe(200);
    expect(res.body.result.stock_pool[0].stock_code).toBe('000001');
  });

  it('不存在的详情返回 404', async () => {
    const res = await request(app).get('/api/history/nope');
    expect(res.status).toBe(404);
  });

  it('删除后详情 404，重复删除 404', async () => {
    const saved = saveHistoryEntry({
      stockCode: '300750',
      stockName: '宁德时代',
      rating: '优先跟踪',
      totalScore: 90,
      result: analysisResult('300750', '宁德时代'),
    });
    const del = await request(app).delete(`/api/history/${saved!.id}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    const again = await request(app).delete(`/api/history/${saved!.id}`);
    expect(again.status).toBe(404);
  });
});

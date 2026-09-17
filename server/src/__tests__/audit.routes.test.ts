/**
 * 合规审计查询路由（/api/audit）分页与参数校验
 * ----------------------------------------------------------------------------
 * 背景：此前 `auditLogger.query(filter)` 全量匹配后直接 `res.json({ count, entries })`
 * 全量下发——内存上限 10000 条时单次响应约 3.5MB，而客户端只用 20 条（浪费约 500×）。
 * 现在支持 limit/offset（`count` 仍是匹配总数），但不传分页时保持旧行为（返回全量）。
 *
 * 另：`?startTime=abc` 此前 Number('abc')=NaN 被当作过滤条件（与任何 timestamp 比较都为
 * false）静默返回空列表；现在一律 400，让参数写错立刻可见。
 *
 * 本文件不读运行时数据文件、不发真实网络：审计台账是内存单例，落盘路径由
 * server/src/test/setup.ts 重定向到临时目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';
import { auditLogger } from '../services/auditLog.js';

const SEED_COUNT = 20;
/** 预置时间戳：递增，供时间范围过滤用例断言 */
const BASE_TS = 1_700_000_000_000;

function seedEntries(): void {
  auditLogger.clear();
  for (let i = 0; i < SEED_COUNT; i++) {
    auditLogger.log({
      sessionId: 'route-test',
      action: `a${i}`,
      category: 'tool_call',
      detail: `条目 ${i}`,
      // 前一半 high、后一半 info：供过滤 + 分页组合断言
      riskLevel: i < SEED_COUNT / 2 ? 'high' : 'info',
      timestamp: BASE_TS + i * 1000,
    });
  }
}

describe('GET /api/audit 分页与参数校验', () => {
  beforeEach(() => {
    seedEntries();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('limit：只返回本页，count 仍是匹配总数', async () => {
    const res = await request(app).get('/api/audit').query({ limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(SEED_COUNT); // 总数（不是本页条数）
    expect(res.body.entries).toHaveLength(5);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
      'a0',
      'a1',
      'a2',
      'a3',
      'a4',
    ]);
  });

  it('limit + offset：返回正确的一页（供「加载更多」逐页追加）', async () => {
    const res = await request(app).get('/api/audit').query({ limit: 5, offset: 5 });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(SEED_COUNT);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
      'a5',
      'a6',
      'a7',
      'a8',
      'a9',
    ]);
  });

  it('offset 超出总数：空数组但保留 count（客户端据此判断"没有更多"）', async () => {
    const res = await request(app).get('/api/audit').query({ limit: 5, offset: 100 });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.count).toBe(SEED_COUNT);
  });

  it('只传 offset：丢弃前 offset 条后返回其余全部', async () => {
    const res = await request(app).get('/api/audit').query({ offset: 18 });
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual(['a18', 'a19']);
    expect(res.body.count).toBe(SEED_COUNT);
  });

  it('不传分页参数：保持旧行为（全量下发）', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(SEED_COUNT);
    expect(res.body.entries).toHaveLength(SEED_COUNT);
  });

  it('过滤 + 分页组合：count 为过滤后的总数', async () => {
    const res = await request(app).get('/api/audit').query({ riskLevel: 'high', limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(SEED_COUNT / 2); // high 共 10 条
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries.every((e: { riskLevel: string }) => e.riskLevel === 'high')).toBe(true);
  });

  it('合法时间参数照常过滤（含端点）', async () => {
    const res = await request(app)
      .get('/api/audit')
      .query({ startTime: BASE_TS + 15 * 1000, endTime: BASE_TS + 17 * 1000 });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
  });

  it('?startTime=abc → 400（不再静默当 NaN 过滤后返回空列表）', async () => {
    const res = await request(app).get('/api/audit').query({ startTime: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('查询参数非法');
    expect(res.body.detail).toContain('startTime');
    expect(res.body).not.toHaveProperty('entries');
  });

  it('?endTime=abc → 400', async () => {
    const res = await request(app).get('/api/audit').query({ endTime: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('endTime');
  });

  it('分页参数非法（负数 / 非整数）→ 400', async () => {
    const negLimit = await request(app).get('/api/audit').query({ limit: -1 });
    expect(negLimit.status).toBe(400);
    expect(negLimit.body.detail).toContain('limit');

    const floatOffset = await request(app).get('/api/audit').query({ offset: '1.5' });
    expect(floatOffset.status).toBe(400);
    expect(floatOffset.body.detail).toContain('offset');
  });

  it('limit=0：返回空页但 count 仍是匹配总数', async () => {
    const res = await request(app).get('/api/audit').query({ limit: 0 });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.count).toBe(SEED_COUNT);
  });
});

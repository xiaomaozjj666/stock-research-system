import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../index.js';

/**
 * 自选股清单容量上限（P1：addToWatchlist 无条数上限）
 * ----------------------------------------------------------------------------
 * 本文件走真实 app + 真实 watchlistService（含文件持久化，路径重定向到临时文件），
 * 只把上限压到 2 只以便确定性验证路由层行为：
 *   - 未满：正常 200；
 *   - 已满：**可操作的 400**（写明上限、当前只数、怎么清理），且磁盘不被改写；
 *   - 满员时重复添加已有代码：幂等 200（去重优先于容量，不能把重放请求判成失败）。
 * 服务层闸门（env 解析、setWatchlist 越限）由 services/__tests__/watchlistService.test.ts 覆盖。
 */

let tmpDir: string;
let watchlistFile: string;
const origWatchlistFile = process.env.WATCHLIST_FILE;
const origMax = process.env.WATCHLIST_MAX;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'watchlist-capacity-'));
  watchlistFile = join(tmpDir, 'watchlist.json');
  process.env.WATCHLIST_FILE = watchlistFile;
  process.env.WATCHLIST_MAX = '2';
});

afterAll(() => {
  if (origWatchlistFile === undefined) delete process.env.WATCHLIST_FILE;
  else process.env.WATCHLIST_FILE = origWatchlistFile;
  if (origMax === undefined) delete process.env.WATCHLIST_MAX;
  else process.env.WATCHLIST_MAX = origMax;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(watchlistFile)) rmSync(watchlistFile, { force: true });
});

/** 预置清单内容（模拟已有自选股） */
function seed(codes: string[]): void {
  writeFileSync(watchlistFile, JSON.stringify(codes), 'utf-8');
}

describe('清单容量上限（WATCHLIST_MAX=2）', () => {
  it('未满：正常新增 → 200 且落盘', async () => {
    seed(['600519']);

    const res = await request(app).post('/api/watchlist').send({ code: '000001' });

    expect(res.status).toBe(200);
    expect(res.body.codes).toEqual(['600519', '000001']);
    expect(JSON.parse(readFileSync(watchlistFile, 'utf-8'))).toEqual(['600519', '000001']);
  });

  it('已满：新增 → 400（可操作提示），且磁盘不被改写', async () => {
    seed(['600519', '000001']);

    const res = await request(app).post('/api/watchlist').send({ code: '300750' });

    expect(res.status).toBe(400);
    // 提示必须可操作：说清上限、当前只数、怎么清理
    expect(res.body.error).toContain('上限');
    expect(res.body.error).toContain('2');
    expect(res.body.detail).toContain('WATCHLIST_MAX');
    expect(res.body.detail).toContain('DELETE /api/watchlist/:code');
    expect(res.body.limit).toBe(2);
    expect(res.body.codes).toEqual(['600519', '000001']);
    // 关键：不是静默截断，也不是"加进去了但没告诉你"——磁盘保持原样
    expect(JSON.parse(readFileSync(watchlistFile, 'utf-8'))).toEqual(['600519', '000001']);
  });

  it('已满但代码已存在：幂等 200（重放请求不该被判失败）', async () => {
    seed(['600519', '000001']);

    const res = await request(app).post('/api/watchlist').send({ code: '600519' });

    expect(res.status).toBe(200);
    expect(res.body.codes).toEqual(['600519', '000001']);
  });

  it('删除一只腾出位置后可以继续新增', async () => {
    seed(['600519', '000001']);

    const del = await request(app).delete('/api/watchlist/600519');
    expect(del.status).toBe(200);
    expect(del.body.codes).toEqual(['000001']);

    const add = await request(app).post('/api/watchlist').send({ code: '300750' });
    expect(add.status).toBe(200);
    expect(add.body.codes).toEqual(['000001', '300750']);
  });

  it('非法代码仍先被形态校验拦下（400，且不占用容量判断）', async () => {
    seed(['600519', '000001']);

    const res = await request(app).post('/api/watchlist').send({ code: '600519&lmt=99999' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('请提供有效的6位股票代码');
  });

  it('超限文件（旧版本写入的 3 只）不会被静默截断：读取如实返回，新增按已满拒绝', async () => {
    seed(['600519', '000001', '300750']);

    const get = await request(app).get('/api/watchlist');
    expect(get.body.codes).toHaveLength(3); // 如实返回，不偷偷丢掉第 3 只

    const add = await request(app).post('/api/watchlist').send({ code: '600036' });
    expect(add.status).toBe(400); // 已超限 → 拒绝写入而不是继续膨胀
  });
});

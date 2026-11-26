import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { partial } from '../../test/partial.js';
import type { AnalysisResult } from '../../types.js';
import {
  closeHistoryStore,
  computeVsPrevious,
  DEFAULT_HISTORY_MAX_ITEMS,
  deleteHistoryItem,
  getHistoryItem,
  getPreviousAnalysis,
  HISTORY_MAX_ITEMS_HARD_LIMIT,
  listHistory,
  MAX_TIMELINE_POINTS,
  maxHistoryItems,
  resetHistoryStoreCache,
  saveHistoryEntry,
  type HistoryEntryInput,
  type HistoryItem,
  type HistorySummary,
} from '../historyService.js';

// node:fs 展开成普通对象，便于 spyOn renameSync（ESM 命名空间本身不可配置）。
// 行为与真模块一致（仅引用形态变化）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual };
});

// 历史库重定向到进程专属临时目录：HISTORY_FILE 同时作为旧 JSON 迁移来源与
// 数据库路径的推导依据（同目录 history.db）。
const tmpDir = mkdtempSync(join(tmpdir(), 'history-svc-'));
const legacyFile = join(tmpDir, 'history.json');
const dbFile = join(tmpDir, 'history.db');
const origFile = process.env.HISTORY_FILE;
const origDb = process.env.HISTORY_DB_FILE;

beforeAll(() => {
  process.env.HISTORY_FILE = legacyFile;
  delete process.env.HISTORY_DB_FILE;
});
afterAll(() => {
  closeHistoryStore();
  if (origFile === undefined) delete process.env.HISTORY_FILE;
  else process.env.HISTORY_FILE = origFile;
  if (origDb === undefined) delete process.env.HISTORY_DB_FILE;
  else process.env.HISTORY_DB_FILE = origDb;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 清空所有历史落盘（DB + WAL/SHM + 旧 JSON + 留档文件），保证用例从确定空态开始 */
function clearStorage(): void {
  closeHistoryStore();
  for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, legacyFile, `${legacyFile}.tmp`]) {
    rmSync(file, { force: true });
  }
  for (const f of readdirSync(tmpDir)) {
    if (f.includes('.corrupt-') || f.includes('.migrated-'))
      rmSync(join(tmpDir, f), { force: true });
  }
}

/** 播一颗旧 JSON 种子：首次读取时由服务自动迁移进 SQLite */
function seedFile(raw: string): void {
  clearStorage();
  writeFileSync(legacyFile, raw, 'utf-8');
  resetHistoryStoreCache();
}

/** 直接弄坏 SQLite 文件（模拟磁盘损坏/半写），用于损坏留档用例 */
function corruptDb(raw = 'not a sqlite database'): void {
  closeHistoryStore();
  rmSync(dbFile, { force: true });
  writeFileSync(dbFile, raw, 'utf-8');
  resetHistoryStoreCache();
}

function makeEntry(code: string, over: Partial<HistoryEntryInput> = {}): HistoryEntryInput {
  return {
    stockCode: code,
    stockName: `股票${code}`,
    industry: '白酒',
    rating: '持续观察',
    totalScore: 60,
    result: partial<AnalysisResult>({
      stock_pool: [partial<AnalysisResult['stock_pool'][number]>({ stock_code: code })],
    }),
    ...over,
  };
}

describe('historyService 研究历史', () => {
  beforeEach(() => {
    clearStorage();
  });

  it('保存新增条目，列表返回摘要（不含 result）', async () => {
    await saveHistoryEntry(makeEntry('600519', { totalScore: 88 }));
    await saveHistoryEntry(makeEntry('000001', { totalScore: 55 }));

    const list = await listHistory();
    expect(list).toHaveLength(2);
    // 注意：快速连续保存可能落在同一毫秒（createdAt 相同），此时排序是稳定序，
    // 顺序断言不可靠——这里只断言内容，排序语义由下方 fixture 用例验证
    const byCode = Object.fromEntries(list.map((i) => [i.stockCode, i]));
    expect(byCode['600519'].totalScore).toBe(88);
    expect(byCode['600519'].rating).toBe('持续观察');
    expect(byCode['000001'].totalScore).toBe(55);
    expect(list[0]).not.toHaveProperty('result'); // 列表瘦身（不含完整 result）
  });

  it('列表按 createdAt 倒序（最新在前）', async () => {
    // 用明确 createdAt 的 fixture 验证排序，不依赖 saveHistoryEntry 的毫秒精度
    seedFile(
      JSON.stringify({
        items: [
          {
            id: 'old',
            stockCode: '600001',
            stockName: '旧',
            createdAt: '2026-08-01T00:00:00.000Z',
            rating: 'a',
            totalScore: 1,
            result: {},
          },
          {
            id: 'new',
            stockCode: '600002',
            stockName: '新',
            createdAt: '2026-08-02T00:00:00.000Z',
            rating: 'b',
            totalScore: 2,
            result: {},
          },
        ],
      }),
    );
    const list = await listHistory();
    expect(list.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('同股票代码去重更新（id 保留、createdAt 刷新、不新增条目）', async () => {
    const first = await saveHistoryEntry(makeEntry('600519', { totalScore: 80 }));
    expect(first).not.toBeNull();

    // 再次分析同一代码 → 更新而非新增
    const second = await saveHistoryEntry(
      makeEntry('600519', { totalScore: 95, rating: '优先跟踪' }),
    );

    expect(await listHistory()).toHaveLength(1);
    expect(second!.id).toBe(first!.id);
    const detail = (await getHistoryItem(first!.id))!;
    expect(detail.totalScore).toBe(95);
    expect(detail.rating).toBe('优先跟踪');
  });

  it('详情返回完整 result（可恢复研究报告渲染）', async () => {
    const saved = await saveHistoryEntry(
      makeEntry('300750', {
        result: partial<AnalysisResult>({
          stock_pool: [
            partial<AnalysisResult['stock_pool'][number]>({
              stock_code: '300750',
              stock_name: 'x',
            }),
          ],
        }),
      }),
    );
    const detail = await getHistoryItem(saved!.id);
    expect(detail).not.toBeNull();
    expect((detail!.result as { stock_pool: unknown[] }).stock_pool).toHaveLength(1);
  });

  it('删除条目；不存在时返回 false', async () => {
    const saved = await saveHistoryEntry(makeEntry('600519'));
    expect(await deleteHistoryItem(saved!.id)).toBe(true);
    expect(await getHistoryItem(saved!.id)).toBeNull();
    expect(await deleteHistoryItem('no-such-id')).toBe(false);
  });

  it('getPreviousAnalysis：无记录返回 null；有记录返回上次分析摘要（不含 result）', async () => {
    expect(await getPreviousAnalysis('999999')).toBeNull();

    await saveHistoryEntry(makeEntry('600519', { totalScore: 80, rating: '持续观察' }));
    const prev = await getPreviousAnalysis('600519');
    expect(prev).not.toBeNull();
    expect(prev!.stockCode).toBe('600519');
    expect(prev!.totalScore).toBe(80);
    expect(prev!.rating).toBe('持续观察');
    expect(prev).not.toHaveProperty('result'); // 摘要不携带完整结果
  });

  it('getPreviousAnalysis 在保存前调用 = 上一次分析（记忆闭环语义）', async () => {
    // 第一次分析 → 无上次
    await saveHistoryEntry(makeEntry('600036', { totalScore: 70, rating: '持续观察' }));
    // 第二次分析前读取 → 返回第一次的 70 分
    const prev1 = await getPreviousAnalysis('600036');
    expect(prev1!.totalScore).toBe(70);
    // 保存第二次 → 之后再读返回第二次
    await saveHistoryEntry(makeEntry('600036', { totalScore: 85, rating: '优先跟踪' }));
    const prev2 = await getPreviousAnalysis('600036');
    expect(prev2!.totalScore).toBe(85);
    expect(prev2!.rating).toBe('优先跟踪');
  });

  it('computeVsPrevious：无上次记录返回 null', () => {
    expect(computeVsPrevious({ rating: '优先跟踪', totalScore: 90 }, null)).toBeNull();
  });

  it('computeVsPrevious：计算评分增量与评级变化（round 2 位）', () => {
    const prev: HistorySummary = {
      id: 'x',
      stockCode: '600519',
      stockName: '贵州茅台',
      createdAt: '2026-07-01T08:00:00.000Z',
      rating: '持续观察',
      totalScore: 78.5,
    };
    const vs = computeVsPrevious({ rating: '优先跟踪', totalScore: 85.123 }, prev);
    expect(vs).toEqual({
      previous_date: '2026-07-01',
      previous_rating: '持续观察',
      previous_score: 78.5,
      score_delta: 6.62,
      rating_changed: true,
    });
  });

  it('computeVsPrevious：评分持平且评级未变时标记正确', () => {
    const prev: HistorySummary = {
      id: 'x',
      stockCode: '600519',
      stockName: '贵州茅台',
      createdAt: '2026-07-01T08:00:00.000Z',
      rating: '持续观察',
      totalScore: 80,
    };
    const vs = computeVsPrevious({ rating: '持续观察', totalScore: 80 }, prev);
    expect(vs!.score_delta).toBe(0);
    expect(vs!.rating_changed).toBe(false);
    expect(vs!.previous_date).toBe('2026-07-01'); // createdAt 取日期部分
  });

  it('默认容量为 2000 条（SQLite 下不再受整库解析约束）', () => {
    const original = process.env.HISTORY_MAX_ITEMS;
    try {
      delete process.env.HISTORY_MAX_ITEMS;
      expect(maxHistoryItems()).toBe(DEFAULT_HISTORY_MAX_ITEMS);
      expect(DEFAULT_HISTORY_MAX_ITEMS).toBe(2000);
    } finally {
      if (original === undefined) delete process.env.HISTORY_MAX_ITEMS;
      else process.env.HISTORY_MAX_ITEMS = original;
    }
  });

  it('容量超上限时淘汰最旧记录（保留最新 N 条）', async () => {
    const original = process.env.HISTORY_MAX_ITEMS;
    process.env.HISTORY_MAX_ITEMS = '5';
    try {
      // createdAt 由服务端单调时钟保证严格递增（同毫秒保存也 +1ms），
      // 因此"最早保存 = createdAt 最小 = 必被淘汰"的语义恒定成立
      const first = await saveHistoryEntry(makeEntry('600001'));
      let last: HistoryItem | null = null;
      for (let i = 2; i <= 10; i++) {
        last = await saveHistoryEntry(makeEntry(String(600000 + i)));
      }
      const list = await listHistory(200);
      expect(list).toHaveLength(5);
      expect(list.some((i) => i.id === first!.id)).toBe(false); // 最旧的 600001 被淘汰
      expect(list.some((i) => i.id === last!.id)).toBe(true); // 最新保存的保留
      expect(list[list.length - 1].stockCode).toBe('600006'); // 最旧的保留项精确可断
    } finally {
      if (original === undefined) delete process.env.HISTORY_MAX_ITEMS;
      else process.env.HISTORY_MAX_ITEMS = original;
    }
  });

  it('非法 HISTORY_MAX_ITEMS 回落默认值，不会把历史裁成 0 条', () => {
    const original = process.env.HISTORY_MAX_ITEMS;
    try {
      for (const bad of ['abc', '0', '-5', '1.5', '']) {
        process.env.HISTORY_MAX_ITEMS = bad;
        expect(maxHistoryItems()).toBe(DEFAULT_HISTORY_MAX_ITEMS);
      }
      process.env.HISTORY_MAX_ITEMS = '999999';
      expect(maxHistoryItems()).toBe(HISTORY_MAX_ITEMS_HARD_LIMIT); // 硬上限
    } finally {
      if (original === undefined) delete process.env.HISTORY_MAX_ITEMS;
      else process.env.HISTORY_MAX_ITEMS = original;
    }
  });

  it('快速连续保存 createdAt 严格递增（毫秒级单调时钟）', async () => {
    // 此前 Date.now() 在同一毫秒内返回相同值，createdAt 相同会让淘汰语义
    // 依赖数组稳定序而错误（淘汰后保存的）；此用例锁定单调性
    const a = (await saveHistoryEntry(makeEntry('600001')))!;
    const b = (await saveHistoryEntry(makeEntry('600002')))!;
    const c = (await saveHistoryEntry(makeEntry('600003')))!;
    expect(a.createdAt < b.createdAt).toBe(true);
    expect(b.createdAt < c.createdAt).toBe(true);
  });

  it('数据库文件损坏时安全降级为空历史（不抛错），且可继续写入', async () => {
    await saveHistoryEntry(makeEntry('600001'));
    corruptDb();
    expect(await listHistory()).toEqual([]);
    const saved = await saveHistoryEntry(makeEntry('600519'));
    expect(saved).not.toBeNull();
    expect(await listHistory()).toHaveLength(1);
  });

  it('数据库损坏时改名留档，坏文件内容原样保留（不静默丢全部历史）', async () => {
    corruptDb('raw-damaged-bytes');
    expect(await listHistory()).toEqual([]);

    const backups = readdirSync(tmpDir).filter((f) => f.startsWith('history.db.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tmpDir, backups[0]), 'utf-8')).toBe('raw-damaged-bytes');
  });

  it('数据库损坏且留档失败时拒绝写入，绝不覆盖唯一副本', async () => {
    corruptDb('raw-damaged-bytes');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
    });
    try {
      expect(await listHistory()).toEqual([]);
      // 若照常保存，坏文件（唯一副本）会被清空重建
      expect(await saveHistoryEntry(makeEntry('600519'))).toBeNull();
      expect(readFileSync(dbFile, 'utf-8')).toBe('raw-damaged-bytes');
    } finally {
      spy.mockRestore();
      resetHistoryStoreCache();
    }
  });

  it('数据库不可写时返回 null（不阻断主流程）', async () => {
    // 把数据库路径指向一个目录：SQLite 无法打开，且目录不会被当成文件留档
    process.env.HISTORY_DB_FILE = tmpDir;
    resetHistoryStoreCache();
    try {
      expect(await saveHistoryEntry(makeEntry('600519'))).toBeNull();
      expect(await listHistory()).toEqual([]);
    } finally {
      delete process.env.HISTORY_DB_FILE;
      resetHistoryStoreCache();
    }
  });

  it('关闭并重开后数据仍在（真实持久化，不是内存快照）', async () => {
    await saveHistoryEntry(makeEntry('600519', { totalScore: 88 }));
    closeHistoryStore();
    const list = await listHistory();
    expect(list).toHaveLength(1);
    expect((await getHistoryItem(list[0].id))!.totalScore).toBe(88);
  });

  it('旧 JSON 首次打开时自动迁移进 SQLite，并把原文件留档', async () => {
    seedFile(
      JSON.stringify({
        items: [
          {
            id: 'legacy-1',
            stockCode: '600519',
            stockName: '贵州茅台',
            createdAt: '2026-08-01T00:00:00.000Z',
            rating: '持续观察',
            totalScore: 70,
            result: { stock_pool: [] },
          },
        ],
      }),
    );

    const list = await listHistory();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'legacy-1', stockCode: '600519', totalScore: 70 });
    expect(readdirSync(tmpDir).some((f) => f.startsWith('history.json.migrated-'))).toBe(true);

    // 迁移后的记录继续参与去重/时间线补种
    await saveHistoryEntry(makeEntry('600519', { totalScore: 85 }));
    expect((await listHistory())[0].timeline!.map((p) => p.score)).toEqual([70, 85]);
  });

  it('旧 JSON 损坏时留档后按空库继续，历史文件内容原样保留', async () => {
    seedFile('{ broken legacy json');
    expect(await listHistory()).toEqual([]);

    const backups = readdirSync(tmpDir).filter((f) => f.startsWith('history.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tmpDir, backups[0]), 'utf-8')).toBe('{ broken legacy json');
    // 迁移失败不应影响新库可用性
    expect(await saveHistoryEntry(makeEntry('600519'))).not.toBeNull();
  });

  it('旧 JSON 损坏且留档失败时禁止写入，旧文件不被覆盖', async () => {
    seedFile('{ broken legacy json');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
    });
    try {
      expect(await listHistory()).toEqual([]);
      expect(await saveHistoryEntry(makeEntry('600519'))).toBeNull();
      expect(readFileSync(legacyFile, 'utf-8')).toBe('{ broken legacy json');
    } finally {
      spy.mockRestore();
      resetHistoryStoreCache();
    }
  });

  it('旧 JSON 结构非法（缺 items 数组）按损坏处置，不导入脏数据', async () => {
    seedFile(JSON.stringify({ items: { not: 'an array' } }));
    expect(await listHistory()).toEqual([]);
    expect(readdirSync(tmpDir).some((f) => f.startsWith('history.json.corrupt-'))).toBe(true);
  });

  it('limit 参数钳制在 [1, 200]', async () => {
    for (let i = 1; i <= 5; i++) await saveHistoryEntry(makeEntry(String(600000 + i)));
    expect(await listHistory(0)).toHaveLength(1); // 下限 1
    expect(await listHistory(2)).toHaveLength(2);
  });

  it('写保护期间保存返回 null，恢复后下一次写入仍从已落盘数据继续', async () => {
    await saveHistoryEntry(makeEntry('600519', { totalScore: 80 }));
    // 把数据库路径指向目录 → 打开失败且写保护（不会误删目录）
    process.env.HISTORY_DB_FILE = tmpDir;
    resetHistoryStoreCache();
    expect(await saveHistoryEntry(makeEntry('600519', { totalScore: 90 }))).toBeNull();

    // 恢复真实路径：已落盘的 80 仍在，新保存从它继续累积时间线
    delete process.env.HISTORY_DB_FILE;
    resetHistoryStoreCache();
    await saveHistoryEntry(makeEntry('600519', { totalScore: 95 }));
    const item = (await listHistory())[0]!;
    expect(item.totalScore).toBe(95);
    expect(item.timeline!.map((p) => p.score)).toEqual([80, 95]);
  });

  /* ==========================================================================
   * 评分/评级时间线：去重覆盖后仍能回答"观点怎么变的"
   * ========================================================================*/

  it('首次保存：时间线只有当次一个点', async () => {
    await saveHistoryEntry(makeEntry('600519', { totalScore: 88, rating: '优先跟踪' }));
    const item = (await listHistory())[0];
    expect(item.timeline).toHaveLength(1);
    expect(item.timeline![0]).toMatchObject({ score: 88, rating: '优先跟踪' });
    expect(item.timeline![0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // YYYY-MM-DD
  });

  it('同股票重复保存：时间线按时间累积（由旧到新），最新点即当前评分', async () => {
    await saveHistoryEntry(makeEntry('600519', { totalScore: 80, rating: '持续观察' }));
    await saveHistoryEntry(makeEntry('600519', { totalScore: 87, rating: '优先跟踪' }));
    await saveHistoryEntry(makeEntry('600519', { totalScore: 69, rating: '谨慎观望' }));

    const item = (await listHistory())[0];
    expect(item.totalScore).toBe(69);
    expect(item.timeline!.map((p) => p.score)).toEqual([80, 87, 69]);
    expect(item.timeline!.map((p) => p.rating)).toEqual(['持续观察', '优先跟踪', '谨慎观望']);
    // 时间线在同一个 id / 同一条记录内累积，不新增历史条目
    expect(await listHistory()).toHaveLength(1);
  });

  it('时间线裁剪：只保留最近 MAX_TIMELINE_POINTS 个点（最早的被丢弃）', async () => {
    const total = MAX_TIMELINE_POINTS + 5;
    for (let i = 0; i < total; i++) {
      await saveHistoryEntry(makeEntry('600519', { totalScore: 50 + i }));
    }
    const points = (await listHistory())[0].timeline!;
    expect(points).toHaveLength(MAX_TIMELINE_POINTS);
    // 保留了最后 MAX_TIMELINE_POINTS 次：分数从 55 到 74
    expect(points[0].score).toBe(50 + (total - MAX_TIMELINE_POINTS));
    expect(points[points.length - 1].score).toBe(50 + total - 1);
  });

  it('旧数据兼容：没有 timeline 字段的记录正常列出（不抛、不返回空数组）', async () => {
    seedFile(
      JSON.stringify({
        items: [
          {
            id: 'legacy',
            stockCode: '600519',
            stockName: '贵州茅台',
            createdAt: '2026-08-01T00:00:00.000Z',
            rating: '持续观察',
            totalScore: 70,
            result: {},
            // 故意不带 timeline（升级前落盘的老数据）
          },
        ],
      }),
    );

    const list = await listHistory();
    expect(list).toHaveLength(1);
    expect(list[0].totalScore).toBe(70);
    // 关键：无时间线时字段就是 undefined（不是 []），前端据此不渲染变化量、也不会出现空括号
    expect(list[0].timeline).toBeUndefined();
    expect((await getPreviousAnalysis('600519'))!.timeline).toBeUndefined();
  });

  it('旧数据兼容：老记录首次被更新时自动补种起点，立刻可算出变化', async () => {
    seedFile(
      JSON.stringify({
        items: [
          {
            id: 'legacy',
            stockCode: '600519',
            stockName: '贵州茅台',
            createdAt: '2026-08-01T00:00:00.000Z',
            rating: '持续观察',
            totalScore: 70,
            result: {},
          },
        ],
      }),
    );

    await saveHistoryEntry(makeEntry('600519', { totalScore: 85, rating: '优先跟踪' }));
    const points = (await listHistory())[0].timeline!;
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ date: '2026-08-01', score: 70, rating: '持续观察' });
    expect(points[1]).toMatchObject({ score: 85, rating: '优先跟踪' });
  });

  it('脏时间线被净化：非法点丢弃，非法字段收敛（不炸列表接口）', async () => {
    seedFile(
      JSON.stringify({
        items: [
          {
            id: 'dirty',
            stockCode: '600519',
            stockName: '贵州茅台',
            createdAt: '2026-08-02T00:00:00.000Z',
            rating: '持续观察',
            totalScore: 70,
            result: {},
            timeline: [
              { date: '2026-07-01', score: 60, rating: '持续观察' },
              { date: '2026-07-02', score: 'not-a-number', rating: 'x' },
              { score: 1 },
              null,
            ],
          },
        ],
      }),
    );

    const points = (await listHistory())[0].timeline!;
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({ date: '2026-07-01', score: 60, rating: '持续观察' });
  });

  it('时间线不携带完整 result（列表响应体不膨胀）', async () => {
    await saveHistoryEntry(makeEntry('600519', { totalScore: 80 }));
    await saveHistoryEntry(makeEntry('600519', { totalScore: 90 }));
    const item = (await listHistory())[0];
    expect(item).not.toHaveProperty('result');
    const keys = Object.keys(item.timeline![0]).sort();
    expect(keys).toEqual(['date', 'rating', 'score']);
  });
});

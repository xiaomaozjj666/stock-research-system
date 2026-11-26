/**
 * historyService SQLite 持久层：并发串行、迁移幂等、容量即时裁剪
 * ----------------------------------------------------------------------------
 * 旧实现是「内存 cache + mtime 失效 + 整库 JSON 写回」，这一层测试锁定的是
 * 换成 SQLite 后仍然成立的语义：并发保存不丢更新、同股票并发只留一条、
 * 旧 JSON 只迁移一次、容量上限可即时生效。
 *
 * 数据文件重定向到进程专属临时目录（HISTORY_FILE，数据库落在同目录 .db）。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { partial } from '../../test/partial.js';
import type { AnalysisResult } from '../../types.js';
import {
  closeHistoryStore,
  getHistoryItem,
  listHistory,
  resetHistoryStoreCache,
  saveHistoryEntry,
  trimHistoryToLimit,
  type HistoryEntryInput,
} from '../historyService.js';
import { resetSettingsCache, saveSettings } from '../settings.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'history-sqlite-'));
const legacyFile = join(tmpDir, 'history.json');
const dbFile = join(tmpDir, 'history.db');
const settingsFile = join(tmpDir, 'settings.json');
const origFile = process.env.HISTORY_FILE;
const origDb = process.env.HISTORY_DB_FILE;
const origSettings = process.env.SETTINGS_FILE;

beforeAll(() => {
  process.env.HISTORY_FILE = legacyFile;
  delete process.env.HISTORY_DB_FILE;
  process.env.SETTINGS_FILE = settingsFile;
});

afterAll(() => {
  closeHistoryStore();
  if (origFile === undefined) delete process.env.HISTORY_FILE;
  else process.env.HISTORY_FILE = origFile;
  if (origDb === undefined) delete process.env.HISTORY_DB_FILE;
  else process.env.HISTORY_DB_FILE = origDb;
  if (origSettings === undefined) delete process.env.SETTINGS_FILE;
  else process.env.SETTINGS_FILE = origSettings;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  closeHistoryStore();
  for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, legacyFile, settingsFile]) {
    rmSync(file, { force: true });
  }
  for (const f of readdirSync(tmpDir)) {
    if (f.includes('.corrupt-') || f.includes('.migrated-'))
      rmSync(join(tmpDir, f), { force: true });
  }
  resetHistoryStoreCache();
  resetSettingsCache();
});

function makeEntry(code: string, over: Partial<HistoryEntryInput> = {}): HistoryEntryInput {
  return {
    stockCode: code,
    stockName: `股票${code}`,
    rating: '持续观察',
    totalScore: 60,
    result: partial<AnalysisResult>({
      stock_pool: [partial<AnalysisResult['stock_pool'][number]>({ stock_code: code })],
    }),
    ...over,
  };
}

describe('historyService SQLite 并发与迁移', () => {
  it('并发保存不同股票：全部保留（事务串行，不丢更新）', async () => {
    const codes = Array.from({ length: 20 }, (_, i) => String(600000 + i));
    const results = await Promise.all(
      codes.map((code, i) => saveHistoryEntry(makeEntry(code, { totalScore: 50 + i }))),
    );
    expect(results.every((r) => r !== null)).toBe(true);

    const list = await listHistory(200);
    expect(list).toHaveLength(20);
    expect(new Set(list.map((i) => i.stockCode))).toEqual(new Set(codes));
  });

  it('并发保存同一股票：时间线逐次累积、id 只有一个', async () => {
    const scores = [61, 62, 63, 64, 65];
    const results = await Promise.all(
      scores.map((score) => saveHistoryEntry(makeEntry('600519', { totalScore: score }))),
    );
    const ids = new Set(results.map((r) => r!.id));
    expect(ids.size).toBe(1); // 去重语义在并发下仍成立

    const item = (await listHistory())[0];
    expect(item.timeline).toHaveLength(scores.length);
    expect(item.timeline!.map((p) => p.score)).toEqual(scores); // 串行队列保证按序累积
    expect(item.totalScore).toBe(scores[scores.length - 1]);
  });

  it('并发保存与删除混合：最终状态与串行执行一致', async () => {
    const first = (await saveHistoryEntry(makeEntry('600519')))!;
    await saveHistoryEntry(makeEntry('000001'));

    const [, deleted] = await Promise.all([
      saveHistoryEntry(makeEntry('300750')),
      import('../historyService.js').then(({ deleteHistoryItem }) => deleteHistoryItem(first.id)),
    ]);
    expect(deleted).toBe(true);

    const codes = (await listHistory(200)).map((i) => i.stockCode).sort();
    expect(codes).toEqual(['000001', '300750']);
    expect(await getHistoryItem(first.id)).toBeNull();
  });

  it('旧 JSON 只迁移一次：重启不会重复导入已迁移文件', async () => {
    writeFileSync(
      legacyFile,
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
      'utf-8',
    );
    expect(await listHistory()).toHaveLength(1);
    expect(readdirSync(tmpDir).some((f) => f.startsWith('history.json.migrated-'))).toBe(true);

    // 重启并放一份「新」旧文件到原路径：meta 标记应阻止再次导入
    closeHistoryStore();
    writeFileSync(
      legacyFile,
      JSON.stringify({
        items: [
          {
            id: 'legacy-2',
            stockCode: '000001',
            stockName: '平安银行',
            createdAt: '2026-08-02T00:00:00.000Z',
            rating: '持续观察',
            totalScore: 60,
            result: { stock_pool: [] },
          },
        ],
      }),
      'utf-8',
    );
    resetHistoryStoreCache();
    const list = await listHistory();
    expect(list.map((i) => i.id)).toEqual(['legacy-1']);
  });

  it('trimHistoryToLimit 按当前上限立即裁剪', async () => {
    const original = process.env.HISTORY_MAX_ITEMS;
    try {
      delete process.env.HISTORY_MAX_ITEMS;
      for (let i = 1; i <= 5; i++) await saveHistoryEntry(makeEntry(String(600100 + i)));
      expect(await listHistory(200)).toHaveLength(5);

      process.env.HISTORY_MAX_ITEMS = '2';
      await trimHistoryToLimit();
      const list = await listHistory(200);
      expect(list).toHaveLength(2);
      expect(list.map((i) => i.stockCode)).toEqual(['600105', '600104']);
    } finally {
      if (original === undefined) delete process.env.HISTORY_MAX_ITEMS;
      else process.env.HISTORY_MAX_ITEMS = original;
    }
  });

  it('迁移时按当前容量立即裁剪，旧文件超量不会带进新库', async () => {
    const original = process.env.HISTORY_MAX_ITEMS;
    process.env.HISTORY_MAX_ITEMS = '2';
    try {
      writeFileSync(
        legacyFile,
        JSON.stringify({
          items: [1, 2, 3].map((i) => ({
            id: `legacy-${i}`,
            stockCode: `60000${i}`,
            stockName: `股票${i}`,
            createdAt: `2026-08-0${i}T00:00:00.000Z`,
            rating: '持续观察',
            totalScore: 60 + i,
            result: { stock_pool: [] },
          })),
        }),
        'utf-8',
      );

      const list = await listHistory();
      // 按 createdAt 保留最新 2 条（600003 / 600002）
      expect(list.map((i) => i.stockCode)).toEqual(['600003', '600002']);
    } finally {
      if (original === undefined) delete process.env.HISTORY_MAX_ITEMS;
      else process.env.HISTORY_MAX_ITEMS = original;
    }
  });

  it('迁移跳过结构非法的条目（缺 id / 缺 result / 非对象），仅导入合法记录', async () => {
    writeFileSync(
      legacyFile,
      JSON.stringify({
        items: [
          {
            id: 'legacy-ok',
            stockCode: '600519',
            stockName: '贵州茅台',
            createdAt: '2026-08-01T00:00:00.000Z',
            rating: '持续观察',
            totalScore: 70,
            result: { stock_pool: [] },
          },
          { stockCode: '600001', createdAt: '2026-08-01T00:00:00.000Z', result: {} }, // 缺 id
          { id: 'no-result', stockCode: '600002', createdAt: '2026-08-01T00:00:00.000Z' },
          null,
          'not-an-object',
        ],
      }),
      'utf-8',
    );

    const list = await listHistory();
    expect(list.map((i) => i.id)).toEqual(['legacy-ok']);
    // 非法条目被跳过后仍可正常写入
    expect(await saveHistoryEntry(makeEntry('600001'))).not.toBeNull();
    expect(await listHistory()).toHaveLength(2);
  });

  it('详情内容损坏时返回 null，但列表仍能看到该条（不整库失败）', async () => {
    const saved = (await saveHistoryEntry(makeEntry('600519')))!;
    closeHistoryStore();

    // 绕过服务直接改坏 result_json，模拟磁盘/外部写入损坏
    const external = new DatabaseSync(dbFile);
    try {
      external
        .prepare('UPDATE history_items SET result_json = ? WHERE id = ?')
        .run('{ broken json', saved.id);
    } finally {
      external.close();
    }
    resetHistoryStoreCache();

    const list = await listHistory();
    expect(list).toHaveLength(1);
    expect(await getHistoryItem(saved.id)).toBeNull();
  });

  it('设置页容量优先于环境变量（同一套上限语义）', async () => {
    const original = process.env.HISTORY_MAX_ITEMS;
    process.env.HISTORY_MAX_ITEMS = '5';
    try {
      expect(saveSettings({ historyMaxItems: 2 })).toEqual({ ok: true });
      for (let i = 1; i <= 4; i++) await saveHistoryEntry(makeEntry(String(600200 + i)));
      // 设置页 2 覆盖环境变量 5
      expect((await listHistory(200)).map((i) => i.stockCode)).toEqual(['600204', '600203']);
    } finally {
      if (original === undefined) delete process.env.HISTORY_MAX_ITEMS;
      else process.env.HISTORY_MAX_ITEMS = original;
    }
  });

  it('数据库父级路径不是目录时读为空、写返回 null（不抛错）', async () => {
    const blocker = join(tmpDir, 'blocker');
    writeFileSync(blocker, 'x', 'utf-8');
    process.env.HISTORY_DB_FILE = join(blocker, 'nested', 'history.db');
    resetHistoryStoreCache();
    try {
      expect(await listHistory()).toEqual([]);
      expect(await saveHistoryEntry(makeEntry('600519'))).toBeNull();
    } finally {
      delete process.env.HISTORY_DB_FILE;
      resetHistoryStoreCache();
      rmSync(blocker, { force: true });
    }
  });

  it('写保护状态下 trimHistoryToLimit 静默返回（不抛错）', async () => {
    process.env.HISTORY_DB_FILE = tmpDir; // 目录：打开失败 → 写保护
    resetHistoryStoreCache();
    try {
      await expect(trimHistoryToLimit()).resolves.toBeUndefined();
    } finally {
      delete process.env.HISTORY_DB_FILE;
      resetHistoryStoreCache();
    }
  });
});

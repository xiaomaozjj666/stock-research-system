/**
 * historyService 内存 store：只读一次 / 写一次 + mtime 失效 + 并发串行化
 * ----------------------------------------------------------------------------
 * 背景：此前分析收尾先 getPreviousAnalysis()（读一次）再 saveHistoryEntry()（内部再读
 * 一次 + 整份同步写回），历史库满额（100 条 ≈ 14.7MB）时单次 JSON.parse ≈ 38ms，
 * 每次收尾白阻塞事件循环 0.14–0.18s（SSE 长连接下全体请求一起等）。
 * 现在：全部 fs 操作走 node:fs/promises；读走模块级内存 store（命中时只做一次异步
 * stat 校验 mtime），写后更新缓存；「读-改-写」经串行队列，并发保存不丢更新。
 *
 * 「只读一次」的断言方式：spy fsp.readFile 计数——命中内存 store 时 readFile 调用
 * 数为 0（不再依赖"删掉文件后仍命中"的旧手法：mtime 失效语义下，外部删除文件
 * 本来就应该触发重读）。
 * 数据文件一律经 HISTORY_FILE 重定向到进程专属临时目录，不碰 server/src/data/。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { partial } from '../../test/partial.js';
import type { AnalysisResult } from '../../types.js';
import {
  deleteHistoryItem,
  getHistoryItem,
  getPreviousAnalysis,
  listHistory,
  readHistoryStore,
  resetHistoryStoreCache,
  saveHistoryEntry,
  type HistoryEntryInput,
} from '../historyService.js';

// 展开成普通对象以便 spyOn（同 historyService.test.ts 的说明）
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual };
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-cache-'));
const historyFile = path.join(tmpDir, 'history.json');
const origFile = process.env.HISTORY_FILE;

beforeAll(() => {
  process.env.HISTORY_FILE = historyFile;
});

afterAll(() => {
  if (origFile === undefined) delete process.env.HISTORY_FILE;
  else process.env.HISTORY_FILE = origFile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(historyFile, { force: true });
  fs.rmSync(`${historyFile}.tmp`, { force: true });
  resetHistoryStoreCache();
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

describe('historyService 内存 store（只读一次 / 写一次）', () => {
  it('收尾链路（getPreviousAnalysis → saveHistoryEntry）在首次读盘后不再读文件', async () => {
    await saveHistoryEntry(makeEntry('600519', { totalScore: 80 }));
    expect(fs.existsSync(historyFile)).toBe(true);

    // 缓存已建立：后续读只做 mtime 校验（stat），不得再 readFile 全量解析
    const readSpy = vi.spyOn(fsp, 'readFile');
    readSpy.mockClear();
    try {
      const prev = await getPreviousAnalysis('600519');
      expect(prev).not.toBeNull();
      expect(prev!.totalScore).toBe(80);

      // 同一请求紧随其后的保存：复用内存 store，时间线能在旧记录上累积
      const saved = await saveHistoryEntry(makeEntry('600519', { totalScore: 90 }));
      expect(saved).not.toBeNull();
      expect(saved!.timeline!.map((p) => p.score)).toEqual([80, 90]);
      expect(readSpy).not.toHaveBeenCalled(); // 整条链路 0 次全量读盘
    } finally {
      readSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(historyFile, 'utf-8')).items).toHaveLength(1);
  });

  it('readHistoryStore() + saveHistoryEntry(input, store)：显式复用同一份快照', async () => {
    const first = (await saveHistoryEntry(makeEntry('600519', { totalScore: 70 })))!;

    const store = await readHistoryStore();
    expect(store.items).toHaveLength(1);
    expect(store.items[0].id).toBe(first.id);

    // 外部把落盘文件改成空库（模拟"服务若再读一次就会拿到旧/空内容"）
    fs.writeFileSync(historyFile, JSON.stringify({ items: [] }), 'utf-8');

    const saved = await saveHistoryEntry(makeEntry('600519', { totalScore: 75 }), store);
    expect(saved).not.toBeNull();
    expect(saved!.id).toBe(first.id); // 复用快照：去重命中同一记录，id 保留
    expect(saved!.timeline!.map((p) => p.score)).toEqual([70, 75]);
    expect(JSON.parse(fs.readFileSync(historyFile, 'utf-8')).items).toHaveLength(1);
  });

  it('删除条目也走内存 store（不读盘）', async () => {
    const saved = (await saveHistoryEntry(makeEntry('600519')))!;
    const readSpy = vi.spyOn(fsp, 'readFile');
    readSpy.mockClear();
    try {
      expect(await deleteHistoryItem(saved.id)).toBe(true);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(historyFile, 'utf-8')).items).toEqual([]);
  });

  it('mtime 失效：外部改写落盘文件后自动重读（无需手动 reset）', async () => {
    await saveHistoryEntry(makeEntry('600519'));
    expect(await listHistory()).toHaveLength(1);

    // 外部改写为空库，并把 mtime 显式拨到未来，保证与缓存记录不同
    fs.writeFileSync(historyFile, JSON.stringify({ items: [] }), 'utf-8');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(historyFile, future, future);

    expect(await listHistory()).toHaveLength(0); // mtime 变化 → 缓存自动失效重读
  });

  it('mtime 失效：外部删除落盘文件后重读为空历史（不抛错）', async () => {
    await saveHistoryEntry(makeEntry('600519'));
    fs.rmSync(historyFile);
    expect(await listHistory()).toEqual([]);
    // 重读得到 ENOENT 空库后可继续正常写入
    await saveHistoryEntry(makeEntry('000001'));
    expect((await listHistory()).map((i) => i.stockCode)).toEqual(['000001']);
  });

  it('resetHistoryStoreCache()：外部改写但 mtime 被刻意保持时仍可强制重读', async () => {
    await saveHistoryEntry(makeEntry('600519'));
    // 外部改写为空库，但 stat 被"刻意保持"为缓存建立时的 mtime（用 spy 精确模拟，
    // 避免依赖文件系统 mtime 的浮点精度——utimes 只能恢复到毫秒级）。
    // 此时 mtime 校验通过、缓存命中，只有显式 reset 才能强制重读。
    const pinnedMtimeMs = fs.statSync(historyFile).mtimeMs;
    fs.writeFileSync(historyFile, JSON.stringify({ items: [] }), 'utf-8');
    const realStat = fsp.stat;
    const statSpy = vi.spyOn(fsp, 'stat').mockImplementation((async (
      p: Parameters<typeof fsp.stat>[0],
    ) => {
      const st = await realStat(p);
      return { ...st, mtimeMs: pinnedMtimeMs };
    }) as unknown as typeof fsp.stat);
    try {
      expect(await listHistory()).toHaveLength(1); // mtime 未变：缓存有效
      resetHistoryStoreCache();
      expect(await listHistory()).toHaveLength(0); // 强制重读后外部改动可见
    } finally {
      statSpy.mockRestore();
    }
  });

  it('写盘失败后内存为权威：换回正常路径前不回滚、不读旧盘', async () => {
    await saveHistoryEntry(makeEntry('600519', { totalScore: 60 }));

    // 把 HISTORY_FILE 指向目录：写入必然失败
    process.env.HISTORY_FILE = tmpDir;
    expect(await saveHistoryEntry(makeEntry('000001'))).toBeNull();
    process.env.HISTORY_FILE = historyFile;

    // 落盘内容仍是失败前的那一条（路径换回后缓存 key 不匹配，从磁盘重建）
    const list = await listHistory();
    expect(list.map((i) => i.stockCode)).toEqual(['600519']);
    expect(list[0].totalScore).toBe(60);
  });

  it('getHistoryItem 命中缓存（不再全量读盘即可回看报告）', async () => {
    const saved = await saveHistoryEntry(makeEntry('300750'));
    const readSpy = vi.spyOn(fsp, 'readFile');
    readSpy.mockClear();
    try {
      const detail = await getHistoryItem(saved!.id);
      expect(detail).not.toBeNull();
      expect(detail!.stockCode).toBe('300750');
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });
});

describe('historyService 并发与串行化', () => {
  it('并发保存不同股票：全部保留（读-改-写串行，不丢更新）', async () => {
    const codes = Array.from({ length: 20 }, (_, i) => String(600000 + i));
    const results = await Promise.all(
      codes.map((code, i) => saveHistoryEntry(makeEntry(code, { totalScore: 50 + i }))),
    );
    expect(results.every((r) => r !== null)).toBe(true);

    const list = await listHistory(200);
    expect(list).toHaveLength(20);
    expect(new Set(list.map((i) => i.stockCode))).toEqual(new Set(codes));
    // 落盘内容与内存一致：没有因交错写回而丢条目
    const onDisk = JSON.parse(fs.readFileSync(historyFile, 'utf-8')).items;
    expect(onDisk).toHaveLength(20);
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
      deleteHistoryItem(first.id),
    ]);
    expect(deleted).toBe(true);

    const codes = (await listHistory(200)).map((i) => i.stockCode).sort();
    expect(codes).toEqual(['000001', '300750']);
    expect(await getHistoryItem(first.id)).toBeNull();
  });
});

/**
 * historyService 内存 store：同一请求只读一次、写一次
 * ----------------------------------------------------------------------------
 * 背景：此前分析收尾先 getPreviousAnalysis()（读一次）再 saveHistoryEntry()（内部再读
 * 一次 + 整份同步写回），历史库满额（100 条 ≈ 14.7MB）时单次 JSON.parse ≈ 38ms，
 * 每次收尾白阻塞事件循环 0.14–0.18s（SSE 长连接下全体请求一起等）。
 * 现在读走模块级内存 store，写后更新缓存。
 *
 * 「只读一次」的断言方式：首次读盘后把落盘文件删掉/改成空库——若实现仍然每次读盘，
 * 就会读到空历史而断言失败；命中内存 store 则不受影响。
 * 数据文件一律经 HISTORY_FILE 重定向到进程专属临时目录，不碰 server/src/data/。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveHistoryEntry,
  listHistory,
  getHistoryItem,
  deleteHistoryItem,
  getPreviousAnalysis,
  readHistoryStore,
  resetHistoryStoreCache,
  type HistoryEntryInput,
} from '../historyService.js';

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
    result: { stock_pool: [{ stock_code: code }] } as never,
    ...over,
  };
}

describe('historyService 内存 store（只读一次 / 写一次）', () => {
  it('收尾链路（getPreviousAnalysis → saveHistoryEntry）在首次读盘后不再读文件', () => {
    saveHistoryEntry(makeEntry('600519', { totalScore: 80 }));
    expect(fs.existsSync(historyFile)).toBe(true);

    // 落盘文件消失：任何一次"再读一遍"都只能读到空历史
    fs.rmSync(historyFile);

    const prev = getPreviousAnalysis('600519');
    expect(prev).not.toBeNull();
    expect(prev!.totalScore).toBe(80);

    // 同一请求紧随其后的保存：复用内存 store，时间线能在旧记录上累积
    const saved = saveHistoryEntry(makeEntry('600519', { totalScore: 90 }));
    expect(saved).not.toBeNull();
    expect(saved!.timeline!.map((p) => p.score)).toEqual([80, 90]);
    expect(JSON.parse(fs.readFileSync(historyFile, 'utf-8')).items).toHaveLength(1);
  });

  it('readHistoryStore() + saveHistoryEntry(input, store)：显式复用同一份快照', () => {
    const first = saveHistoryEntry(makeEntry('600519', { totalScore: 70 }))!;

    const store = readHistoryStore();
    expect(store.items).toHaveLength(1);
    expect(store.items[0].id).toBe(first.id);

    // 外部把落盘文件改成空库（模拟"服务若再读一次就会拿到旧/空内容"）
    fs.writeFileSync(historyFile, JSON.stringify({ items: [] }), 'utf-8');

    const saved = saveHistoryEntry(makeEntry('600519', { totalScore: 75 }), store);
    expect(saved).not.toBeNull();
    expect(saved!.id).toBe(first.id); // 复用快照：去重命中同一记录，id 保留
    expect(saved!.timeline!.map((p) => p.score)).toEqual([70, 75]);
    expect(JSON.parse(fs.readFileSync(historyFile, 'utf-8')).items).toHaveLength(1);
  });

  it('删除条目也走内存 store（不读盘）', () => {
    const saved = saveHistoryEntry(makeEntry('600519'))!;
    fs.rmSync(historyFile); // 再读盘只会得到空库
    expect(deleteHistoryItem(saved.id)).toBe(true);
    expect(JSON.parse(fs.readFileSync(historyFile, 'utf-8')).items).toEqual([]);
  });

  it('resetHistoryStoreCache()：外部改写落盘文件后可强制重读', () => {
    saveHistoryEntry(makeEntry('600519'));
    fs.writeFileSync(historyFile, JSON.stringify({ items: [] }), 'utf-8');
    expect(listHistory()).toHaveLength(1); // 缓存仍有效：不读盘

    resetHistoryStoreCache();
    expect(listHistory()).toHaveLength(0); // 重置后重新读盘，外部改动可见
  });

  it('写盘失败时清空缓存：下次读盘重建，不会拿着失败状态继续跑', () => {
    saveHistoryEntry(makeEntry('600519', { totalScore: 60 }));

    // 把 HISTORY_FILE 指向目录：写入必然失败
    process.env.HISTORY_FILE = tmpDir;
    expect(saveHistoryEntry(makeEntry('000001'))).toBeNull();
    process.env.HISTORY_FILE = historyFile;

    // 落盘内容仍是失败前的那一条（缓存已失效后从磁盘重建）
    const list = listHistory();
    expect(list.map((i) => i.stockCode)).toEqual(['600519']);
    expect(list[0].totalScore).toBe(60);
  });

  it('getHistoryItem 命中缓存（文件被外部删除也能回看已缓存的报告）', () => {
    const saved = saveHistoryEntry(makeEntry('300750'));
    fs.rmSync(historyFile);
    const detail = getHistoryItem(saved!.id);
    expect(detail).not.toBeNull();
    expect(detail!.stockCode).toBe('300750');
  });
});

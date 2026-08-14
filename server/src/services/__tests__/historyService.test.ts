import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveHistoryEntry,
  listHistory,
  getHistoryItem,
  deleteHistoryItem,
  MAX_HISTORY_ITEMS,
  type HistoryEntryInput,
  type HistoryItem,
} from '../historyService.js';

// 落盘重定向到进程专属临时文件（HISTORY_FILE env，与 watchlist/paper/audit 同模式）
const tmpDir = mkdtempSync(join(tmpdir(), 'history-svc-'));
const tmpFile = join(tmpDir, 'history.json');
const origFile = process.env.HISTORY_FILE;

beforeAll(() => {
  process.env.HISTORY_FILE = tmpFile;
});
afterAll(() => {
  if (origFile === undefined) delete process.env.HISTORY_FILE;
  else process.env.HISTORY_FILE = origFile;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(code: string, over: Partial<HistoryEntryInput> = {}): HistoryEntryInput {
  return {
    stockCode: code,
    stockName: `股票${code}`,
    industry: '白酒',
    rating: '持续观察',
    totalScore: 60,
    result: { stock_pool: [{ stock_code: code }] } as never,
    ...over,
  };
}

describe('historyService 研究历史', () => {
  beforeEach(() => {
    // 每个用例从空历史开始（直接重建文件）
    writeFileSync(tmpFile, JSON.stringify({ items: [] }), 'utf-8');
  });

  it('保存新增条目，列表返回摘要（不含 result）', () => {
    saveHistoryEntry(makeEntry('600519', { totalScore: 88 }));
    saveHistoryEntry(makeEntry('000001', { totalScore: 55 }));

    const list = listHistory();
    expect(list).toHaveLength(2);
    // 注意：快速连续保存可能落在同一毫秒（createdAt 相同），此时排序是稳定序，
    // 顺序断言不可靠——这里只断言内容，排序语义由下方 fixture 用例验证
    const byCode = Object.fromEntries(list.map((i) => [i.stockCode, i]));
    expect(byCode['600519'].totalScore).toBe(88);
    expect(byCode['600519'].rating).toBe('持续观察');
    expect(byCode['000001'].totalScore).toBe(55);
    expect(list[0]).not.toHaveProperty('result'); // 列表瘦身（不含完整 result）
  });

  it('列表按 createdAt 倒序（最新在前）', () => {
    // 用明确 createdAt 的 fixture 验证排序，不依赖 saveHistoryEntry 的毫秒精度
    writeFileSync(
      tmpFile,
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
      'utf-8',
    );
    const list = listHistory();
    expect(list.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('同股票代码去重更新（id 保留、createdAt 刷新、不新增条目）', () => {
    const first = saveHistoryEntry(makeEntry('600519', { totalScore: 80 }));
    expect(first).not.toBeNull();

    // 再次分析同一代码 → 更新而非新增
    const second = saveHistoryEntry(makeEntry('600519', { totalScore: 95, rating: '优先跟踪' }));

    expect(listHistory()).toHaveLength(1);
    expect(second!.id).toBe(first!.id);
    const detail = getHistoryItem(first!.id)!;
    expect(detail.totalScore).toBe(95);
    expect(detail.rating).toBe('优先跟踪');
  });

  it('详情返回完整 result（可恢复研究报告渲染）', () => {
    const saved = saveHistoryEntry(
      makeEntry('300750', {
        result: { stock_pool: [{ stock_code: '300750', name: 'x' }] } as never,
      }),
    );
    const detail = getHistoryItem(saved!.id);
    expect(detail).not.toBeNull();
    expect((detail!.result as { stock_pool: unknown[] }).stock_pool).toHaveLength(1);
  });

  it('删除条目；不存在时返回 false', () => {
    const saved = saveHistoryEntry(makeEntry('600519'));
    expect(deleteHistoryItem(saved!.id)).toBe(true);
    expect(getHistoryItem(saved!.id)).toBeNull();
    expect(deleteHistoryItem('no-such-id')).toBe(false);
  });

  it('容量超上限时淘汰最旧记录（保留最新 MAX_HISTORY_ITEMS 条）', () => {
    // createdAt 由服务端单调时钟保证严格递增（同毫秒保存也 +1ms），
    // 因此"最早保存 = createdAt 最小 = 必被淘汰"的语义恒定成立
    const first = saveHistoryEntry(makeEntry('600001'));
    let last: HistoryItem | null = null;
    for (let i = 2; i <= MAX_HISTORY_ITEMS + 5; i++) {
      last = saveHistoryEntry(makeEntry(String(600000 + i)));
    }
    const list = listHistory(200);
    expect(list).toHaveLength(MAX_HISTORY_ITEMS);
    expect(list.some((i) => i.id === first!.id)).toBe(false); // 最旧的 600001 被淘汰
    expect(list.some((i) => i.id === last!.id)).toBe(true); // 最新保存的保留
    expect(list[list.length - 1].stockCode).toBe('600006'); // 最旧的保留项精确可断
  });

  it('快速连续保存 createdAt 严格递增（毫秒级单调时钟）', () => {
    // 此前 Date.now() 在同一毫秒内返回相同值，createdAt 相同会让淘汰语义
    // 依赖数组稳定序而错误（淘汰后保存的）；此用例锁定单调性
    const a = saveHistoryEntry(makeEntry('600001'))!;
    const b = saveHistoryEntry(makeEntry('600002'))!;
    const c = saveHistoryEntry(makeEntry('600003'))!;
    expect(a.createdAt < b.createdAt).toBe(true);
    expect(b.createdAt < c.createdAt).toBe(true);
  });

  it('文件损坏时安全降级为空历史（不抛错）', () => {
    writeFileSync(tmpFile, '{ not valid json', 'utf-8');
    expect(listHistory()).toEqual([]);
    // 损坏后仍可正常写入新条目
    const saved = saveHistoryEntry(makeEntry('600519'));
    expect(saved).not.toBeNull();
    expect(listHistory()).toHaveLength(1);
  });

  it('写盘失败时返回 null（不阻断主流程）', () => {
    // 把 HISTORY_FILE 指向一个目录路径，写文件必然失败
    process.env.HISTORY_FILE = tmpDir;
    const r = saveHistoryEntry(makeEntry('600519'));
    expect(r).toBeNull();
    process.env.HISTORY_FILE = tmpFile;
  });

  it('limit 参数钳制在 [1, 200]', () => {
    for (let i = 1; i <= 5; i++) saveHistoryEntry(makeEntry(String(600000 + i)));
    expect(listHistory(0)).toHaveLength(1); // 下限 1
    expect(listHistory(2)).toHaveLength(2);
  });
});

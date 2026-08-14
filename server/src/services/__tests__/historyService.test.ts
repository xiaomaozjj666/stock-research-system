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

  it('保存新增条目，列表倒序返回摘要（不含 result）', () => {
    saveHistoryEntry(makeEntry('600519', { totalScore: 88 }));
    saveHistoryEntry(makeEntry('000001', { totalScore: 55 }));

    const list = listHistory();
    expect(list.map((i) => i.stockCode)).toEqual(['000001', '600519']); // 后保存的在最前
    expect(list[0]).not.toHaveProperty('result'); // 列表瘦身
    expect(list[0].totalScore).toBe(55);
    expect(list[0].rating).toBe('持续观察');
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
    // 断言不依赖毫秒时间戳分布（同毫秒条目靠稳定排序保持保存序）：
    // 最早保存的必被淘汰、最晚保存的必保留、总数恒为上限
    const first = saveHistoryEntry(makeEntry('600001'));
    let last: HistoryItem | null = null;
    for (let i = 2; i <= MAX_HISTORY_ITEMS + 5; i++) {
      last = saveHistoryEntry(makeEntry(String(600000 + i)));
    }
    const list = listHistory(200);
    expect(list).toHaveLength(MAX_HISTORY_ITEMS);
    expect(list.some((i) => i.id === first!.id)).toBe(false); // 最旧的 600001 被淘汰
    expect(list.some((i) => i.id === last!.id)).toBe(true); // 最新保存的保留
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

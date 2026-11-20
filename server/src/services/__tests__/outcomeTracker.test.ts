import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordAnalysis,
  evaluateOutcomes,
  getRatingAccuracy,
  formatAccuracyHint,
  judgeHit,
  type OutcomeRecord,
} from '../outcomeTracker.js';
import type { OHLCVData } from '../../quant/types.js';

// 行情数据源打桩：
//  - 个股区间：默认 [100, 120]（建仓复权收盘 100 → 退出 120 = +20%）
//  - 基准区间：默认 [100, 110]（+10%）→ 超额 +10%
//  - 基准必须走 secid（1.000300），由 benchMock 单独记录并断言
let simulated = false;
/** 个股取数收到的 signal（fetchOHLCVData 第 4 参） */
const stockSignals: (AbortSignal | undefined)[] = [];
/** 基准取数收到的参数（fetchKlineBySecid: secid, start, end, token, timeout, signal） */
const benchCalls: { secid: string; signal: AbortSignal | undefined }[] = [];

/**
 * K 线桩工厂：字段按 OHLCVData 补全。
 *
 * date 默认取**今天**——退出价有陈旧度守卫（>5 自然日视为补拉失败、留待下次），
 * 固定日期会在测试运行数日后集体跳过评估，制造莫名其妙的红。
 */
function barOf(close: number, opts: { isSimulated?: boolean; date?: string } = {}): OHLCVData {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    ...(opts.isSimulated ? { isSimulated: true } : {}),
  };
}

/** 个股区间桩（可被用例覆盖）；返回 [建仓, 退出] 两根 */
const stockMock = vi.fn(async (_code: string) => [
  barOf(100, { isSimulated: simulated }),
  barOf(120, { isSimulated: simulated }),
]);
/** 基准区间桩 */
const benchMock = vi.fn(async (_secid: string) => [barOf(100), barOf(110)]);

vi.mock('../../quant/dataProvider.js', () => ({
  // vi.mock 工厂被提升：工厂体自身不引用顶层 const，只在返回的函数内部取值（TDZ 安全）
  A_SHARE_BENCHMARK_SECID: '1.000300',
  fetchOHLCVData: (...args: unknown[]) => {
    stockSignals.push(args[3] as AbortSignal | undefined);
    return stockMock(args[0] as string);
  },
  fetchKlineBySecid: (...args: unknown[]) => {
    benchCalls.push({
      secid: args[0] as string,
      signal: args[5] as AbortSignal | undefined,
    });
    return benchMock(args[0] as string);
  },
}));

const tmpDir = mkdtempSync(join(tmpdir(), 'outcome-'));
const tmpFile = join(tmpDir, 'outcomes.json');
const origFile = process.env.OUTCOME_FILE;

beforeEach(() => {
  process.env.OUTCOME_FILE = tmpFile;
  simulated = false;
  stockMock.mockClear();
  benchMock.mockClear();
  stockMock.mockImplementation(async () => [
    barOf(100, { isSimulated: simulated }),
    barOf(120, { isSimulated: simulated }),
  ]);
  benchMock.mockImplementation(async () => [barOf(100), barOf(110)]);
  stockSignals.length = 0;
  benchCalls.length = 0;
  writeFileSync(tmpFile, JSON.stringify({ items: [] }));
});

afterAll(() => {
  if (origFile === undefined) delete process.env.OUTCOME_FILE;
  else process.env.OUTCOME_FILE = origFile;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
});

/** 直接写入台账，便于构造"已评估"或"已到期"的历史样本 */
function seed(records: Partial<OutcomeRecord>[]): void {
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
  writeFileSync(
    tmpFile,
    JSON.stringify({
      items: records.map((r, i) => ({
        id: `seed-${i}`,
        stockCode: '600519',
        rating: '持续观察',
        totalScore: 60,
        entryPrice: 100,
        createdAt: daysAgo(40),
        ...r,
      })),
    }),
  );
}

function readItems(): OutcomeRecord[] {
  return (JSON.parse(readFileSync(tmpFile, 'utf-8')) as { items: OutcomeRecord[] }).items;
}

describe('outcomeTracker 决策-结果闭环', () => {
  describe('judgeHit 评级方向判定', () => {
    it('看多评级在上涨时命中、下跌时未命中', () => {
      expect(judgeHit('优先跟踪', 5)).toBe(true);
      expect(judgeHit('持续观察', -5)).toBe(false);
    });

    it('看空评级在下跌/走平时命中、上涨时未命中', () => {
      expect(judgeHit('建议规避', -5)).toBe(true);
      expect(judgeHit('建议规避', 0)).toBe(true);
      expect(judgeHit('建议规避', 5)).toBe(false);
    });

    it('中性评级（谨慎观望）不参与命中判定', () => {
      expect(judgeHit('谨慎观望', 20)).toBeNull();
      expect(judgeHit('谨慎观望', -20)).toBeNull();
    });
  });

  describe('recordAnalysis 台账登记', () => {
    it('有效价格时登记一条待评估记录（未到期，暂不计入统计）', () => {
      recordAnalysis({ stockCode: '600519', rating: '持续观察', totalScore: 60, entryPrice: 100 });
      const raw = JSON.parse(readFileSync(tmpFile, 'utf-8')) as { items: OutcomeRecord[] };
      expect(raw.items).toHaveLength(1);
      expect(raw.items[0].evaluatedAt).toBeUndefined();
      expect(raw.items[0].entryPrice).toBe(100);
      expect(getRatingAccuracy('600519').stock.sampleCount).toBe(0);
    });

    it('价格无效（0 或负）时不登记，避免产生无法校准的脏数据', async () => {
      recordAnalysis({ stockCode: '600519', rating: '持续观察', totalScore: 60, entryPrice: 0 });
      // 无待评估记录 → 回填返回 0
      expect(await evaluateOutcomes(3)).toBe(0);
    });

    it('台账文件损坏 → 改名留档、按空台账继续（不静默覆盖清零）', async () => {
      writeFileSync(tmpFile, '{ 半截 JSON');
      recordAnalysis({ stockCode: '600519', rating: '持续观察', totalScore: 60, entryPrice: 100 });
      // 损坏文件被改名留档（同目录出现 .corrupt- 前缀文件），原文件重建为新台账
      const corrupt = readdirSync(tmpDir).filter((f) => f.includes('.corrupt-'));
      expect(corrupt.length).toBe(1);
      expect(readItems()).toHaveLength(1); // 新台账可用
    });
  });

  describe('evaluateOutcomes 结果回填', () => {
    it('到期记录回填实际收益与超额收益', async () => {
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 100 }]);
      const done = await evaluateOutcomes(3);
      expect(done).toBe(1);

      const { stock } = getRatingAccuracy('600519');
      expect(stock.sampleCount).toBe(1);
      expect(stock.judgedCount).toBe(1);
      expect(stock.hitCount).toBe(1); // 看多且 +20% → 命中
      expect(stock.avgReturnPct).toBe(20);
      // 超额收益：+20% − 基准 +10% = +10%
      expect(readItems()[0].excessPct).toBe(10);
    });

    it('基准走 secid（1.000300）而非代码 000300——否则上游返回空、超额恒为 null', async () => {
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 100 }]);
      await evaluateOutcomes(3);
      expect(benchCalls).toHaveLength(1);
      expect(benchCalls[0].secid).toBe('1.000300');
    });

    it('建仓价取区间首根复权收盘价（快照 entryPrice 是未复权价，不参与收益计算）', async () => {
      // 快照价故意写成离谱的 999（模拟未复权/脏值）：收益仍应按 bars [100→120] = +20%
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 999 }]);
      await evaluateOutcomes(3);
      const item = readItems()[0];
      expect(item.returnPct).toBe(20);
      expect(item.entryAdjClose).toBe(100);
    });

    it('退出价陈旧（补拉失败、缓存尾部 >5 天）→ 不落盘评估，留待下次', async () => {
      const staleDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      stockMock.mockImplementation(async () => [
        barOf(100, { date: staleDate }),
        barOf(120, { date: staleDate }),
      ]);
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 100 }]);
      expect(await evaluateOutcomes(3)).toBe(0);
      expect(readItems()[0].evaluatedAt).toBeUndefined();
    });

    it('行情为模拟数据时不回填（合成价格不得污染校准）', async () => {
      simulated = true;
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 100 }]);
      expect(await evaluateOutcomes(3)).toBe(0);
      expect(getRatingAccuracy('600519').stock.sampleCount).toBe(0);
    });

    it('未到期记录暂不评估', async () => {
      seed([
        {
          stockCode: '600519',
          rating: '优先跟踪',
          entryPrice: 100,
          createdAt: new Date().toISOString(),
        },
      ]);
      expect(await evaluateOutcomes(3)).toBe(0);
    });

    it('signal 透传到个股与基准两路取数，取消可级联到 socket 级', async () => {
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 100 }]);
      const ac = new AbortController();

      await evaluateOutcomes(3, ac.signal);

      expect(stockSignals.length).toBeGreaterThan(0);
      expect(stockSignals.every((s) => s === ac.signal)).toBe(true);
      expect(benchCalls.length).toBeGreaterThan(0);
      expect(benchCalls.every((c) => c.signal === ac.signal)).toBe(true);
    });

    it('取数期间被取消：不再为剩余条目取数（已完成条目照常落盘，回填幂等）', async () => {
      seed([
        { stockCode: '600519', rating: '优先跟踪', entryPrice: 100 },
        { stockCode: '000001', rating: '优先跟踪', entryPrice: 100 },
      ]);
      const ac = new AbortController();
      // 模拟「上层 8s 限时到点」：取消信号置位后取数立即失败
      stockMock.mockImplementation(async () => {
        ac.abort(new Error('timeout: 8000ms 未完成'));
        throw ac.signal.reason;
      });
      benchMock.mockImplementation(async () => {
        // 基准与个股并发取数：同样感知取消
        throw ac.signal.reason;
      });

      await evaluateOutcomes(3, ac.signal);

      // 第 1 条的两路来源各打一次后即收手；不取消的话第 2 条还会再打两路
      expect(stockSignals.length).toBe(1);
      expect(benchCalls.length).toBe(1);
    });

    it('调用前就已取消：一条都不取数', async () => {
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 100 }]);
      const ac = new AbortController();
      ac.abort();

      expect(await evaluateOutcomes(3, ac.signal)).toBe(0);
      expect(stockSignals.length).toBe(0);
      expect(benchCalls.length).toBe(0);
    });
  });

  describe('getRatingAccuracy / formatAccuracyHint 命中率统计', () => {
    it('样本不足 3 条时不给出命中率（避免小样本误导）', () => {
      seed([{ hit: true, returnPct: 10, evaluatedAt: new Date().toISOString() }]);
      const { stock } = getRatingAccuracy('600519');
      expect(stock.judgedCount).toBe(1);
      expect(stock.accuracyPct).toBeNull();
      expect(formatAccuracyHint('600519')).toBeNull();
    });

    it('样本充足时按命中数计算准确率', () => {
      const now = new Date().toISOString();
      seed([
        { hit: true, returnPct: 10, evaluatedAt: now },
        { hit: true, returnPct: 5, evaluatedAt: now },
        { hit: false, returnPct: -8, evaluatedAt: now },
      ]);
      const { stock } = getRatingAccuracy('600519');
      expect(stock.judgedCount).toBe(3);
      expect(stock.hitCount).toBe(2);
      expect(stock.accuracyPct).toBe(66.67); // 2/3 = 66.666…% → 保留两位
    });

    it('中性评级样本不计入命中判定', () => {
      const now = new Date().toISOString();
      seed([
        { hit: null, returnPct: 30, evaluatedAt: now },
        { hit: null, returnPct: -30, evaluatedAt: now },
        { hit: null, returnPct: 0, evaluatedAt: now },
      ]);
      const { stock, overall } = getRatingAccuracy('600519');
      expect(stock.sampleCount).toBe(3);
      expect(stock.judgedCount).toBe(0);
      expect(stock.accuracyPct).toBeNull();
      expect(overall.avgReturnPct).toBe(0);
    });

    it('命中率提示包含该股与全样本口径，可用于注入仲裁', () => {
      const now = new Date().toISOString();
      seed([
        { hit: true, returnPct: 10, evaluatedAt: now },
        { hit: true, returnPct: 5, evaluatedAt: now },
        { hit: true, returnPct: 2, evaluatedAt: now },
      ]);
      const hint = formatAccuracyHint('600519');
      expect(hint).toContain('历史评级命中率');
      expect(hint).toContain('100%');
    });

    it('区分个股与全样本：其他股票的样本不计入该股口径', () => {
      const now = new Date().toISOString();
      seed([
        { stockCode: '600519', hit: true, returnPct: 10, evaluatedAt: now },
        { stockCode: '000001', hit: false, returnPct: -10, evaluatedAt: now },
        { stockCode: '000001', hit: false, returnPct: -5, evaluatedAt: now },
      ]);
      const { stock, overall } = getRatingAccuracy('600519');
      expect(stock.sampleCount).toBe(1);
      expect(overall.sampleCount).toBe(3);
    });
  });

  describe('并发读写不丢记录（跨 await 读-改-写竞态）', () => {
    it('回填在途时新写入的评级不会被陈旧快照整体覆盖', async () => {
      seed([{ id: 'due-1' }]); // 40 天前的待评估记录

      // 让取行情挂起，制造"回填进行中"的时间窗口
      const originalStockImpl = stockMock.getMockImplementation();
      const originalBenchImpl = benchMock.getMockImplementation();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      stockMock.mockImplementation(async () => {
        await gate;
        return [barOf(100), barOf(120)];
      });
      benchMock.mockImplementation(async () => {
        await gate;
        return [barOf(100), barOf(110)];
      });

      try {
        const evaluating = evaluateOutcomes(3);
        // 回填在途期间，另一次分析完成并写入新评级（模拟 /api/compare 并发场景）
        recordAnalysis({
          stockCode: '000001',
          rating: '优先跟踪',
          totalScore: 80,
          entryPrice: 50,
        });
        release();
        const done = await evaluating;

        const items = readItems();
        expect(done).toBe(1);
        // 旧记录被正确回填
        expect(items.find((it) => it.id === 'due-1')?.evaluatedAt).toBeTruthy();
        // 修复前：写回本轮开始时的陈旧快照，会把在途期间写入的新评级静默抹掉
        expect(items.some((it) => it.stockCode === '000001')).toBe(true);
        expect(items).toHaveLength(2);
      } finally {
        if (originalStockImpl) stockMock.mockImplementation(originalStockImpl);
        if (originalBenchImpl) benchMock.mockImplementation(originalBenchImpl);
      }
    });
  });
});

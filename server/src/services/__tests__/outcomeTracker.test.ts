import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

// 行情数据源打桩：个体最新价 120（评级发出时 100 → +20%），基准 100 → 110（+10%）
let simulated = false;
/** 每次取数收到的 signal（第 4 个参数）：用于断言取消是否沿调用链下传 */
const fetchSignals: (AbortSignal | undefined)[] = [];
const fetchMock = vi.fn(async (code: string) => {
  if (code === '000300') {
    return [
      { close: 100, isSimulated: simulated },
      { close: 110, isSimulated: simulated },
    ] as never[];
  }
  return [{ close: 120, isSimulated: simulated }] as never[];
});

vi.mock('../../quant/dataProvider.js', () => ({
  // 注意：只在**返回的箭头函数内部**引用 fetchSignals / fetchMock——vi.mock 工厂被提升，
  // 工厂体自身引用顶层 const 会命中 TDZ；内部函数要到用例执行时才取值，安全。
  fetchOHLCVData: (...args: unknown[]) => {
    fetchSignals.push(args[3] as AbortSignal | undefined);
    return fetchMock(args[0] as string);
  },
}));

const tmpDir = mkdtempSync(join(tmpdir(), 'outcome-'));
const tmpFile = join(tmpDir, 'outcomes.json');
const origFile = process.env.OUTCOME_FILE;

beforeEach(() => {
  process.env.OUTCOME_FILE = tmpFile;
  simulated = false;
  fetchMock.mockClear();
  fetchMock.mockImplementation(async (code: string) => {
    if (code === '000300') {
      return [
        { close: 100, isSimulated: simulated },
        { close: 110, isSimulated: simulated },
      ] as never[];
    }
    return [{ close: 120, isSimulated: simulated }] as never[];
  });
  fetchSignals.length = 0;
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

    it('signal 透传到行情取数（第 4 个参数），取消可级联到 socket 级', async () => {
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 100 }]);
      const ac = new AbortController();

      await evaluateOutcomes(3, ac.signal);

      expect(fetchSignals.length).toBeGreaterThan(0);
      expect(fetchSignals.every((s) => s === ac.signal)).toBe(true);
    });

    it('取数期间被取消：不再为剩余条目取数（已完成条目照常落盘，回填幂等）', async () => {
      seed([
        { stockCode: '600519', rating: '优先跟踪', entryPrice: 100 },
        { stockCode: '000001', rating: '优先跟踪', entryPrice: 100 },
      ]);
      const ac = new AbortController();
      // 模拟「上层 8s 限时到点」：取消信号置位后取数立即失败
      fetchMock.mockImplementation(async () => {
        ac.abort(new Error('timeout: 8000ms 未完成'));
        throw ac.signal.reason;
      });

      await evaluateOutcomes(3, ac.signal);

      // 第 1 条的两个来源各打一次（个体 + 基准）后即收手；不取消的话第 2 条还会再打两次
      expect(fetchSignals.length).toBe(2);
    });

    it('调用前就已取消：一条都不取数', async () => {
      seed([{ stockCode: '600519', rating: '优先跟踪', entryPrice: 100 }]);
      const ac = new AbortController();
      ac.abort();

      expect(await evaluateOutcomes(3, ac.signal)).toBe(0);
      expect(fetchSignals.length).toBe(0);
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
      const originalImpl = fetchMock.getMockImplementation();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      fetchMock.mockImplementation(async (code: string) => {
        await gate;
        if (code === '000300') {
          return [
            { close: 100, isSimulated: false },
            { close: 110, isSimulated: false },
          ] as never[];
        }
        return [{ close: 120, isSimulated: false }] as never[];
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

        const items = (JSON.parse(readFileSync(tmpFile, 'utf-8')) as { items: OutcomeRecord[] })
          .items;
        expect(done).toBe(1);
        // 旧记录被正确回填
        expect(items.find((it) => it.id === 'due-1')?.evaluatedAt).toBeTruthy();
        // 修复前：写回本轮开始时的陈旧快照，会把在途期间写入的新评级静默抹掉
        expect(items.some((it) => it.stockCode === '000001')).toBe(true);
        expect(items).toHaveLength(2);
      } finally {
        if (originalImpl) fetchMock.mockImplementation(originalImpl);
      }
    });
  });
});

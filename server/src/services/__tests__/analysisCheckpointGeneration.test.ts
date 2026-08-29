/**
 * 断点跨代隔离回归：全新（非 resume）分析不得继承磁盘上残留的上一代断点产物。
 *
 * 背景：saveCheckpoint 按 patch 合并写盘。若全新分析开始时不先清理残留断点
 * （例如上一代已过期、但 resume 未被请求所以 loadCheckpoint 的过期清理从未触发），
 * 上一代的 experts/arbitration 产物会混入新生成的断点——新分析若在 experts 完成
 * 前中断，后续 resume 会把新取的数据与旧代专家结论拼在一起（跨代错配）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

vi.mock('../expertRunner.js', () => ({
  // 注入「全部专家失败」：让流水线在 data 断点已落盘、experts 未完成的窗口中断
  runExpertsWithDegradation: vi.fn(async () => {
    throw new Error('全部专家失败（测试注入）');
  }),
}));
// 最小合法数据集：足以让 data 阶段（含 PE/PB 修正守卫）完整走完
const minData = {
  info: {
    code: '600519',
    name: '贵州茅台',
    industry: '白酒',
    market: '',
    listingDate: '',
    description: '',
  },
  financial: {
    years: ['2025'],
    revenue: [100],
    netProfit: [20],
    grossMargin: [90],
    netMargin: [20],
    roe: [25],
    operatingCashFlow: [22],
    eps: [2],
    totalAssets: [500],
    totalLiabilities: [100],
    equity: [400],
    accountsReceivable: [5],
    inventory: [10],
    goodwill: [0],
    debtRatio: [20],
    dataQuality: { estimatedFields: [], missingFields: [] },
  },
  valuation: {
    currentPrice: 1800,
    pe: 30,
    pb: 6,
    ps: 10,
    marketCap: 22600,
    historicalPE: [{ year: '2025', pe: 30, isEstimated: false }],
    peerComparison: [],
  },
};
vi.mock('../dataService.js', () => ({
  getData: vi.fn(async () => minData as never),
}));
vi.mock('../../quant/dataProvider.js', () => ({
  fetchOHLCVData: vi.fn(async () => []),
}));
vi.mock('../../quant/newsSignal.js', () => ({
  extractNewsSignal: vi.fn(async () => ({ signal: null, source: 'none' })),
}));

const tmpDir = mkdtempSync(join(tmpdir(), 'srs-ck-generation-'));
beforeAll(() => {
  process.env.ANALYSIS_CHECKPOINT_DIR = join(tmpDir, 'ck');
});
afterAll(() => {
  delete process.env.ANALYSIS_CHECKPOINT_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

import { runAnalysis } from '../analysisPipeline.js';
import { saveCheckpoint, loadCheckpoint } from '../analysisCheckpoint.js';

describe('断点跨代隔离（全新分析不继承残留断点）', () => {
  it('全新分析中断后，磁盘断点只含本代 data 产物，无上一代 experts 结论', async () => {
    // 上一代断点：experts 阶段完成，带哨兵结论
    saveCheckpoint('600519', {
      stage: 'experts',
      expertOpinions: [
        {
          expert: '过期代专家',
          overallSentiment: 'bullish',
          confidence: 99,
          arguments: [],
          keyPoints: ['上一代残留'],
        } as never,
      ],
      degradedExperts: [],
      finalOpinion: {
        expert: '过期代仲裁',
        overallSentiment: 'bullish',
        confidence: 99,
        arguments: [],
        keyPoints: [],
      } as never,
    });

    // 全新分析（不传 resume）：data 落盘后 experts 注入失败 → 流水线整体 reject
    await expect(runAnalysis('600519')).rejects.toThrow(/专家/); // 本代 experts 未完成即中断（注入失败或全降级均可）

    const ck = loadCheckpoint('600519');
    expect(ck).not.toBeNull();
    expect(ck!.stage).toBe('data'); // 本代进度
    expect(ck!.expertOpinions).toBeUndefined(); // 上一代专家结论不得残留
    expect(ck!.finalOpinion).toBeUndefined(); // 上一代仲裁结论不得残留
  });

  it('残留断点被清后，续跑请求自然退化为全新分析', async () => {
    // 承接上一用例的磁盘状态：此时即使请求 resume，也没有 experts 产物可复用
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runAnalysis('600519', undefined, { resume: true })).rejects.toThrow(/专家/);
    } finally {
      spy.mockRestore();
    }
    expect(loadCheckpoint('600519')!.expertOpinions).toBeUndefined();
  });
});

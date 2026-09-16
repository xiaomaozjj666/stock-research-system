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
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';

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

// 机构一致预期快照：单测不依赖外网，默认无快照（管线降级跳过）
vi.mock('../../quant/consensusProvider.js', () => ({
  fetchConsensusSnapshot: vi.fn(async () => null),
  formatConsensusBrief: vi.fn(() => ''),
}));

import { runAnalysis } from '../analysisPipeline.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../analysisCheckpoint.js';

describe('断点跨代隔离（全新分析不继承残留断点）', () => {
  it('全新分析中断后，磁盘断点只含本代 data 产物，无上一代 experts 结论', async () => {
    // 上一代断点：experts 阶段完成，带哨兵结论
    saveCheckpoint(
      '600519',
      {
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
      },
      'gen-old',
    );

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

/** 断点 data 载荷（最小合法集：复用上面的 minData 三段 + 空新闻/行情） */
function ckData() {
  return {
    info: minData.info,
    financial: minData.financial,
    valuation: minData.valuation,
    newsSignal: null,
    priceHistory: [],
  } as never;
}

describe('断点代次隔离（并发两代互不 merge、互不误删）', () => {
  const ckFile = () => join(tmpDir, 'ck', '600519.json');

  afterAll(() => {
    clearCheckpoint('600519');
  });

  it('两代并发写同一股票：代次不符不 merge，各自只能读回本代断点', () => {
    // A 代落 data 阶段（模拟双标签页/compare 并发触发的那一轮）
    saveCheckpoint('600519', { stage: 'data', data: ckData() }, 'gen-A');
    // B 代并发落 experts 阶段：绝不能把 A 代的 data 合并进 B 代文件
    saveCheckpoint(
      '600519',
      { stage: 'experts', expertOpinions: [{ expert: 'B代专家' }] as never },
      'gen-B',
    );

    const forB = loadCheckpoint('600519', 'gen-B');
    expect(forB).not.toBeNull();
    expect(forB!.expertOpinions).toHaveLength(1);
    // 关键断言：B 代文件里不得出现 A 代产物，否则 resume 会把 B 的数据与 A 的专家结论拼成报告
    expect(forB!.data).toBeUndefined();
    // 代次不符 → 视为无断点
    expect(loadCheckpoint('600519', 'gen-A')).toBeNull();
  });

  it('代 A 在文件被 B 覆盖后追加写，仍不会读到 B 的产物', () => {
    saveCheckpoint('600519', { stage: 'data', data: ckData() }, 'gen-A');
    saveCheckpoint(
      '600519',
      { stage: 'experts', expertOpinions: [{ expert: 'B代专家' }] as never },
      'gen-B',
    );
    // A 代继续写自己的 arbitration：base 代次不符 → 只保留本次 patch
    saveCheckpoint('600519', { stage: 'arbitration', controversies: [] as never }, 'gen-A');

    const forA = loadCheckpoint('600519', 'gen-A');
    expect(forA).not.toBeNull();
    expect(forA!.expertOpinions).toBeUndefined(); // B 代专家结论不得混入
    expect(forA!.data).toBeUndefined(); // A 代旧产物已被 B 代覆盖，不反向 merge
  });

  it('续跑链共享代次：resume 采用断点 runId，后续同代 merge 不被拒绝', () => {
    saveCheckpoint('600519', { stage: 'data', data: ckData() }, 'gen-A');
    // 续跑方不知道上一代 id：不带 runId 读取 → 采用文件里的代次
    const adopted = loadCheckpoint('600519');
    expect(adopted?.runId).toBe('gen-A');

    saveCheckpoint(
      '600519',
      { stage: 'experts', expertOpinions: [{ expert: '续跑专家' }] as never },
      adopted!.runId!,
    );
    const ck = loadCheckpoint('600519', 'gen-A');
    expect(ck?.data).toBeDefined(); // 同代 merge 正常：data 阶段产物仍在
    expect(ck?.expertOpinions).toHaveLength(1);
  });

  it('临时文件名带代次：并发写不互踩，且不留残留临时文件', () => {
    saveCheckpoint('600519', { stage: 'data', data: ckData() }, 'gen-A');
    saveCheckpoint('600519', { stage: 'data', data: ckData() }, 'gen-B');

    expect(readdirSync(join(tmpDir, 'ck')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // 原子替换后内容完整可解析，且属于最后写入的那一代
    const onDisk = JSON.parse(readFileSync(ckFile(), 'utf-8')) as { runId?: string };
    expect(onDisk.runId).toBe('gen-B');
  });
});

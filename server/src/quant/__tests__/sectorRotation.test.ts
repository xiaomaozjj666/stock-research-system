import { describe, it, expect } from 'vitest';
import {
  calculateSectorRotation,
  relativeStrengthPercentile,
  SECTOR_WEIGHTS,
  RS_STRONG_THRESHOLD,
  type SectorData,
} from '../sectorRotation.js';

/**
 * 工厂函数：构造行业数据，缺省字段用中性值填充，便于聚焦测试关注字段。
 */
function makeSector(over: Partial<SectorData> = {}): SectorData {
  return {
    sector: over.sector ?? '默认',
    revenueGrowth: over.revenueGrowth ?? 0,
    profitGrowth: over.profitGrowth ?? 0,
    roeChange: over.roeChange ?? 0,
    momentum20d: over.momentum20d ?? 0,
    momentum60d: over.momentum60d ?? 0,
    turnoverRate: over.turnoverRate ?? 0,
    volumeRatio: over.volumeRatio ?? 0,
    northboundConcentration: over.northboundConcentration ?? 0,
    benchmarkMomentum20d: over.benchmarkMomentum20d ?? 0,
  };
}

describe('calculateSectorRotation - 空输入处理', () => {
  it('空数组返回空结果且 summary="无行业数据"', () => {
    const result = calculateSectorRotation([]);
    expect(result.signals).toEqual([]);
    expect(result.topSectors).toEqual([]);
    expect(result.bottomSectors).toEqual([]);
    expect(result.summary).toBe('无行业数据');
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('null/undefined 输入安全降级（不抛错）', () => {
    const r1 = calculateSectorRotation(null as unknown as SectorData[]);
    expect(r1.signals).toEqual([]);
    const r2 = calculateSectorRotation(undefined as unknown as SectorData[]);
    expect(r2.signals).toEqual([]);
  });
});

describe('calculateSectorRotation - 景气度（三因子计算正确性）', () => {
  it('营收/利润/ROE 三因子全部正向 → 景气度得分高于 50', () => {
    const sectors = [
      makeSector({ sector: '高景气', revenueGrowth: 30, profitGrowth: 40, roeChange: 3 }),
      makeSector({ sector: '低景气', revenueGrowth: -10, profitGrowth: -20, roeChange: -2 }),
    ];
    const result = calculateSectorRotation(sectors);
    const high = result.signals.find((s) => s.sector === '高景气')!;
    const low = result.signals.find((s) => s.sector === '低景气')!;
    expect(high.prosperity).toBeGreaterThan(low.prosperity);
    expect(high.prosperity).toBeGreaterThan(50);
    expect(low.prosperity).toBeLessThan(50);
  });

  it('景气度得分 ∈ [0, 100]', () => {
    const sectors = [
      makeSector({ sector: 'A', revenueGrowth: 100, profitGrowth: 200, roeChange: 10 }),
      makeSector({ sector: 'B', revenueGrowth: -50, profitGrowth: -80, roeChange: -10 }),
      makeSector({ sector: 'C', revenueGrowth: 5, profitGrowth: 8, roeChange: 0 }),
    ];
    const result = calculateSectorRotation(sectors);
    for (const sig of result.signals) {
      expect(sig.prosperity).toBeGreaterThanOrEqual(0);
      expect(sig.prosperity).toBeLessThanOrEqual(100);
    }
  });

  it('单因子极值不影响整体方向（三因子平均）', () => {
    // 营收极强但利润/ROE 中等，景气度应介于强/弱之间
    const sectors = [
      makeSector({ sector: '混合', revenueGrowth: 100, profitGrowth: 5, roeChange: 0 }),
      makeSector({ sector: '均衡强', revenueGrowth: 30, profitGrowth: 30, roeChange: 3 }),
      makeSector({ sector: '均衡弱', revenueGrowth: -10, profitGrowth: -10, roeChange: -1 }),
    ];
    const result = calculateSectorRotation(sectors);
    const mixed = result.signals.find((s) => s.sector === '混合')!;
    const strong = result.signals.find((s) => s.sector === '均衡强')!;
    const weak = result.signals.find((s) => s.sector === '均衡弱')!;
    expect(strong.prosperity).toBeGreaterThan(weak.prosperity);
    // 混合态景气度位于强/弱之间
    expect(mixed.prosperity).toBeGreaterThan(weak.prosperity);
    expect(mixed.prosperity).toBeLessThan(strong.prosperity);
  });
});

describe('calculateSectorRotation - 趋势与 RS 相对强弱', () => {
  it('高动量 + 高 RS → 趋势得分高于 50', () => {
    const sectors = [
      makeSector({
        sector: '强趋势',
        momentum20d: 10,
        momentum60d: 20,
        benchmarkMomentum20d: 0,
      }),
      makeSector({
        sector: '弱趋势',
        momentum20d: -5,
        momentum60d: -10,
        benchmarkMomentum20d: 0,
      }),
    ];
    const result = calculateSectorRotation(sectors);
    const strong = result.signals.find((s) => s.sector === '强趋势')!;
    const weak = result.signals.find((s) => s.sector === '弱趋势')!;
    expect(strong.trend).toBeGreaterThan(weak.trend);
    expect(strong.trend).toBeGreaterThan(50);
    expect(weak.trend).toBeLessThan(50);
  });

  it('跑赢基准的行业 RS 较高', () => {
    const sectors = [
      makeSector({ sector: 'A', momentum20d: 10, benchmarkMomentum20d: 0 }),
      makeSector({ sector: 'B', momentum20d: -5, benchmarkMomentum20d: 0 }),
    ];
    const rs = relativeStrengthPercentile(sectors);
    expect(rs[0]).toBeGreaterThan(rs[1]);
    expect(rs[0]).toBe(100); // 最强
    expect(rs[1]).toBe(0); // 最弱
  });

  it('趋势得分 ∈ [0, 100]', () => {
    const sectors = [
      makeSector({ sector: 'A', momentum20d: 100, momentum60d: 200, benchmarkMomentum20d: -50 }),
      makeSector({ sector: 'B', momentum20d: -100, momentum60d: -200, benchmarkMomentum20d: 50 }),
    ];
    const result = calculateSectorRotation(sectors);
    for (const sig of result.signals) {
      expect(sig.trend).toBeGreaterThanOrEqual(0);
      expect(sig.trend).toBeLessThanOrEqual(100);
    }
  });
});

describe('relativeStrengthPercentile - RS 计算（国盛证券方法）', () => {
  it('空数组返回空', () => {
    expect(relativeStrengthPercentile([])).toEqual([]);
  });

  it('单样本返回 50（中性，避免除零）', () => {
    expect(
      relativeStrengthPercentile([
        makeSector({ sector: 'A', momentum20d: 5, benchmarkMomentum20d: 0 }),
      ]),
    ).toEqual([50]);
  });

  it('单调序列：分位线性递增 0..100', () => {
    // 5 个行业 RS = 0, 1, 2, 3, 4 → 分位 0, 25, 50, 75, 100
    const sectors = [0, 1, 2, 3, 4].map((i) =>
      makeSector({ sector: `S${i}`, momentum20d: i, benchmarkMomentum20d: 0 }),
    );
    const rs = relativeStrengthPercentile(sectors);
    expect(rs).toEqual([0, 25, 50, 75, 100]);
  });

  it('最强者 RS = 100 > 90（国盛证券强势阈值）', () => {
    const sectors = Array.from({ length: 10 }, (_, i) =>
      makeSector({ sector: `S${i}`, momentum20d: i, benchmarkMomentum20d: 0 }),
    );
    const rs = relativeStrengthPercentile(sectors);
    expect(Math.max(...rs)).toBe(100);
    expect(Math.max(...rs)).toBeGreaterThan(RS_STRONG_THRESHOLD);
  });

  it('完全并列（tie）取平均分位 50', () => {
    const sectors = [
      makeSector({ sector: 'A', momentum20d: 5, benchmarkMomentum20d: 0 }),
      makeSector({ sector: 'B', momentum20d: 5, benchmarkMomentum20d: 0 }),
      makeSector({ sector: 'C', momentum20d: 5, benchmarkMomentum20d: 0 }),
    ];
    const rs = relativeStrengthPercentile(sectors);
    expect(rs[0]).toBeCloseTo(50, 6);
    expect(rs[1]).toBeCloseTo(50, 6);
    expect(rs[2]).toBeCloseTo(50, 6);
  });

  it('部分并列：相邻等值取平均秩', () => {
    // RS 序列 [1, 2, 2, 3] → 排序后位置 [0,1,2,3]，中间两个 2 并列
    // 平均位置 (1+2)/2=1.5 → 分位 1.5/3·100=50
    const sectors = [1, 2, 2, 3].map((v) =>
      makeSector({ sector: `S${v}`, momentum20d: v, benchmarkMomentum20d: 0 }),
    );
    const rs = relativeStrengthPercentile(sectors);
    // sector S2（索引 1, 2）取平均分位 50
    expect(rs[1]).toBeCloseTo(50, 6);
    expect(rs[2]).toBeCloseTo(50, 6);
  });
});

describe('calculateSectorRotation - 拥挤度反向（高拥挤=低分）', () => {
  it('拥挤度得分反映资金面拥挤程度', () => {
    const sectors = [
      makeSector({
        sector: '拥挤',
        turnoverRate: 10,
        volumeRatio: 5,
        northboundConcentration: 3,
      }),
      makeSector({
        sector: '不拥挤',
        turnoverRate: 1,
        volumeRatio: 0.5,
        northboundConcentration: 0.1,
      }),
    ];
    const result = calculateSectorRotation(sectors);
    const crowded = result.signals.find((s) => s.sector === '拥挤')!;
    const uncrowded = result.signals.find((s) => s.sector === '不拥挤')!;
    expect(crowded.crowding).toBeGreaterThan(uncrowded.crowding);
    expect(crowded.crowding).toBeGreaterThan(50);
    expect(uncrowded.crowding).toBeLessThan(50);
  });

  it('其他条件相同时，高拥挤度 → 综合评分更低（反向贡献）', () => {
    const sectors = [
      // 拥挤行业：换手率/成交占比/北向集中度均高
      makeSector({
        sector: '拥挤',
        turnoverRate: 10,
        volumeRatio: 5,
        northboundConcentration: 3,
        revenueGrowth: 10,
        profitGrowth: 10,
        roeChange: 0,
        momentum20d: 0,
        momentum60d: 0,
        benchmarkMomentum20d: 0,
      }),
      // 不拥挤行业：换手率/成交占比/北向集中度均低
      makeSector({
        sector: '不拥挤',
        turnoverRate: 1,
        volumeRatio: 0.5,
        northboundConcentration: 0.1,
        revenueGrowth: 10,
        profitGrowth: 10,
        roeChange: 0,
        momentum20d: 0,
        momentum60d: 0,
        benchmarkMomentum20d: 0,
      }),
    ];
    const result = calculateSectorRotation(sectors);
    const crowded = result.signals.find((s) => s.sector === '拥挤')!;
    const uncrowded = result.signals.find((s) => s.sector === '不拥挤')!;
    expect(crowded.compositeScore).toBeLessThan(uncrowded.compositeScore);
  });
});

describe('calculateSectorRotation - 综合评分加权', () => {
  it('权重之和 = 1.0（景气度 0.4 + 趋势 0.4 + 拥挤度反向 0.2）', () => {
    const sum = SECTOR_WEIGHTS.prosperity + SECTOR_WEIGHTS.trend + SECTOR_WEIGHTS.crowding;
    expect(sum).toBeCloseTo(1.0, 6);
    expect(SECTOR_WEIGHTS.prosperity).toBe(0.4);
    expect(SECTOR_WEIGHTS.trend).toBe(0.4);
    expect(SECTOR_WEIGHTS.crowding).toBe(0.2);
  });

  it('综合评分 = 0.4·prosperity + 0.4·trend + 0.2·(100-crowding)', () => {
    const sectors = [
      makeSector({
        sector: 'A',
        revenueGrowth: 20,
        profitGrowth: 20,
        roeChange: 1,
        momentum20d: 5,
        momentum60d: 8,
        benchmarkMomentum20d: 0,
        turnoverRate: 2,
        volumeRatio: 1,
        northboundConcentration: 0.5,
      }),
      makeSector({
        sector: 'B',
        revenueGrowth: -5,
        profitGrowth: -10,
        roeChange: -1,
        momentum20d: -3,
        momentum60d: -5,
        benchmarkMomentum20d: 0,
        turnoverRate: 1,
        volumeRatio: 0.5,
        northboundConcentration: 0.1,
      }),
    ];
    const result = calculateSectorRotation(sectors);
    for (const sig of result.signals) {
      const expected =
        SECTOR_WEIGHTS.prosperity * sig.prosperity +
        SECTOR_WEIGHTS.trend * sig.trend +
        SECTOR_WEIGHTS.crowding * (100 - sig.crowding);
      // 因 compositeScore 已 round2，容差 0.05
      expect(sig.compositeScore).toBeCloseTo(expected, 1);
    }
  });

  it('综合评分 ∈ [0, 100]', () => {
    const sectors = [
      makeSector({
        sector: 'A',
        revenueGrowth: 100,
        profitGrowth: 200,
        roeChange: 10,
        momentum20d: 50,
        momentum60d: 100,
        benchmarkMomentum20d: -20,
        turnoverRate: 0.1,
        volumeRatio: 0.01,
        northboundConcentration: 0,
      }),
      makeSector({
        sector: 'B',
        revenueGrowth: -50,
        profitGrowth: -80,
        roeChange: -10,
        momentum20d: -50,
        momentum60d: -100,
        benchmarkMomentum20d: 20,
        turnoverRate: 50,
        volumeRatio: 30,
        northboundConcentration: 10,
      }),
    ];
    const result = calculateSectorRotation(sectors);
    for (const sig of result.signals) {
      expect(sig.compositeScore).toBeGreaterThanOrEqual(0);
      expect(sig.compositeScore).toBeLessThanOrEqual(100);
    }
  });
});

describe('calculateSectorRotation - 排名与推荐分类', () => {
  // 5 个行业，综合评分明显分化（Top 最优 → Bottom 最弱）
  const sectors: SectorData[] = [
    makeSector({
      sector: 'Top',
      revenueGrowth: 30,
      profitGrowth: 40,
      roeChange: 3,
      momentum20d: 10,
      momentum60d: 20,
      benchmarkMomentum20d: 0,
      turnoverRate: 1,
      volumeRatio: 0.5,
      northboundConcentration: 0.1,
    }),
    makeSector({
      sector: 'Good',
      revenueGrowth: 15,
      profitGrowth: 18,
      roeChange: 1,
      momentum20d: 5,
      momentum60d: 8,
      benchmarkMomentum20d: 0,
      turnoverRate: 2,
      volumeRatio: 1,
      northboundConcentration: 0.3,
    }),
    makeSector({
      sector: 'Mid',
      revenueGrowth: 5,
      profitGrowth: 5,
      roeChange: 0,
      momentum20d: 0,
      momentum60d: 0,
      benchmarkMomentum20d: 0,
      turnoverRate: 3,
      volumeRatio: 1.5,
      northboundConcentration: 0.5,
    }),
    makeSector({
      sector: 'Bad',
      revenueGrowth: -5,
      profitGrowth: -10,
      roeChange: -1,
      momentum20d: -5,
      momentum60d: -8,
      benchmarkMomentum20d: 0,
      turnoverRate: 4,
      volumeRatio: 2,
      northboundConcentration: 1,
    }),
    makeSector({
      sector: 'Bottom',
      revenueGrowth: -20,
      profitGrowth: -30,
      roeChange: -3,
      momentum20d: -10,
      momentum60d: -20,
      benchmarkMomentum20d: 0,
      turnoverRate: 8,
      volumeRatio: 4,
      northboundConcentration: 2,
    }),
  ];
  const result = calculateSectorRotation(sectors);

  it('排名 1..N 连续且唯一', () => {
    const ranks = result.signals.map((s) => s.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4, 5]);
  });

  it('综合评分最优 → rank=1 → sector="Top"', () => {
    const top = result.signals.find((s) => s.rank === 1)!;
    expect(top.sector).toBe('Top');
    expect(top.compositeScore).toBeGreaterThanOrEqual(
      result.signals.find((s) => s.rank === 2)!.compositeScore,
    );
  });

  it('综合评分最弱 → rank=5 → sector="Bottom"', () => {
    const bottom = result.signals.find((s) => s.rank === 5)!;
    expect(bottom.sector).toBe('Bottom');
  });

  it('前 20% overweight、后 20% underweight、中间 60% neutral', () => {
    const over = result.signals.filter((s) => s.recommendation === 'overweight');
    const under = result.signals.filter((s) => s.recommendation === 'underweight');
    const neutral = result.signals.filter((s) => s.recommendation === 'neutral');
    expect(over).toHaveLength(1);
    expect(under).toHaveLength(1);
    expect(neutral).toHaveLength(3);
    expect(over[0].rank).toBe(1);
    expect(under[0].rank).toBe(5);
  });

  it('topSectors / bottomSectors 与推荐分档一致', () => {
    expect(result.topSectors).toEqual(['Top']);
    expect(result.bottomSectors).toEqual(['Bottom']);
  });

  it('signals 按 rank 升序输出', () => {
    const ranks = result.signals.map((s) => s.rank);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });

  it('summary 包含行业数量、超配/低配名单、最优/最弱行业', () => {
    expect(result.summary).toContain('5');
    expect(result.summary).toContain('Top');
    expect(result.summary).toContain('Bottom');
    expect(result.summary).toContain('超配');
    expect(result.summary).toContain('低配');
  });
});

describe('calculateSectorRotation - 边界场景', () => {
  it('仅 1 个行业：rank=1，recommendation=overweight', () => {
    const result = calculateSectorRotation([
      makeSector({
        sector: 'Only',
        revenueGrowth: 10,
        profitGrowth: 10,
        roeChange: 0,
        momentum20d: 5,
        momentum60d: 10,
        benchmarkMomentum20d: 0,
        turnoverRate: 2,
        volumeRatio: 1,
        northboundConcentration: 0.5,
      }),
    ]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].rank).toBe(1);
    expect(result.signals[0].recommendation).toBe('overweight');
    expect(result.topSectors).toContain('Only');
  });

  it('所有数值相同（常数列）不崩溃：各分项得分=50、综合评分=50', () => {
    const result = calculateSectorRotation([
      makeSector({ sector: 'A' }),
      makeSector({ sector: 'B' }),
      makeSector({ sector: 'C' }),
    ]);
    // 常数列 z=0 → 各分项得分 = 50
    for (const sig of result.signals) {
      expect(sig.prosperity).toBeCloseTo(50, 1);
      expect(sig.trend).toBeCloseTo(50, 1);
      expect(sig.crowding).toBeCloseTo(50, 1);
      // 综合评分 = 0.4*50 + 0.4*50 + 0.2*(100-50) = 50
      expect(sig.compositeScore).toBeCloseTo(50, 1);
    }
    // 5 元素（此处为 3）时 topK=ceil(3*0.2)=1，bottomK=1
    expect(result.topSectors).toHaveLength(1);
    expect(result.bottomSectors).toHaveLength(1);
    expect(result.signals.filter((s) => s.recommendation === 'neutral')).toHaveLength(1);
  });

  it('10 个行业：topK=2、bottomK=2', () => {
    const sectors = Array.from({ length: 10 }, (_, i) =>
      makeSector({
        sector: `S${i}`,
        // 让综合评分单调递减：i 越小越优
        revenueGrowth: 20 - i * 4,
        profitGrowth: 20 - i * 4,
        roeChange: 2 - i * 0.4,
        momentum20d: 10 - i * 2,
        momentum60d: 20 - i * 4,
        turnoverRate: i + 1, // 越往后越拥挤
        volumeRatio: i + 1,
        northboundConcentration: i + 1,
        benchmarkMomentum20d: 0,
      }),
    );
    const result = calculateSectorRotation(sectors);
    const over = result.signals.filter((s) => s.recommendation === 'overweight');
    const under = result.signals.filter((s) => s.recommendation === 'underweight');
    const neutral = result.signals.filter((s) => s.recommendation === 'neutral');
    expect(over).toHaveLength(2);
    expect(under).toHaveLength(2);
    expect(neutral).toHaveLength(6);
    // 最优两个应是 S0、S1
    expect(result.topSectors).toEqual(expect.arrayContaining(['S0', 'S1']));
    // 最弱两个应是 S8、S9
    expect(result.bottomSectors).toEqual(expect.arrayContaining(['S8', 'S9']));
  });

  it('NaN / Infinity 输入安全降级（不抛错）', () => {
    const result = calculateSectorRotation([
      makeSector({
        sector: 'NaN-Rev',
        revenueGrowth: NaN,
        profitGrowth: 10,
        roeChange: 0,
        momentum20d: 0,
        momentum60d: 0,
        benchmarkMomentum20d: 0,
        turnoverRate: 0,
        volumeRatio: 0,
        northboundConcentration: 0,
      }),
      makeSector({ sector: 'Normal', revenueGrowth: 10, profitGrowth: 10, roeChange: 0 }),
    ]);
    expect(result.signals).toHaveLength(2);
    // 各分项得分应在 [0, 100] 之间（即使输入含 NaN）
    for (const sig of result.signals) {
      expect(sig.prosperity).toBeGreaterThanOrEqual(0);
      expect(sig.prosperity).toBeLessThanOrEqual(100);
      expect(sig.compositeScore).toBeGreaterThanOrEqual(0);
      expect(sig.compositeScore).toBeLessThanOrEqual(100);
    }
  });
});

describe('calculateSectorRotation - 输出结构', () => {
  it('返回的 SectorSignal 字段完整', () => {
    const result = calculateSectorRotation([
      makeSector({
        sector: 'A',
        revenueGrowth: 10,
        profitGrowth: 10,
        roeChange: 1,
        momentum20d: 5,
        momentum60d: 10,
        benchmarkMomentum20d: 0,
        turnoverRate: 2,
        volumeRatio: 1,
        northboundConcentration: 0.5,
      }),
      makeSector({
        sector: 'B',
        revenueGrowth: 5,
        profitGrowth: 5,
        roeChange: 0,
        momentum20d: 2,
        momentum60d: 4,
        benchmarkMomentum20d: 0,
        turnoverRate: 3,
        volumeRatio: 1.5,
        northboundConcentration: 0.8,
      }),
    ]);
    expect(result).toHaveProperty('date');
    expect(result).toHaveProperty('signals');
    expect(result).toHaveProperty('topSectors');
    expect(result).toHaveProperty('bottomSectors');
    expect(result).toHaveProperty('summary');
    for (const sig of result.signals) {
      expect(sig).toHaveProperty('sector');
      expect(sig).toHaveProperty('prosperity');
      expect(sig).toHaveProperty('trend');
      expect(sig).toHaveProperty('crowding');
      expect(sig).toHaveProperty('compositeScore');
      expect(sig).toHaveProperty('rank');
      expect(sig).toHaveProperty('recommendation');
      expect(['overweight', 'neutral', 'underweight']).toContain(sig.recommendation);
    }
  });
});

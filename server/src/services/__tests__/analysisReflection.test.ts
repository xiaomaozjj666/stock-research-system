import { describe, it, expect } from 'vitest';
import { buildReflectionNotes, extractOpposeRisks } from '../analysisReflection.js';
import type { ExpertOpinion } from '../../types.js';

/**
 * 自省阈值与动态风险提取的行为契约。
 *
 * 这块逻辑原先内联在 analysisPipeline.executeAnalysis（780+ 行）里，只能靠整条
 * 流水线间接覆盖——改一个阈值没法写断言。抽成纯函数后，阈值本身可以被钉住：
 * 下面每条用例都对应报告正文里**会出现在用户面前**的一句话。
 */

function opinion(args: ExpertOpinion['arguments']): ExpertOpinion {
  return {
    expert: 'T',
    arguments: args,
    overallSentiment: 'neutral',
    confidence: 70,
    keyPoints: [],
  };
}

function arg(type: 'support' | 'oppose', confidence: number, text: string) {
  return { type, confidence, text, evidenceType: 'inference' as const };
}

const baseInput = {
  yearCount: 3,
  years: ['2022', '2023', '2024'],
  revenueGrowthLatest: 12,
  cashFlowRatio: 0.7,
  grossMarginRange: 5,
  pePercentile: 50,
  degradedExperts: [],
  accuracySummary: null,
  expertTotal: 8,
  sentimentOf: () => 'neutral' as const,
  allOpinions: [],
};

const note = (notes: string[], prefix: string) => notes.find((n) => n.startsWith(prefix));

describe('buildReflectionNotes — 覆盖度与事后校准披露', () => {
  it('无降级专家时不产��覆盖度说明', () => {
    const notes = buildReflectionNotes(baseInput);
    expect(note(notes, '【自省·覆盖度】')).toBeUndefined();
  });

  it('有降级专家时如实披露参与人数与被剔除者', () => {
    const notes = buildReflectionNotes({ ...baseInput, degradedExperts: ['政策专家', '行业专家'] });
    const line = note(notes, '【自省·覆盖度】');
    expect(line).toContain('6/8');
    expect(line).toContain('政策专家、行业专家');
  });

  it('有命中统计时披露命中率与命中/判定数', () => {
    const notes = buildReflectionNotes({
      ...baseInput,
      accuracySummary: { stock: { sampleCount: 10, judgedCount: 8, hitCount: 6, accuracyPct: 75 } },
    });
    const line = note(notes, '【自省·事后校准】');
    expect(line).toContain('75%');
    expect(line).toContain('6/8');
  });

  it('有样本但样本不足时改口说"不足以统计"，不编造命中率', () => {
    const notes = buildReflectionNotes({
      ...baseInput,
      accuracySummary: {
        stock: { sampleCount: 2, judgedCount: 1, hitCount: 1, accuracyPct: null },
      },
    });
    const line = note(notes, '【自省·事后校准】');
    expect(line).toContain('样本量尚不足以统计命中率');
    expect(line).not.toContain('%');
  });
});

describe('buildReflectionNotes — 第一层：事实自省阈值', () => {
  it('营收增速 < 5% 且基本面看多 → 提示乐观偏差', () => {
    const notes = buildReflectionNotes({
      ...baseInput,
      revenueGrowthLatest: 3,
      sentimentOf: (k) => (k === 'fundamental' ? 'bullish' : 'neutral'),
    });
    expect(note(notes, '【自省】')).toContain('营收增速仅3.0%');
  });

  it('增速 < 5% 但基本面不看多 → 不产出该条（不硬凑自省）', () => {
    const notes = buildReflectionNotes({ ...baseInput, revenueGrowthLatest: 3 });
    expect(note(notes, '【自省】营收增速')).toBeUndefined();
  });

  it('现金流/利润 < 0.5 → 警告盈利质量', () => {
    const notes = buildReflectionNotes({ ...baseInput, cashFlowRatio: 0.4 });
    expect(note(notes, '【自省·警告】')).toContain('盈利质量存疑');
  });

  it('现金流/利润 > 0.9 → 验证通过', () => {
    const notes = buildReflectionNotes({ ...baseInput, cashFlowRatio: 1.2 });
    expect(note(notes, '【自省·验证通过】')).toContain('盈利质量可靠');
  });

  it('现金流比在 [0.5, 0.9] 闭区间内 → 两个分支都不触发', () => {
    const notes = buildReflectionNotes({ ...baseInput, cashFlowRatio: 0.5 });
    expect(note(notes, '【自省·警告】')).toBeUndefined();
    expect(note(notes, '【自省·验证通过】')).toBeUndefined();
  });

  it('毛利率波动 > 10 个百分点 → 警告稳定性差', () => {
    const notes = buildReflectionNotes({ ...baseInput, grossMarginRange: 12 });
    expect(note(notes, '【自省·警告】')).toContain('毛利率波动12.0个百分点');
  });

  it('毛利率波动 < 3 个百分点 → 验证通过', () => {
    const notes = buildReflectionNotes({ ...baseInput, grossMarginRange: 1 });
    expect(note(notes, '【自省·验证通过】')).toContain('稳定性高');
  });
});

describe('buildReflectionNotes — 第二层：逻辑闭环', () => {
  it('闭环①始终产出并写明数据跨度', () => {
    const notes = buildReflectionNotes(baseInput);
    expect(note(notes, '【逻辑闭环①】')).toContain('3年');
    expect(note(notes, '【逻辑闭环①】')).toContain('2022-2024');
  });

  it('闭环②无候选风险时回落到"未知风险"，不输出空串', () => {
    const notes = buildReflectionNotes(baseInput);
    expect(note(notes, '【逻辑闭环②】')).toContain('未知风险');
  });

  it('闭环③三个分位区间给出不同措辞', () => {
    const low = buildReflectionNotes({ ...baseInput, pePercentile: 10 });
    const mid = buildReflectionNotes({ ...baseInput, pePercentile: 50 });
    const high = buildReflectionNotes({ ...baseInput, pePercentile: 95 });
    expect(note(low, '【逻辑闭环③】')).toContain('充分反映悲观预期');
    expect(note(mid, '【逻辑闭环③】')).toContain('合理区间');
    expect(note(high, '【逻辑闭环③】')).toContain('充分定价');
  });

  it('闭环④行业看空优先于估值看空', () => {
    const notes = buildReflectionNotes({
      ...baseInput,
      sentimentOf: (k) =>
        k === 'industry' ? 'bearish' : k === 'valuation' ? 'bearish' : 'neutral',
    });
    expect(note(notes, '【逻辑闭环④】')).toContain('行业景气度下行');
  });

  it('闭环④行业不空但估值空 → 提示估值压力', () => {
    const notes = buildReflectionNotes({
      ...baseInput,
      sentimentOf: (k) => (k === 'valuation' ? 'bearish' : 'neutral'),
    });
    expect(note(notes, '【逻辑闭环④】')).toContain('估值压力');
  });

  it('闭环④都不空 → 回落基本面', () => {
    const notes = buildReflectionNotes(baseInput);
    expect(note(notes, '【逻辑闭环④】')).toContain('基本面变化');
  });
});

describe('extractOpposeRisks — 动态风险条目', () => {
  it('只取反对论点，支持论点不进入风险列表', () => {
    const risks = extractOpposeRisks([
      opinion([arg('support', 90, '看多理由'), arg('oppose', 80, '看空理由')]),
    ]);
    expect(risks).toEqual(['看空理由']);
  });

  it('置信度低于 65 的反对论点被过滤', () => {
    const risks = extractOpposeRisks([opinion([arg('oppose', 64, '不够确信的风险')])]);
    expect(risks).toEqual([]);
  });

  it('置信度恰为 65 时保留（边界含等号）', () => {
    const risks = extractOpposeRisks([opinion([arg('oppose', 65, '刚好够确信')])]);
    expect(risks).toEqual(['刚好够确信']);
  });

  it('超长文本截断到 60 字符并以省略号收尾', () => {
    const long = '长'.repeat(80);
    const risks = extractOpposeRisks([opinion([arg('oppose', 80, long)])]);
    expect(risks[0]).toHaveLength(60);
    expect(risks[0].endsWith('...')).toBe(true);
  });

  it('恰好 60 字符不截断', () => {
    const exact = '字'.repeat(60);
    const risks = extractOpposeRisks([opinion([arg('oppose', 80, exact)])]);
    expect(risks[0]).toBe(exact);
  });

  it('最多取 6 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => arg('oppose', 80, `风险${i}`));
    const risks = extractOpposeRisks([opinion(many)]);
    expect(risks).toHaveLength(6);
    expect(risks[0]).toBe('风险0');
  });

  it('首条即"最可能的看错场景"，与自省闭环②同源', () => {
    const opinions = [opinion([arg('oppose', 90, '现金流恶化'), arg('oppose', 80, '增速放缓')])];
    const risks = extractOpposeRisks(opinions);
    const notes = buildReflectionNotes({ ...baseInput, allOpinions: opinions });
    // 同一份实现 → 文案里的场景必须就是 risk_list 的第一条
    expect(note(notes, '【逻辑闭环②】')).toContain(risks[0]);
  });
});

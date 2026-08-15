import { describe, it, expect } from 'vitest';
import { generateReportMarkdown } from '../reportExport';
import type { AnalysisResult } from '../../types';

const SAMPLE: AnalysisResult = {
  research_confidence: '高',
  limitation_explain: '数据来源有限',
  data_sources: [],
  stock_pool: [
    {
      stock_code: '600519',
      stock_name: '贵州茅台',
      industry: '白酒',
      core_summary: '业绩稳健增长',
      total_score: 88,
      rating: '优先跟踪',
      score_detail: {
        profit_quality: 18,
        growth: 16,
        valuation: 15,
        industry_boom: 20,
        risk_deduction: 19,
      },
      strengths: ['品牌护城河强', '现金流充沛'],
      risk_list: ['估值偏高', '消费需求波动'],
      controversy_points: [
        {
          topic: '提价空间',
          bullishView: '提价能力强',
          bearishView: '需求疲软',
          arbitration: '中性',
          confidence: 60,
        },
      ],
      finance_metrics: {} as never,
      valuation: { currentPrice: 1500, pe: 30, pb: 8 } as never,
      valuation_level: '偏高',
      expert_opinions: [
        {
          expert: '基本面分析师',
          arguments: [{ text: '高毛利', confidence: 90, type: 'support' }],
          overallSentiment: 'bullish',
          confidence: 90,
          keyPoints: [],
        },
      ],
      reflection_notes: [],
      follow_up_indicators: ['季度营收增速', '渠道库存'],
      scenarios: [
        {
          name: '乐观',
          probability: 30,
          keyAssumptions: ['需求复苏'],
          targetPriceRange: { low: 1800, high: 2200 },
          supportingArguments: [],
          preconditions: ['宏观改善'],
        },
      ],
      strategyList: [
        {
          strategyType: 'ma_cross',
          sharpeRatio: 1.2,
          maxDrawdown: 15,
          winRate: 55,
          totalReturn: 25,
          applicableMarket: 'A',
          fatalWeakness: '震荡市频繁止损',
          backtestWarning: '',
        },
      ],
    },
  ],
};

describe('generateReportMarkdown 报告导出', () => {
  it('空结果返回空字符串', () => {
    expect(generateReportMarkdown({ stock_pool: [] } as never)).toBe('');
  });

  it('生成完整 Markdown：标题/摘要/评分表/优势/专家/风险/争议/情景/策略/跟踪', () => {
    const md = generateReportMarkdown(SAMPLE);
    expect(md).toContain('# 贵州茅台（600519）研究报告');
    expect(md).toContain('## 核心摘要');
    expect(md).toContain('业绩稳健增长');
    expect(md).toContain('| 盈利质量 | 18 |');
    expect(md).toContain('## 核心优势');
    expect(md).toContain('- 品牌护城河强');
    expect(md).toContain('## 专家观点');
    expect(md).toContain('### 基本面分析师：看多（置信度 90）');
    expect(md).toContain('- [支持] 高毛利');
    expect(md).toContain('## 争议焦点');
    expect(md).toContain('**提价空间**');
    expect(md).toContain('## 风险清单');
    expect(md).toContain('- 估值偏高');
    expect(md).toContain('## 情景推演');
    expect(md).toContain('**乐观（概率 30%）**');
    expect(md).toContain('## 量化策略');
    expect(md).toContain('**ma_cross**');
    expect(md).toContain('## 后续跟踪指标');
    expect(md).toContain('- [ ] 季度营收增速');
    // 末尾风险提示
    expect(md).toContain('不构成投资建议');
  });

  it('空数组区块不输出对应标题', () => {
    const empty: AnalysisResult = {
      stock_pool: [
        {
          stock_code: '000001',
          stock_name: '平安银行',
          industry: '银行',
          core_summary: 'x',
          total_score: 50,
          rating: '持续观察',
          score_detail: { profit_quality: 10, growth: 10, valuation: 10, industry_boom: 10, risk_deduction: 10 },
          strengths: [],
          risk_list: [],
          controversy_points: [],
          finance_metrics: {} as never,
          valuation: {} as never,
          valuation_level: '',
          expert_opinions: [],
          reflection_notes: [],
          follow_up_indicators: [],
        },
      ],
      research_confidence: '',
      limitation_explain: '',
      data_sources: [],
    };
    const md = generateReportMarkdown(empty);
    expect(md).not.toContain('## 核心优势');
    expect(md).not.toContain('## 专家观点');
    expect(md).not.toContain('## 风险清单');
    expect(md).toContain('# 平安银行（000001）研究报告');
  });
});

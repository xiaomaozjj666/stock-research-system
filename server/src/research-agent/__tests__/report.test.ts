/**
 * report 渲染单元测试：状态中文化、冲突表、引用编号连续性、降级链展示
 */
import { describe, it, expect } from 'vitest';
import { renderReportMarkdown } from '../report.js';
import type { ResearchReport } from '../types.js';

const report: ResearchReport = {
  title: '测试报告',
  executiveSummary: '摘要内容',
  overallConfidence: 0.8,
  confidenceLabel: '高',
  sections: [
    {
      subQuestionId: 'SQ-1',
      question: '问题一',
      conclusion: '结论一',
      confidence: 0.85,
      confidenceLabel: '高',
      citations: [
        {
          evidenceId: 'EV-1',
          claim: '事实A',
          sourceTitle: '来源一',
          sourceType: 'news_media',
          publisher: 'P1',
          path: { round: 1, query: 'q1', adapter: 'primary', attempt: 1 },
        },
      ],
      conflictNotes: [],
      status: 'consistent',
    },
    {
      subQuestionId: 'SQ-2',
      question: '问题二',
      conclusion: '结论二',
      confidence: 0.3,
      confidenceLabel: '低',
      citations: [
        {
          evidenceId: 'EV-2',
          claim: '事实B',
          sourceTitle: '来源二',
          sourceType: 'company_disclosure',
          path: { round: 2, query: 'q2', adapter: 'backup', attempt: 2, fallbackOf: 'primary' },
        },
      ],
      conflictNotes: [],
      status: 'blocked',
    },
  ],
  methodology: {
    rounds: 2,
    adaptersUsed: ['primary', 'backup'],
    evidenceCount: 2,
    sourceCount: 2,
    planVersions: 2,
    conflictsFound: 1,
  },
  conflicts: [
    {
      evidenceIds: ['EV-1', 'EV-2'],
      dimension: 'numeric',
      description: '数值不一致',
      resolution: 'unresolved',
    },
  ],
  limitations: ['子问题「问题二」受阻。'],
  generatedAt: '2026-09-12T12:00:00.000Z',
};

describe('renderReportMarkdown', () => {
  it('状态中文化、冲突表、引用编号跨节连续、降级链展示', () => {
    const md = renderReportMarkdown(report);
    expect(md).toContain('# 测试报告');
    expect(md).toContain('多源一致'); // consistent -> 中文标签
    expect(md).toContain('受阻'); // blocked -> 中文标签
    expect(md).toContain('## 数据与口径差异');
    expect(md).toContain('未决');
    expect(md).toContain('1. 事实A');
    expect(md).toContain('2. 事实B'); // 编号跨分节连续
    expect(md).toContain('由 primary 降级');
    expect(md).toContain('通道 backup');
    expect(md).toContain('- 子问题「问题二」受阻。');
    expect(md).toContain('总体置信度');
  });

  it('缺省字段兜底：空摘要、无 publisher/publishedAt 的引用', () => {
    const minimal: ResearchReport = {
      ...report,
      executiveSummary: '',
      sections: [
        {
          subQuestionId: 'SQ-9',
          question: '问题九',
          conclusion: '结论九',
          confidence: 0.2,
          confidenceLabel: '低',
          citations: [
            {
              evidenceId: 'EV-9',
              claim: '事实C',
              sourceTitle: '来源C',
              sourceType: 'unknown',
              path: { round: 3, query: 'q3', adapter: 'primary', attempt: 3 },
            },
          ],
          conflictNotes: [],
          status: 'weird-status', // 未知状态原样透出
        },
      ],
      conflicts: [],
      limitations: [],
    };
    const md = renderReportMarkdown(minimal);
    expect(md).toContain('（无）'); // 空执行摘要占位
    expect(md).toContain('weird-status'); // 未知状态不强行映射
    expect(md).toContain('1. 事实C'); // 编号在单次渲染内从 1 起
    expect(md).toContain('未知来源');
    expect(md).toContain('（未知来源）获取路径'); // publisher/publishedAt 缺省不产生空分隔符
  });
});

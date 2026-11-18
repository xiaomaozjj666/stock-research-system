/**
 * 深度研究测试夹具
 * ----------------------------------------------------------------------------
 * AgentRunResult 字段多且层级深，测试里逐处手写会迅速失控：字段一变就要改
 * 十几个用例。这里提供一份结构完整的最小样例，用例只在需要时覆盖个别字段
 * （`makeRunResult({ report: { ... } })`）。
 *
 * 放在 test/ 而不是 __tests__/ 下：它不是用例，不会被 vitest 当作测试收集。
 */
import type { AgentRunResult } from '../research-agent/index.js';

export function makeRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  const report: AgentRunResult['report'] = {
    title: '白酒行业竞争格局研究',
    executiveSummary: '高端白酒集中度继续提升，次高端竞争加剧。',
    overallConfidence: 0.72,
    confidenceLabel: '高',
    sections: [
      {
        subQuestionId: 'q1',
        question: '高端白酒集中度如何？',
        conclusion: 'CR3 持续上行。',
        confidence: 0.8,
        confidenceLabel: '高',
        citations: [],
        conflictNotes: [],
        status: 'consistent',
      },
    ],
    methodology: {
      rounds: 2,
      adaptersUsed: ['eastmoney.announcement'],
      evidenceCount: 3,
      sourceCount: 2,
      planVersions: 1,
      conflictsFound: 1,
    },
    conflicts: [],
    limitations: [],
    generatedAt: '2026-11-18T02:00:00.000Z',
  };

  return {
    report,
    reportMarkdown: '# 白酒行业竞争格局研究',
    plan: {
      id: 'plan-1',
      originalQuestion: '白酒行业竞争格局',
      scope: {},
      subQuestions: [],
      version: 1,
      revisions: [],
      createdAt: '2026-11-18T01:55:00.000Z',
      updatedAt: '2026-11-18T01:55:00.000Z',
    },
    evidence: [],
    verifications: [],
    events: [
      {
        seq: 1,
        type: 'run_started',
        round: 0,
        at: '2026-11-18T01:55:00.000Z',
        message: '开始研究',
      },
    ],
    stats: {
      rounds: 2,
      totalRetrievalTasks: 4,
      succeededTasks: 3,
      failedTasks: 1,
      fallbacksUsed: 1,
      evidenceCount: 3,
      conflictsFound: 1,
      supplementRounds: 0,
      planVersions: 1,
      startedAt: '2026-11-18T01:55:00.000Z',
      finishedAt: '2026-11-18T02:00:00.000Z',
      stopReason: 'all_p0_sufficient',
    },
    ...overrides,
  };
}

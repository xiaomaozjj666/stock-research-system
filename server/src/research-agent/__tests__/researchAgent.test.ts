/**
 * 研究 Agent 规划层端到端测试
 * ------------------------------------------------------------------
 * 用脚本化 FakeLLM / FakeSearch 覆盖四阶段编排的关键路径：
 * 1. happy path：单轮收敛，报告/引用/置信度完整；
 * 2. 证据不足 -> 自动补充检索 -> 次轮达标；
 * 3. 多源数值冲突 -> 仲裁留痕；
 * 4. 主检索通道故障 -> 降级通道接管（获取路径可审计）；
 * 5. 所有通道故障 -> 覆盖缺口进局限性声明，流程不崩；
 * 6. LLM 输出不合规 -> 带错误反馈重试后恢复；
 * 7. 引用完整性：LLM 编造的证据 ID 被剔除；
 * 8. 轮次上限终止：带局限性降级交付，不死循环；
 * 9. 事件流：seq 单调、首尾事件与关键阶段事件齐备。
 */
import { describe, it, expect } from 'vitest';
import { ResearchOrchestrator } from '../index.js';
import type { SearchAdapter, SearchHit } from '../search.js';
import type { LLMAdapter, LLMRequest } from '../llm.js';
import type { ScopeConstraints } from '../types.js';

// ---------------------------------------------------------------- Fakes

interface Behavior {
  match: RegExp;
  handle: (prompt: string, callIndex: number) => string;
  /** 由 FakeLLM 维护的调用计数，支持按次序返回不同脚本 */
  callCount?: number;
}

class FakeLLM implements LLMAdapter {
  readonly name = 'fake-llm';
  constructor(private readonly behaviors: Behavior[]) {}

  async complete(req: LLMRequest): Promise<string> {
    const behavior = this.behaviors.find((b) => b.match.test(req.prompt));
    if (!behavior) {
      throw new Error(`FakeLLM 未匹配到行为脚本: ${req.prompt.slice(0, 60)}`);
    }
    behavior.callCount = (behavior.callCount ?? 0) + 1;
    return behavior.handle(req.prompt, behavior.callCount);
  }
}

interface ResponderResult {
  hits?: SearchHit[];
  throwOnSearch?: boolean;
  throwOnFetch?: boolean;
}

class FakeSearch implements SearchAdapter {
  readonly name: string;
  queries: string[] = [];
  private calls = 0;

  constructor(
    name: string,
    private readonly responder: (callIndex: number, query: string) => ResponderResult,
  ) {
    this.name = name;
  }

  async search({ query }: { query: string; maxResults: number }): Promise<SearchHit[]> {
    this.calls += 1;
    this.queries.push(query);
    const r = this.responder(this.calls, query);
    if (r.throwOnSearch) throw new Error('search service down');
    return r.hits ?? [];
  }

  async fetch(url: string): Promise<{ url: string; title: string; text: string }> {
    const r = this.responder(this.calls, url);
    if (r.throwOnFetch) throw new Error('fetch blocked');
    return { url, title: `doc ${url}`, text: `正文内容 for ${url}：包含相关数据与事实。` };
  }
}

// ---------------------------------------------------------------- 响应构造器

const hit = (n: number): SearchHit => ({
  title: `来源文章 ${n}`,
  url: `https://news.example.com/${n}`,
  publisher: `出版方${n}`,
  sourceType: 'news_media',
});

function extractEvidenceIds(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\[?(EV-[a-z0-9]+)\]?/g)].map((m) => m[1]))];
}

const planResponse = (
  sqs: {
    question: string;
    priority: string;
    keywords: string[];
    expectedSources?: string[];
    successCriteria?: string;
  }[],
): string => JSON.stringify({ subQuestions: sqs });

function verifyBehavior(opts?: {
  consistency?: string;
  confidence?: number;
  withConflict?: boolean;
  hints?: string[];
}): Behavior & { callCount?: number } {
  return {
    match: /证据交叉验证专家/,
    handle: (prompt) => {
      const ids = extractEvidenceIds(prompt);
      const conflicts =
        opts?.withConflict && ids.length >= 2
          ? [
              {
                evidenceIds: [ids[0], ids[1]],
                dimension: 'numeric',
                description: '两来源对营收增速的数值矛盾（12% vs 9%）',
                resolution: 'a_wins',
                resolutionReason: '前者来源层级更高且更新',
              },
            ]
          : [];
      return JSON.stringify({
        consistency: opts?.consistency ?? 'consistent',
        verdict: '阶段性结论：证据相互印证',
        confidence: opts?.confidence ?? 0.85,
        supportingEvidenceIds: ids,
        conflicts,
        ...(opts?.hints ? { supplementHints: opts.hints } : {}),
      });
    },
  };
}

const extractionBehavior: Behavior = {
  match: /证据抽取专家/,
  handle: (prompt) => {
    const title = prompt.match(/文档标题: (.*)/)?.[1]?.trim() ?? '未知文档';
    return JSON.stringify({
      items: [
        { claim: `关于「${title}」的事实陈述`, quote: `${title} 的关键原文摘录`, isRelevant: true },
      ],
    });
  },
};

const synthesisBehavior: Behavior = {
  match: /研究报告撰写专家/,
  handle: (prompt) => {
    const sections: { subQuestionId: string; conclusion: string; keyEvidenceIds: string[] }[] = [];
    for (const m of prompt.matchAll(/- \[(SQ-[a-z0-9]+)\][^\n]*/g)) {
      const evIds = [...new Set([...m[0].matchAll(/EV-[a-z0-9]+/g)].map((x) => x[0]))];
      sections.push({
        subQuestionId: m[1],
        conclusion: `子问题 ${m[1]} 的结论陈述`,
        keyEvidenceIds: evIds.slice(0, 1),
      });
    }
    return JSON.stringify({ title: '测试研究报告', executiveSummary: '这是执行摘要。', sections });
  },
};

const noChangeReplanBehavior: Behavior = {
  match: /检索计划修订专家/,
  handle: () =>
    JSON.stringify({
      action: 'no_change',
      reason: '计划仍适用，继续换关键词补充检索',
      add: [],
      adjust: [],
      drop: [],
    }),
};

// ---------------------------------------------------------------- 用例

const NOOP_SLEEP = async () => {};
const SCOPE: ScopeConstraints = { region: '中国', industry: '消费电子' };

describe('ResearchOrchestrator 四阶段编排', () => {
  it('happy path：单轮收敛，报告/引用/置信度完整', async () => {
    const search = new FakeSearch('primary', (call) => ({
      hits: call === 1 ? [hit(1), hit(2)] : [hit(3), hit(4)],
    }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            {
              question: 'A公司2025年营收增速是多少',
              priority: 'P0',
              keywords: ['营收', '增速', 'revenue growth'],
              expectedSources: ['news_media', 'company_disclosure'],
            },
            {
              question: '营收增长的主要驱动是什么',
              priority: 'P1',
              keywords: ['驱动因素', 'growth driver'],
            },
          ]),
      },
      extractionBehavior,
      verifyBehavior(),
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({ llm, adapters: [search], sleep: NOOP_SLEEP });
    const result = await agent.run('分析 A 公司 2025 年营收表现', SCOPE);

    expect(result.stats.stopReason).toBe('all_p0_sufficient');
    expect(result.stats.rounds).toBe(1);
    expect(result.plan.version).toBe(1);
    expect(result.evidence).toHaveLength(4);
    expect(result.verifications).toHaveLength(2);
    expect(result.report.sections).toHaveLength(2);
    expect(result.report.overallConfidence).toBeGreaterThan(0.6);
    expect(result.report.sections[0]!.citations.length).toBeGreaterThan(0);
    expect(result.reportMarkdown).toContain('## 主要发现');
    expect(result.reportMarkdown).toContain('获取路径');
    expect(result.reportMarkdown).toContain('news.example.com/1');
    // P1 未达标不影响 P0 收敛，但状态如实呈现
    expect(result.report.sections[1]!.status).toBe('consistent');
  });

  it('证据不足：自动触发补充检索，次轮达标', async () => {
    const search = new FakeSearch('primary', (call) => ({
      hits: [hit(call * 10 + 1), hit(call * 10 + 2)],
    }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            {
              question: 'A公司2025年营收增速',
              priority: 'P0',
              keywords: ['营收', '增速'],
              expectedSources: ['company_disclosure'],
            },
          ]),
      },
      extractionBehavior,
      verifyBehavior(),
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({
      llm,
      adapters: [search],
      config: { minEvidencePerSubQuestion: 3, maxRounds: 3 },
      sleep: NOOP_SLEEP,
    });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    expect(result.stats.rounds).toBe(2);
    expect(result.stats.stopReason).toBe('all_p0_sufficient');
    const sq = result.plan.subQuestions[0]!;
    expect(sq.status).toBe('sufficient');
    expect(sq.supplementRoundsUsed).toBe(1);
    // 第二轮查询应消费验证阶段给出的补充方向（确定性提示文本；成功后 hints 会被清空）
    expect(search.queries[1]).toBe('补充检索公司官方披露类来源');
    expect(result.evidence.length).toBeGreaterThanOrEqual(3);
    expect(result.stats.supplementRounds).toBe(1);
  });

  it('多源数值冲突：仲裁留痕并写入报告', async () => {
    const search = new FakeSearch('primary', () => ({ hits: [hit(1), hit(2)] }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            { question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收', '增速'] },
          ]),
      },
      extractionBehavior,
      verifyBehavior({ withConflict: true, confidence: 0.7 }),
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({ llm, adapters: [search], sleep: NOOP_SLEEP });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    expect(result.stats.stopReason).toBe('all_p0_sufficient');
    expect(result.report.conflicts).toHaveLength(1);
    expect(result.report.conflicts[0]!.resolution).toBe('a_wins');
    expect(result.report.conflicts[0]!.dimension).toBe('numeric');
    expect(result.reportMarkdown).toContain('数据与口径差异');
    expect(result.reportMarkdown).toContain('采信前者');
    expect(result.report.sections[0]!.conflictNotes.length).toBeGreaterThan(0);
  });

  it('主通道故障：降级到备用通道，获取路径记录降级链', async () => {
    const flaky = new FakeSearch('flaky', () => ({ throwOnSearch: true }));
    const backup = new FakeSearch('backup', () => ({ hits: [hit(1), hit(2)] }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            { question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收', '增速'] },
          ]),
      },
      extractionBehavior,
      verifyBehavior(),
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({
      llm,
      adapters: [flaky, backup],
      config: { maxRetrievalAttempts: 2, retryBackoffMs: 0 },
      sleep: NOOP_SLEEP,
    });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    expect(result.stats.fallbacksUsed).toBeGreaterThanOrEqual(1);
    const citation = result.report.sections[0]!.citations[0]!;
    expect(citation.path.adapter).toBe('backup');
    expect(citation.path.fallbackOf).toBe('flaky');
    expect(citation.path.attempt).toBe(1);
    expect(result.events.some((e) => e.type === 'retrieval_fallback')).toBe(true);
    expect(result.report.methodology.adaptersUsed).toContain('backup');
  });

  it('所有通道故障：覆盖缺口进入局限性声明，流程正常收敛', async () => {
    const deadA = new FakeSearch('deadA', () => ({ throwOnSearch: true }));
    const deadB = new FakeSearch('deadB', () => ({ throwOnSearch: true }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            { question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收', '增速'] },
          ]),
      },
      extractionBehavior,
      verifyBehavior(),
      noChangeReplanBehavior,
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({
      llm,
      adapters: [deadA, deadB],
      config: { maxRounds: 2, maxRetrievalAttempts: 1, retryBackoffMs: 0 },
      sleep: NOOP_SLEEP,
    });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    // 两轮均无新增证据 → 无进展强制收敛（先于 no_pending_work 判定）
    expect(result.stats.stopReason).toBe('no_progress');
    expect(result.evidence).toHaveLength(0);
    expect(result.stats.failedTasks).toBeGreaterThanOrEqual(1);
    expect(result.plan.version).toBe(1); // replan 评估为 no_change，版本不变
    expect(result.report.limitations.join('\n')).toContain('检索');
    expect(result.report.sections[0]!.status).toBe('blocked');
    expect(result.report.overallConfidence).toBeLessThan(0.2);
  });

  it('LLM 输出不合规：带错误反馈重试后恢复', async () => {
    const search = new FakeSearch('primary', (call) => ({ hits: [hit(call), hit(call + 100)] }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: (_prompt, call) => {
          if (call === 1) return '抱歉，我无法以 JSON 输出。';
          return (
            '```json\n' +
            planResponse([
              { question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收'] },
              { question: '增长驱动', priority: 'P1', keywords: ['驱动'] },
            ]) +
            '\n```'
          );
        },
      },
      extractionBehavior,
      verifyBehavior(),
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({ llm, adapters: [search], sleep: NOOP_SLEEP });
    const result = await agent.run('A公司2025年营收表现', SCOPE);

    expect(result.plan.subQuestions).toHaveLength(2); // 重试后计划正常生成
    expect(result.stats.stopReason).toBe('all_p0_sufficient');
  });

  it('引用完整性：LLM 编造的证据 ID 被剔除并回退到验证采信集合', async () => {
    const search = new FakeSearch('primary', () => ({ hits: [hit(1), hit(2)] }));
    const hallucinatedSynthesis: Behavior = {
      match: /研究报告撰写专家/,
      handle: (prompt) => {
        const sqId = [...prompt.matchAll(/\[(SQ-[a-z0-9]+)\]/g)][0]?.[1] ?? 'SQ-unknown';
        return JSON.stringify({
          title: '测试报告',
          executiveSummary: '摘要',
          sections: [
            { subQuestionId: sqId, conclusion: '结论', keyEvidenceIds: ['EV-HALLUCINATED99'] },
          ],
        });
      },
    };
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([{ question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收'] }]),
      },
      extractionBehavior,
      verifyBehavior(),
      hallucinatedSynthesis,
    ]);

    const agent = new ResearchOrchestrator({ llm, adapters: [search], sleep: NOOP_SLEEP });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    expect(result.reportMarkdown).not.toContain('EV-HALLUCINATED99');
    expect(result.report.sections[0]!.citations.length).toBeGreaterThan(0);
    // 回退引用必须是验证阶段采信的真实证据
    const realIds = new Set(result.evidence.map((e) => e.id));
    for (const c of result.report.sections[0]!.citations) {
      expect(realIds.has(c.evidenceId)).toBe(true);
    }
  });

  it('轮次上限终止：带局限性声明降级交付，不发生死循环', async () => {
    const search = new FakeSearch('primary', (call) => ({ hits: [hit(call), hit(call + 50)] }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            { question: '难以验证的问题', priority: 'P0', keywords: ['冷门', '话题'] },
          ]),
      },
      extractionBehavior,
      verifyBehavior({ consistency: 'insufficient', confidence: 0.3, hints: ['换个角度检索'] }),
      noChangeReplanBehavior,
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({
      llm,
      adapters: [search],
      config: { maxRounds: 2, maxSupplementRoundsPerSubQuestion: 3 },
      sleep: NOOP_SLEEP,
    });
    const result = await agent.run('难以验证的问题', SCOPE);

    expect(result.stats.stopReason).toBe('max_rounds');
    expect(result.stats.rounds).toBe(2);
    expect(result.report.limitations.join('\n')).toContain('证据不足');
    expect(result.report).toBeDefined();
    // 两轮查询词应发生变化（补充方向被消费）
    expect(search.queries[0]).not.toBe(search.queries[1]);
  });

  it('事件流：seq 单调递增，关键阶段事件齐备', async () => {
    const search = new FakeSearch('primary', () => ({ hits: [hit(1), hit(2)] }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([{ question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收'] }]),
      },
      extractionBehavior,
      verifyBehavior(),
      synthesisBehavior,
    ]);

    const seen: string[] = [];
    const agent = new ResearchOrchestrator({
      llm,
      adapters: [search],
      onEvent: (e) => seen.push(e.type),
      sleep: NOOP_SLEEP,
    });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    const seqs = result.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(result.events[0]!.type).toBe('run_started');
    expect(result.events[result.events.length - 1]!.type).toBe('run_finished');
    for (const t of [
      'plan_created',
      'retrieval_started',
      'retrieval_succeeded',
      'evidence_extracted',
      'verification_completed',
      'synthesis_started',
      'synthesis_completed',
    ]) {
      expect(seen).toContain(t);
    }
  });

  it('replan 复活：补充检索穷尽后计划修订换路径，P0 不可被 drop', async () => {
    const search = new FakeSearch('primary', (call) => ({
      hits: [hit(call * 10 + 1), hit(call * 10 + 2)],
    }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            { question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收', '增速'] },
          ]),
      },
      extractionBehavior,
      {
        // 验证脚本：第 1、2 次不足，第 3 次（换关键词后）一致
        match: /证据交叉验证专家/,
        handle: (prompt, call) => {
          const ids = extractEvidenceIds(prompt);
          if (call <= 2) {
            return JSON.stringify({
              consistency: 'insufficient',
              verdict: '证据仍不足以交叉验证',
              confidence: 0.3,
              supportingEvidenceIds: ids,
              conflicts: [],
              supplementHints: ['换个角度检索'],
            });
          }
          return JSON.stringify({
            consistency: 'consistent',
            verdict: '证据相互印证',
            confidence: 0.85,
            supportingEvidenceIds: ids,
            conflicts: [],
          });
        },
      },
      {
        // replan 脚本：adjust P0 关键词 + add 对照子问题 + drop P0（应被拒绝）
        match: /检索计划修订专家/,
        handle: (prompt) => {
          const sqId = [...prompt.matchAll(/- (SQ-[a-z0-9]+) \[/g)][0]?.[1] ?? 'SQ-unknown';
          return JSON.stringify({
            action: 'adjust',
            reason: '通用词命中率低，改用官方披露口径',
            add: [
              {
                question: 'B公司同口径营收增速对照',
                priority: 'P1',
                keywords: ['B公司', '营收'],
                expectedSources: ['news_media'],
                successCriteria: '',
                derivedFrom: sqId,
              },
            ],
            adjust: [{ id: sqId, keywords: ['官方披露', '年报营收'], reason: '换权威口径' }],
            drop: [{ id: sqId, reason: '尝试丢弃 P0（应被拒绝）' }],
          });
        },
      },
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({
      llm,
      adapters: [search],
      config: { maxRounds: 3 },
      sleep: NOOP_SLEEP,
    });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    expect(result.stats.rounds).toBe(3);
    expect(result.stats.stopReason).toBe('all_p0_sufficient');
    expect(result.plan.version).toBe(2);
    // drop P0 被拒，add 生效 → 2 个子问题
    expect(result.plan.subQuestions).toHaveLength(2);
    const p0 = result.plan.subQuestions.find((s) => s.priority === 'P0')!;
    expect(p0.keywords).toEqual(['官方披露', '年报营收']);
    expect(p0.supplementRoundsUsed).toBe(0); // adjust 重置补充预算
    expect(result.plan.subQuestions.some((s) => s.question.includes('B公司'))).toBe(true);
    // 第 3 轮检索应使用调整后的关键词
    expect(search.queries[2]).toBe('官方披露 年报营收');
    expect(result.plan.revisions[0]!.adjusted).toContain(p0.id);
    expect(result.plan.revisions[0]!.removed).toHaveLength(0);
  });

  it('持续零命中：无进展强制收敛，不空转', async () => {
    const search = new FakeSearch('primary', () => ({ hits: [] }));
    // 故意不提供验证行为脚本：零证据走确定性门槛，若实现回退为调用 LLM 将直接抛错
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([{ question: '难以检索的问题', priority: 'P0', keywords: ['冷门'] }]),
      },
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({ llm, adapters: [search], sleep: NOOP_SLEEP });
    const result = await agent.run('难以检索的问题', SCOPE);

    expect(result.stats.stopReason).toBe('no_progress');
    expect(result.stats.rounds).toBe(2);
    expect(result.evidence).toHaveLength(0);
    expect(result.report.limitations.join('\n')).toContain('证据');
  });

  it('任务预算截断：单轮只执行限额内子问题，预算外保持 pending', async () => {
    const search = new FakeSearch('primary', (call) => ({ hits: [hit(call), hit(call + 100)] }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            { question: '问题一', priority: 'P0', keywords: ['k1'] },
            { question: '问题二', priority: 'P1', keywords: ['k2'] },
            { question: '问题三', priority: 'P1', keywords: ['k3'] },
          ]),
      },
      extractionBehavior,
      verifyBehavior(),
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({
      llm,
      adapters: [search],
      config: { maxRetrievalTasksPerRound: 2 },
      sleep: NOOP_SLEEP,
    });
    const result = await agent.run('A公司研究', SCOPE);

    // P0 与第一个 P1 已充分 → P0 收敛门触发，第三个子问题预算外保持 pending
    expect(result.stats.stopReason).toBe('all_p0_sufficient');
    expect(result.stats.rounds).toBe(1);
    expect(result.verifications).toHaveLength(2);
    const pendingSq = result.plan.subQuestions[2]!;
    expect(pendingSq.status).toBe('pending');
    const thirdSection = result.report.sections.find((s) => s.subQuestionId === pendingSq.id)!;
    expect(thirdSection.status).toBe('not_verified');
    expect(result.report.limitations.join('\n')).toContain('未能完成验证');
  });

  it('致命错误：run() 拒绝并发出 run_error 事件', async () => {
    const search = new FakeSearch('primary', () => ({ hits: [] }));
    const llm = new FakeLLM([{ match: /研究规划专家/, handle: () => '抱歉，我无法输出 JSON' }]);
    const events: string[] = [];
    const agent = new ResearchOrchestrator({
      llm,
      adapters: [search],
      onEvent: (e) => events.push(e.type),
      sleep: NOOP_SLEEP,
    });

    await expect(agent.run('问题', SCOPE)).rejects.toThrow(/多次输出均不合规/);
    expect(events[0]).toBe('run_started');
    expect(events[events.length - 1]).toBe('run_error');
  });

  it('未决冲突：即使 consistency 非 insufficient 也触发补充检索，次轮解决', async () => {
    const search = new FakeSearch('primary', (call) => ({
      hits: [hit(call * 10 + 1), hit(call * 10 + 2)],
    }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            { question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收', '增速'] },
          ]),
      },
      extractionBehavior,
      {
        // 第 1 次验证：矛盾 + 未决冲突 + 低置信度（needsSupplement 但非 insufficient）
        match: /证据交叉验证专家/,
        handle: (prompt, call) => {
          const ids = extractEvidenceIds(prompt);
          if (call === 1) {
            return JSON.stringify({
              consistency: 'contradictory',
              verdict: '两来源数值矛盾且无法仲裁',
              confidence: 0.4,
              supportingEvidenceIds: ids,
              conflicts: [
                {
                  evidenceIds: [ids[0], ids[1]],
                  dimension: 'numeric',
                  description: '12% vs 9% 无权威口径',
                  resolution: 'unresolved',
                },
              ],
            });
          }
          return JSON.stringify({
            consistency: 'consistent',
            verdict: '已获得权威口径，证据相互印证',
            confidence: 0.85,
            supportingEvidenceIds: ids,
            conflicts: [],
          });
        },
      },
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({ llm, adapters: [search], sleep: NOOP_SLEEP });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    expect(result.stats.rounds).toBe(2);
    expect(result.stats.stopReason).toBe('all_p0_sufficient');
    expect(result.stats.supplementRounds).toBe(1);
    expect(result.evidence.length).toBeGreaterThanOrEqual(4);
  });

  it('复活失败：replan 评估 no_change 后以 no_pending_work 终止', async () => {
    const search = new FakeSearch('primary', (call) => ({
      hits: [hit(call * 10 + 1), hit(call * 10 + 2)],
    }));
    const llm = new FakeLLM([
      {
        match: /研究规划专家/,
        handle: () =>
          planResponse([
            { question: 'A公司2025年营收增速', priority: 'P0', keywords: ['营收', '增速'] },
          ]),
      },
      extractionBehavior,
      verifyBehavior({ consistency: 'insufficient', confidence: 0.3 }),
      noChangeReplanBehavior,
      synthesisBehavior,
    ]);

    const agent = new ResearchOrchestrator({
      llm,
      adapters: [search],
      // maxSupplementRounds=1：round1 后预算即耗尽 → 首轮终止门前即触发复活评估
      config: { maxRounds: 3, maxSupplementRoundsPerSubQuestion: 1 },
      sleep: NOOP_SLEEP,
    });
    const result = await agent.run('A公司2025年营收增速', SCOPE);

    expect(result.stats.rounds).toBe(1);
    expect(result.stats.stopReason).toBe('no_pending_work');
    expect(result.plan.version).toBe(1); // 复活评估为 no_change，版本不变
    expect(result.report.sections[0]!.status).toBe('blocked');
  });
});

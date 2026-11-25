/**
 * 编排器断点续跑（resume）语义
 * ----------------------------------------------------------------------------
 * 深度研究一次几十次 LLM 调用，断线续跑如果不真的复用已完成的计划 / 证据 /
 * 验证结论，那只是「换个说法的重跑」——钱照样烧两遍。本文件把三条硬承诺钉住：
 *   1. 续跑不再调用规划（计划已在断点里）；
 *   2. 已完成（sufficient）的子问题不再检索、不再验证；
 *   3. 已抓文档 / 已入库陈述不重复抓取（去重口径跨续跑一致）。
 * 另外钉住断点回调的时机（规划后一次、每轮结束后一次）与事件序号接续。
 */
import { describe, it, expect } from 'vitest';

import { ResearchOrchestrator, type ResearchResumeState } from '../index.js';
import type { AgentEvent, Evidence, ResearchPlan, RunStats, Verification } from '../types.js';
import type { LLMAdapter, LLMRequest } from '../llm.js';
import type { SearchAdapter, SearchHit } from '../search.js';

// ---------------------------------------------------------------- Fakes

interface Behavior {
  match: RegExp;
  handle: (prompt: string) => string;
  calls: number;
}

class FakeLLM implements LLMAdapter {
  readonly name = 'fake-llm';
  constructor(private readonly behaviors: Behavior[]) {}
  async complete(req: LLMRequest): Promise<string> {
    const behavior = this.behaviors.find((b) => b.match.test(req.prompt));
    if (!behavior) throw new Error(`FakeLLM 未匹配到行为脚本: ${req.prompt.slice(0, 60)}`);
    behavior.calls += 1;
    return behavior.handle(req.prompt);
  }
  /** 某一类行为被调用了几次 */
  callsFor(re: RegExp): number {
    return this.behaviors.find((b) => b.match === re)?.calls ?? 0;
  }
}

class FakeSearch implements SearchAdapter {
  readonly name = 'fake-search';
  readonly queries: string[] = [];
  constructor(private readonly hits: SearchHit[] = []) {}
  async search(q: { query: string }): Promise<SearchHit[]> {
    this.queries.push(q.query);
    return this.hits;
  }
  async fetch(url: string): Promise<{ url: string; title: string; text: string }> {
    return { url, title: `文档 ${url}`, text: `正文 ${url}` };
  }
}

const RE_PLAN = /研究规划专家/;
const RE_EXTRACT = /证据抽取专家/;
const RE_VERIFY = /证据交叉验证专家/;
const RE_SYNTH = /研究报告撰写专家/;

function behaviors(): Behavior[] {
  return [
    {
      match: RE_PLAN,
      calls: 0,
      handle: () =>
        JSON.stringify({
          subQuestions: [
            {
              question: '子问题一',
              priority: 'P0',
              keywords: ['关键词一'],
              expectedSources: ['news_media'],
              successCriteria: '有可核查数据',
            },
            {
              question: '子问题二',
              priority: 'P1',
              keywords: ['关键词二'],
              expectedSources: ['news_media'],
              successCriteria: '有可核查数据',
            },
          ],
        }),
    },
    {
      match: RE_EXTRACT,
      calls: 0,
      handle: (prompt) => {
        const title = prompt.match(/文档标题: (.*)/)?.[1]?.trim() ?? '未知';
        return JSON.stringify({
          items: [{ claim: `关于「${title}」的陈述`, quote: '原文', isRelevant: true }],
        });
      },
    },
    {
      match: RE_VERIFY,
      calls: 0,
      handle: (prompt) =>
        JSON.stringify({
          consistency: 'consistent',
          verdict: '证据一致',
          confidence: 0.9,
          supportingEvidenceIds: [
            ...new Set([...prompt.matchAll(/EV-[a-z0-9]+/g)].map((m) => m[0])),
          ],
          conflicts: [],
        }),
    },
    {
      match: RE_SYNTH,
      calls: 0,
      handle: (prompt) => {
        const sections = [...prompt.matchAll(/- \[(SQ-[a-z0-9]+)\][^\n]*/g)].map((m) => ({
          subQuestionId: m[1],
          conclusion: `结论 ${m[1]}`,
          keyEvidenceIds: [],
        }));
        return JSON.stringify({ title: '续跑报告', executiveSummary: '摘要', sections });
      },
    },
  ];
}

const NOOP_SLEEP = async () => {};

const hit = (n: number): SearchHit => ({
  title: `来源 ${n}`,
  url: `https://news.example.com/${n}`,
  publisher: `出版方${n}`,
  sourceType: 'news_media',
});

// ---------------------------------------------------------------- 断点状态构造

function makeResumeState(overrides: Partial<ResearchResumeState> = {}): ResearchResumeState {
  const plan: ResearchPlan = {
    id: 'plan-1',
    originalQuestion: '白酒行业竞争格局',
    scope: {},
    subQuestions: [
      {
        id: 'sq-1',
        question: '子问题一',
        priority: 'P0',
        keywords: ['关键词一'],
        expectedSources: ['news_media'],
        successCriteria: '有可核查数据',
        status: 'sufficient',
        supplementRoundsUsed: 0,
        supplementHints: [],
      },
      {
        id: 'sq-2',
        question: '子问题二',
        priority: 'P1',
        keywords: ['关键词二'],
        expectedSources: ['news_media'],
        successCriteria: '有可核查数据',
        status: 'pending',
        supplementRoundsUsed: 0,
        supplementHints: [],
      },
    ],
    version: 1,
    revisions: [],
    createdAt: '2026-11-18T01:00:00.000Z',
    updatedAt: '2026-11-18T01:00:00.000Z',
  };
  const evidence: Evidence[] = [
    {
      id: 'EV-old1',
      subQuestionId: 'sq-1',
      claim: '已完成的旧陈述',
      quote: '旧原文',
      source: {
        type: 'news_media',
        title: '旧来源',
        url: 'https://news.example.com/1',
        retrievedVia: 'fake-search',
      },
      path: { round: 1, query: '关键词一', adapter: 'fake-search', attempt: 1 },
      credibility: 0.7,
      retrievedAt: '2026-11-18T01:01:00.000Z',
    },
  ];
  const verifications: Verification[] = [
    {
      subQuestionId: 'sq-1',
      consistency: 'consistent',
      verdict: '旧结论',
      confidence: 0.8,
      supportingEvidenceIds: ['EV-old1'],
      conflicts: [],
      needsSupplement: false,
      supplementHints: [],
      checkedAt: '2026-11-18T01:02:00.000Z',
    },
  ];
  const stats: RunStats = {
    rounds: 1,
    totalRetrievalTasks: 2,
    succeededTasks: 2,
    failedTasks: 0,
    fallbacksUsed: 0,
    evidenceCount: 1,
    conflictsFound: 0,
    supplementRounds: 0,
    planVersions: 1,
    startedAt: '2026-11-18T01:00:00.000Z',
  };
  const events: AgentEvent[] = [
    { seq: 5, type: 'run_started', round: 0, at: '2026-11-18T01:00:00.000Z', message: '旧事件' },
    { seq: 6, type: 'plan_created', round: 1, at: '2026-11-18T01:00:01.000Z', message: '旧计划' },
  ];
  return {
    plan,
    evidence,
    verifications,
    events,
    stats,
    roundsCompleted: 1,
    consecutiveNoProgress: 0,
    failedTasks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------- 用例

describe('编排器续跑', () => {
  it('复用计划与已验证子问题：不重规划、不重复检索/验证已完成子问题', async () => {
    const llm = new FakeLLM(behaviors());
    // 断点里旧证据占用了 news.example.com/1；sq-2 再命中它时不该重复抓取/抽取
    const search = new FakeSearch([hit(1), hit(2), hit(3)]);
    const snapshots: { roundsCompleted: number }[] = [];

    const orch = new ResearchOrchestrator({
      llm,
      adapters: [search],
      sleep: NOOP_SLEEP,
      config: { maxRounds: 2 },
      resume: makeResumeState(),
      onCheckpoint: (snapshot) => snapshots.push({ roundsCompleted: snapshot.roundsCompleted }),
    });

    const result = await orch.run('白酒行业竞争格局');

    // 1) 没有第二次规划：计划沿用的版本与旧计划一致
    expect(llm.callsFor(RE_PLAN)).toBe(0);
    expect(result.plan.id).toBe('plan-1');

    // 2) 只对 sq-2 检索与验证（sq-1 已 sufficient，不再消费 LLM）
    expect(search.queries).toHaveLength(1);
    expect(search.queries[0]).toContain('关键词二');
    expect(llm.callsFor(RE_VERIFY)).toBe(1);
    // 旧 URL 已见 → 只抓/抽取 hit(2) 与 hit(3) 这两篇
    expect(llm.callsFor(RE_EXTRACT)).toBe(2);

    // 3) 旧证据与旧验证都被保留，新证据追加
    expect(result.evidence.some((e) => e.id === 'EV-old1')).toBe(true);
    expect(result.evidence).toHaveLength(3);
    expect(result.verifications.find((v) => v.subQuestionId === 'sq-1')!.verdict).toBe('旧结论');
    expect(result.verifications.find((v) => v.subQuestionId === 'sq-2')).toBeTruthy();

    // 4) 轮次从第 2 轮继续，统计沿用 startedAt 且累加
    expect(result.stats.rounds).toBe(2);
    expect(result.stats.startedAt).toBe('2026-11-18T01:00:00.000Z');
    expect(result.stats.totalRetrievalTasks).toBe(3);

    // 5) 事件序号接续旧事件，不从头开始
    expect(result.events[0].seq).toBe(5);
    expect(result.events.some((e) => e.message.includes('续跑'))).toBe(true);
    const newEvents = result.events.filter((e) => e.seq > 6);
    expect(newEvents.length).toBeGreaterThan(0);

    // 6) 每轮结束落一次断点（本轮完成后 roundsCompleted=2）
    expect(snapshots.at(-1)!.roundsCompleted).toBe(2);
  });

  it('断点已到轮次上限：零次检索/规划，只重跑结论编排', async () => {
    const llm = new FakeLLM(behaviors());
    const search = new FakeSearch([hit(9)]);
    const orch = new ResearchOrchestrator({
      llm,
      adapters: [search],
      sleep: NOOP_SLEEP,
      config: { maxRounds: 1 },
      resume: makeResumeState(),
    });

    const result = await orch.run('白酒行业竞争格局');

    expect(llm.callsFor(RE_PLAN)).toBe(0);
    expect(llm.callsFor(RE_VERIFY)).toBe(0);
    expect(llm.callsFor(RE_EXTRACT)).toBe(0);
    expect(search.queries).toHaveLength(0);
    expect(llm.callsFor(RE_SYNTH)).toBe(1);
    expect(result.stats.rounds).toBe(1);
    expect(result.report.title).toBe('续跑报告');
  });

  it('新建研究在「规划完成」与「每轮结束」各落一次断点（中断后计划可复用）', async () => {
    const llm = new FakeLLM(behaviors());
    const snapshots: { roundsCompleted: number; hasPlan: boolean }[] = [];
    const orch = new ResearchOrchestrator({
      llm,
      adapters: [new FakeSearch([hit(1)])],
      sleep: NOOP_SLEEP,
      config: { maxRounds: 1 },
      onCheckpoint: (snapshot) =>
        snapshots.push({
          roundsCompleted: snapshot.roundsCompleted,
          hasPlan: Boolean(snapshot.plan),
        }),
    });

    await orch.run('白酒行业竞争格局');

    expect(snapshots[0]).toEqual({ roundsCompleted: 0, hasPlan: true });
    expect(snapshots.at(-1)!.roundsCompleted).toBe(1);
  });
});

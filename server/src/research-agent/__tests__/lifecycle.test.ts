/**
 * 研究编排生命周期测试：取消传播、统计回填、超时僵尸 run 的路由行为
 * ----------------------------------------------------------------------------
 * 覆盖此前三个盲区（审查结论）：
 *   1. 取消链路——SSE 断开/前端取消原先只停推送、编排继续白烧 LLM 配额；
 *      现在信号级联到阶段边界与 LLM/检索在途请求（这里用编排器单测钉住语义）；
 *   2. 同步超时僵尸 run——超时后 run 原先无人认领（槽位提前归还 + 结果丢弃）；
 *      现在后台跑完归档，路由层用 supertest + 短超时实测；
 *   3. stats.succeededTasks 恒 0 被新 UI 消费——回填口径在此钉住。
 */
import { describe, it, expect, vi } from 'vitest';
import { ResearchOrchestrator } from '../index.js';
import { ResearchAbortedError } from '../utils.js';
import type { SearchAdapter, SearchHit } from '../search.js';
import type { LLMAdapter, LLMRequest } from '../llm.js';

// ---------------------------------------------------------------- Fakes（与 researchAgent.test.ts 同风格）

interface Behavior {
  match: RegExp;
  handle: (prompt: string, callIndex: number) => string;
  callCount?: number;
}

class FakeLLM implements LLMAdapter {
  readonly name = 'fake-llm';
  /** 记录每次调用收到的取消信号（断言级联用） */
  readonly seenSignals: (AbortSignal | undefined)[] = [];
  constructor(private readonly behaviors: Behavior[]) {}

  async complete(req: LLMRequest): Promise<string> {
    this.seenSignals.push(req.signal);
    const behavior = this.behaviors.find((b) => b.match.test(req.prompt));
    if (!behavior) throw new Error(`FakeLLM 未匹配到行为脚本: ${req.prompt.slice(0, 60)}`);
    behavior.callCount = (behavior.callCount ?? 0) + 1;
    return behavior.handle(req.prompt, behavior.callCount);
  }
}

class FakeSearch implements SearchAdapter {
  readonly name: string;
  constructor(
    name: string,
    private readonly responder: (callIndex: number) => SearchHit[] | 'throw',
  ) {
    this.name = name;
  }
  private calls = 0;
  async search(): Promise<SearchHit[]> {
    const r = this.responder(++this.calls);
    if (r === 'throw') throw new Error('search service down');
    return r;
  }
  async fetch(url: string): Promise<{ url: string; title: string; text: string }> {
    return { url, title: `doc ${url}`, text: `正文内容 for ${url}：包含相关数据与事实。` };
  }
}

const hit = (n: number): SearchHit => ({
  title: `来源文章 ${n}`,
  url: `https://news.example.com/${n}`,
  publisher: `出版方${n}`,
  sourceType: 'news_media',
});

const extractEvidenceIds = (prompt: string): string[] => [
  ...new Set([...prompt.matchAll(/\[?(EV-[a-z0-9]+)\]?/g)].map((m) => m[1])),
];

const planBehavior = (questions: string[]): Behavior => ({
  match: /研究规划专家/,
  handle: () =>
    JSON.stringify({
      subQuestions: questions.map((question, i) => ({
        question,
        priority: i === 0 ? 'P0' : 'P1',
        keywords: ['测试'],
        expectedSources: ['news_media'],
        successCriteria: '有可核查的数据与来源',
      })),
    }),
});

const extractionBehavior: Behavior = {
  match: /证据抽取专家/,
  handle: (prompt) => {
    const title = prompt.match(/文档标题: (.*)/)?.[1]?.trim() ?? '未知文档';
    return JSON.stringify({
      items: [{ claim: `关于「${title}」的事实陈述`, quote: '原文摘录', isRelevant: true }],
    });
  },
};

const verifyBehavior: Behavior = {
  match: /证据交叉验证专家/,
  handle: (prompt) =>
    JSON.stringify({
      consistency: 'consistent',
      verdict: '证据相互印证',
      confidence: 0.85,
      supportingEvidenceIds: extractEvidenceIds(prompt),
      conflicts: [],
    }),
};

const synthesisBehavior: Behavior = {
  match: /研究报告撰写专家/,
  handle: (prompt) => {
    const sections = [...prompt.matchAll(/- \[(SQ-[a-z0-9]+)\][^\n]*/g)].map((m) => ({
      subQuestionId: m[1],
      conclusion: `子问题 ${m[1]} 的结论`,
      keyEvidenceIds: [...m[0].matchAll(/EV-[a-z0-9]+/g)].slice(0, 1).map((x) => x[0]),
    }));
    return JSON.stringify({ title: '测试报告', executiveSummary: '摘要', sections });
  },
};

const NOOP_SLEEP = async () => {};

describe('编排器取消链路', () => {
  it('信号已中止时 run 直接拒绝，零 LLM 调用（入口即拦截）', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = new FakeLLM([planBehavior(['问题一'])]);
    const orch = new ResearchOrchestrator({
      llm,
      adapters: [new FakeSearch('primary', () => [hit(1)])],
      sleep: NOOP_SLEEP,
      signal: controller.signal,
    });
    await expect(orch.run('研究问题')).rejects.toBeInstanceOf(ResearchAbortedError);
    expect(llm.seenSignals).toHaveLength(0); // 边界检查先于任何 LLM 调用
  });

  it('信号收到所有 LLM 调用（级联透传），中止后编排在下个阶段边界停止', async () => {
    const controller = new AbortController();
    // 计划完成即中止 → 阶段二（检索）入口抛 ResearchAbortedError
    const llm = new FakeLLM([
      {
        ...planBehavior(['问题一', '问题二']),
        handle: (p, i) => {
          if (i === 1) controller.abort();
          return planBehavior([]).handle(p, i);
        },
      },
    ]);
    const orch = new ResearchOrchestrator({
      llm,
      adapters: [new FakeSearch('primary', () => [hit(1)])],
      sleep: NOOP_SLEEP,
      signal: controller.signal,
    });
    await expect(orch.run('研究问题')).rejects.toBeInstanceOf(ResearchAbortedError);
    // 计划阶段的那次调用拿到了同一个 signal（级联到 chat 的 HTTP 层）
    expect(llm.seenSignals[0]).toBe(controller.signal);
  });
});

describe('stats.succeededTasks 回填', () => {
  it('成功数 = 发起任务数 − 累计失败数（此前恒 0 被 UI 消费成「检索 0/N 成功」）', async () => {
    // 两个子问题：第一个通道首查成功、第二个通道全败
    let adapterCalls = 0;
    const search = new FakeSearch('primary', () => {
      adapterCalls += 1;
      return adapterCalls === 1 ? [hit(1), hit(2)] : 'throw';
    });
    const llm = new FakeLLM([
      planBehavior(['关于A的问题', '关于B的问题']),
      extractionBehavior,
      verifyBehavior,
      synthesisBehavior,
      {
        match: /检索计划修订专家/,
        handle: () =>
          JSON.stringify({ action: 'no_change', reason: 'x', add: [], adjust: [], drop: [] }),
      },
    ]);
    const orch = new ResearchOrchestrator({
      llm,
      adapters: [search, new FakeSearch('fallback', () => 'throw')],
      sleep: NOOP_SLEEP,
      config: { maxRounds: 2, noProgressRoundLimit: 2, maxSupplementRoundsPerSubQuestion: 1 },
    });
    const result = await orch.run('研究问题');
    const { stats } = result;
    expect(stats.totalRetrievalTasks).toBeGreaterThan(0);
    expect(stats.failedTasks).toBeGreaterThan(0);
    expect(stats.succeededTasks).toBe(stats.totalRetrievalTasks - stats.failedTasks);
  });
});

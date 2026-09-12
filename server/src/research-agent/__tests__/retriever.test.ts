/**
 * retriever 专项单元测试：查询词轮换、来源类型推断、去重、预算截断、
 * fetch 容错、时效衰减 —— 覆盖 e2e 用例难以触达的分支。
 */
import { describe, it, expect } from 'vitest';
import { EvidenceRetriever } from '../retriever.js';
import type { LLMAdapter, LLMRequest } from '../llm.js';
import type { SearchAdapter, SearchHit } from '../search.js';
import type { AgentEventEmitter, ResearchConfig, ResearchPlan, SubQuestion } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import { newId } from '../utils.js';

// ---------------------------------------------------------------- Fakes

class FakeLLM implements LLMAdapter {
  readonly name = 'fake-llm';
  calls = 0;
  constructor(private readonly handler: (prompt: string, call: number) => string) {}
  async complete(req: LLMRequest): Promise<string> {
    this.calls += 1;
    return this.handler(req.prompt, this.calls);
  }
}

/** 抽取脚本：默认每文档产出一条相关证据；标题含 skip 视为无关 */
const extractionHandler =
  (claimOf?: (title: string) => string) =>
  (prompt: string): string => {
    const title = prompt.match(/文档标题: (.*)/)?.[1]?.trim() ?? 'doc';
    if (title.includes('skip')) {
      return JSON.stringify({ items: [{ claim: 'x', quote: 'y', isRelevant: false }] });
    }
    const claim = claimOf ? claimOf(title) : `陈述-${title}`;
    return JSON.stringify({ items: [{ claim, quote: '原文摘录', isRelevant: true }] });
  };

interface FakeFetch {
  title?: string;
  text?: string;
  publishedAt?: string;
  throwOnFetch?: boolean;
}

class FakeSearch implements SearchAdapter {
  readonly name = 'primary';
  calls = 0;
  constructor(
    private readonly hitsFn: (call: number) => SearchHit[],
    private readonly fetchFn?: (url: string) => FakeFetch,
  ) {}
  async search(): Promise<SearchHit[]> {
    this.calls += 1;
    return this.hitsFn(this.calls);
  }
  async fetch(
    url: string,
  ): Promise<{ url: string; title: string; text: string; publishedAt?: string }> {
    const r = this.fetchFn?.(url) ?? { title: `doc ${url}`, text: '正文内容' };
    if (r.throwOnFetch) throw new Error('fetch blocked');
    return { url, title: r.title ?? '', text: r.text ?? '正文内容', publishedAt: r.publishedAt };
  }
}

const emit: AgentEventEmitter = () => {};
const cfg: ResearchConfig = { ...DEFAULT_CONFIG, retryBackoffMs: 0 };

const makeSq = (overrides?: Partial<SubQuestion>): SubQuestion => ({
  id: 'SQ-1',
  question: 'Q1',
  priority: 'P0',
  keywords: ['a', 'b', 'c', 'd', 'e'],
  expectedSources: ['news_media'],
  successCriteria: 'x',
  status: 'pending',
  supplementRoundsUsed: 0,
  supplementHints: [],
  ...overrides,
});

const makePlan = (sq: SubQuestion): ResearchPlan => ({
  id: newId('PLAN'),
  originalQuestion: 'Q',
  scope: {},
  subQuestions: [sq],
  version: 1,
  revisions: [],
  createdAt: '',
  updatedAt: '',
});

const hit = (n: number, overrides?: Partial<SearchHit>): SearchHit => ({
  title: `来源 ${n}`,
  url: `https://site${n}.example.com/${n}`,
  publisher: `出版方${n}`,
  ...overrides,
});

// ---------------------------------------------------------------- buildQuery

describe('EvidenceRetriever.buildQuery 查询词轮换', () => {
  const retriever = new EvidenceRetriever(
    new FakeLLM(extractionHandler()),
    [],
    cfg,
    emit,
    async () => {},
  );

  it('round 1 直接使用计划关键词前 4 个', () => {
    expect(retriever.buildQuery(makeSq(), 1)).toBe('a b c d');
  });

  it('无 hints 时按轮次轮换关键词组合', () => {
    const sq = makeSq();
    expect(retriever.buildQuery(sq, 2)).toBe('b c d e');
    expect(retriever.buildQuery(sq, 3)).toBe('c d e a');
  });

  it('有 hints 时逐轮消费补充方向，用尽后循环', () => {
    const sq = makeSq({ supplementHints: ['h1', 'h2'] });
    expect(retriever.buildQuery(sq, 2)).toBe('h1');
    expect(retriever.buildQuery(sq, 3)).toBe('h2');
    expect(retriever.buildQuery(sq, 4)).toBe('h1');
  });
});

// ---------------------------------------------------------------- collect

describe('EvidenceRetriever.collect 取证行为', () => {
  it('来源类型：搜索渠道标注优先于域名推断', async () => {
    const search = new FakeSearch(() => [
      hit(1, { url: 'https://www.sse.com.cn/a', sourceType: undefined }),
      hit(2, { url: 'https://v2ex.com/t/1', sourceType: undefined }),
      hit(3, { url: 'https://random.example.com/3', sourceType: 'company_disclosure' }),
    ]);
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler()),
      [search],
      cfg,
      emit,
      async () => {},
    );
    const { evidence } = await retriever.collect(makePlan(makeSq()), 1);

    const byUrl = new Map(evidence.map((e) => [e.source.url, e.source.type]));
    expect(byUrl.get('https://www.sse.com.cn/a')).toBe('regulatory_filing');
    expect(byUrl.get('https://v2ex.com/t/1')).toBe('social_ugc');
    expect(byUrl.get('https://random.example.com/3')).toBe('company_disclosure');
  });

  it('URL 与 claim 双重去重', async () => {
    const search = new FakeSearch(() => [hit(1), hit(2)]);
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler(() => '完全相同的陈述')),
      [search],
      cfg,
      emit,
      async () => {},
    );
    const plan = makePlan(makeSq());
    const round1 = await retriever.collect(plan, 1);
    expect(round1.evidence.length).toBe(1); // 两个 URL，但 claim 相同 → 1 条
    const round2 = await retriever.collect(plan, 2);
    expect(round2.evidence).toHaveLength(0); // URL 已见 → 0 条
  });

  it('maxDocsPerQuery 截断每轮抓取数量', async () => {
    const search = new FakeSearch(() => [hit(1), hit(2), hit(3)]);
    const localCfg: ResearchConfig = { ...cfg, maxDocsPerQuery: 2 };
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler()),
      [search],
      localCfg,
      emit,
      async () => {},
    );
    const { evidence } = await retriever.collect(makePlan(makeSq()), 1);
    expect(evidence).toHaveLength(2);
  });

  it('fetch 失败只跳过命中，不计入检索任务失败', async () => {
    const search = new FakeSearch(
      () => [hit(1)],
      () => ({ throwOnFetch: true }),
    );
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler()),
      [search],
      cfg,
      emit,
      async () => {},
    );
    const { evidence, touched } = await retriever.collect(makePlan(makeSq()), 1);
    expect(evidence).toHaveLength(0);
    expect(touched.size).toBe(0);
    expect(retriever.failedTasks).toHaveLength(0);
  });

  it('isRelevant=false 的抽取结果被过滤', async () => {
    const search = new FakeSearch(
      () => [hit(9)],
      () => ({ title: 'skip this doc' }),
    );
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler()),
      [search],
      cfg,
      emit,
      async () => {},
    );
    const { evidence } = await retriever.collect(makePlan(makeSq()), 1);
    expect(evidence).toHaveLength(0);
  });

  it('doc title 缺失回退 hit title；过期来源按时效衰减可信度', async () => {
    const old = new Date(Date.now() - 3000 * 86_400_000).toISOString();
    const search = new FakeSearch(
      () => [hit(1)],
      () => ({ title: '', publishedAt: old }),
    );
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler()),
      [search],
      cfg,
      emit,
      async () => {},
    );
    const { evidence } = await retriever.collect(makePlan(makeSq()), 1);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.source.title).toBe('来源 1'); // doc title 空 → hit title 兜底
    expect(evidence[0]!.source.publishedAt).toBe(old);
    // news_media 基准 0.7 x 衰减下限 0.3 = 0.21
    expect(evidence[0]!.credibility).toBeCloseTo(0.21, 5);
  });

  it('全部通道失败：记入 failedTasks，后续 replan 可感知', async () => {
    class DeadSearch implements SearchAdapter {
      readonly name = 'dead';
      async search(): Promise<SearchHit[]> {
        throw new Error('down');
      }
      async fetch(): Promise<{ url: string; title: string; text: string }> {
        throw new Error('down');
      }
    }
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler()),
      [new DeadSearch()],
      { ...cfg, maxRetrievalAttempts: 1 },
      emit,
      async () => {},
    );
    const { evidence, attempted } = await retriever.collect(makePlan(makeSq()), 1);
    expect(evidence).toHaveLength(0);
    expect(attempted.size).toBe(1);
    expect(retriever.failedTasks).toHaveLength(1);
    expect(retriever.failedTasks[0]!.adaptersTried).toEqual(['dead']);
  });

  it('来源类型域名推断覆盖各分类，无法解析的 URL 兜底 unknown', async () => {
    const cases: [string, string][] = [
      ['https://www.wind.com.cn/x', 'financial_database'],
      ['https://arxiv.org/abs/1', 'academic'],
      ['https://www.caixin.com/2026/x', 'news_media'],
      ['https://blog.csdn.net/post/1', 'blog'],
      ['not-a-valid-url', 'unknown'],
    ];
    const search = new FakeSearch(() => cases.map(([url], i) => hit(i + 1, { url })));
    const localCfg: ResearchConfig = { ...cfg, maxDocsPerQuery: 8 }; // 5 个域名全量抓取
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler()),
      [search],
      localCfg,
      emit,
      async () => {},
    );
    const { evidence } = await retriever.collect(makePlan(makeSq()), 1);
    const byUrl = new Map(evidence.map((e) => [e.source.url, e.source.type]));
    for (const [url, expected] of cases) {
      expect(byUrl.get(url)).toBe(expected);
    }
  });

  it('空 claim / 空 quote 的抽取结果被过滤', async () => {
    const search = new FakeSearch(() => [hit(1)]);
    const llm = new FakeLLM(() =>
      JSON.stringify({
        items: [
          { claim: '', quote: '有引文', isRelevant: true },
          { claim: '有陈述', quote: '', isRelevant: true },
          { claim: '有效陈述', quote: '有效引文', isRelevant: true },
        ],
      }),
    );
    const retriever = new EvidenceRetriever(llm, [search], cfg, emit, async () => {});
    const { evidence } = await retriever.collect(makePlan(makeSq()), 1);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.claim).toBe('有效陈述');
  });

  it('supplementHints 为空字符串时回退到关键词组合', () => {
    const retriever = new EvidenceRetriever(
      new FakeLLM(extractionHandler()),
      [],
      cfg,
      emit,
      async () => {},
    );
    const sq = makeSq({ supplementHints: [''] });
    expect(retriever.buildQuery(sq, 2)).toBe('a b c d');
  });
});

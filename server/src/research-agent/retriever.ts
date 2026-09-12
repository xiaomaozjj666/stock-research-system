/**
 * 阶段二：检索（Retriever）
 * ------------------------------------------------------------------
 * 按检索计划逐子问题收集证据。每个检索任务的状态机：
 *   主适配器尝试 -> 失败退避重试 -> 降级到备用适配器 -> 全部失败记为 failed
 * 每一步都写入 AcquisitionPath（第几轮 / 查询词 / 适配器 / 第几次尝试 / 降级来源），
 * 保证任何一条证据都可审计、可复现。
 *
 * 去重：URL 级（整轮运行内不重复抓取）+ 陈述级（同 claim 不重复入库）。
 * 可信度：来源层级基准分 x 时效衰减，与 LLM 自评解耦。
 */
import type {
  AgentEventEmitter,
  Evidence,
  ResearchPlan,
  SourceType,
  SubQuestion,
} from './types.js';
import { SOURCE_TIER } from './types.js';
import type { ResearchConfig } from './types.js';
import type { LLMAdapter } from './llm.js';
import { completeJson } from './llm.js';
import type { FetchedDoc, SearchAdapter, SearchHit } from './search.js';
import { clamp01, newId, recencyDecay } from './utils.js';

interface ExtractionResult {
  items: { claim: string; quote: string; isRelevant: boolean }[];
}

const EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    items: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          claim: { type: 'string' as const },
          quote: { type: 'string' as const },
          isRelevant: { type: 'boolean' as const },
        },
        required: ['claim', 'quote', 'isRelevant'],
      },
    },
  },
  required: ['items'],
};

/** 跨轮次记录的失败任务，供 replan 决策使用 */
export interface FailedTask {
  subQuestionId: string;
  query: string;
  adaptersTried: string[];
  detail: string;
}

/** 一次成功搜索的完整出处：写入每条证据的 AcquisitionPath */
interface SearchOutcome {
  hits: SearchHit[];
  /** 实际命中的适配器实例：后续正文抓取必须走同一通道 */
  adapter: SearchAdapter;
  attempt: number;
  fallbackOf?: string;
}

export class EvidenceRetriever {
  private readonly seenUrls = new Set<string>();
  private readonly seenClaims = new Set<string>();
  readonly failedTasks: FailedTask[] = [];
  fallbacksUsed = 0;

  constructor(
    private readonly llm: LLMAdapter,
    private readonly adapters: SearchAdapter[],
    private readonly config: ResearchConfig,
    private readonly emit: AgentEventEmitter,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * 执行一轮检索：只处理 pending / 仍可补充的 insufficient 子问题。
   * 调度按 supplementRoundsUsed 升序（同序按计划顺序），保证预算截断时
   * 最久未获证据的子问题优先执行，避免尾部子问题被永久饥饿。
   * 返回本轮新收集的证据、成功取证的子问题集合（touched）
   * 与本轮实际发起过任务的子问题集合（attempted，含检索失败者）。
   */
  async collect(
    plan: ResearchPlan,
    round: number,
  ): Promise<{ evidence: Evidence[]; touched: Set<string>; attempted: Set<string> }> {
    const evidence: Evidence[] = [];
    const touched = new Set<string>();
    const attempted = new Set<string>();

    const order = plan.subQuestions
      .map((sq, idx) => ({ sq, idx }))
      .filter(({ sq }) => this.isActionable(sq))
      .sort((a, b) => a.sq.supplementRoundsUsed - b.sq.supplementRoundsUsed || a.idx - b.idx);

    let taskCount = 0;
    for (const { sq } of order) {
      if (taskCount >= this.config.maxRetrievalTasksPerRound) break;
      taskCount += 1;
      attempted.add(sq.id);

      sq.status = 'retrieving';
      const query = this.buildQuery(sq, round);
      this.emit('retrieval_started', `开始检索 [${sq.id}] ${sq.question}`, {
        subQuestionId: sq.id,
        query,
      });

      const outcome = await this.searchWithFallback(sq, query, round);
      if (outcome.hits.length === 0) continue;

      let collectedForSq = 0;
      for (const hit of outcome.hits) {
        if (collectedForSq >= this.config.maxDocsPerQuery) break;
        if (this.seenUrls.has(hit.url)) continue;
        this.seenUrls.add(hit.url);

        const doc = await this.fetchDoc(sq, hit, outcome.adapter);
        if (!doc) continue;

        const extracted = await this.extractEvidence(sq, doc, hit, {
          round,
          query,
          adapterName: outcome.adapter.name,
          attempt: outcome.attempt,
          fallbackOf: outcome.fallbackOf,
        });
        for (const ev of extracted) {
          evidence.push(ev);
          collectedForSq += 1;
          touched.add(sq.id);
        }
      }
    }
    return { evidence, touched, attempted };
  }

  /** pending 永远可执行；insufficient 受补充轮次上限约束 */
  private isActionable(sq: SubQuestion): boolean {
    if (sq.status === 'pending' || sq.status === 'retrieving') return true;
    if (sq.status === 'insufficient') {
      return sq.supplementRoundsUsed < this.config.maxSupplementRoundsPerSubQuestion;
    }
    return false;
  }

  /**
   * 查询词构造：
   * - round 1: 直接使用计划关键词（前 4 个拼接）；
   * - round 2+: 优先消费验证阶段给出的 supplementHints（逐个轮换），
   *   无提示时轮换计划关键词的组合顺序。
   */
  buildQuery(sq: SubQuestion, round: number): string {
    if (round === 1 || sq.supplementHints.length === 0) {
      const rotate = (round - 1) % Math.max(1, sq.keywords.length);
      const rotated = [...sq.keywords.slice(rotate), ...sq.keywords.slice(0, rotate)];
      return rotated.slice(0, 4).join(' ');
    }
    const hint = sq.supplementHints[(round - 2) % sq.supplementHints.length];
    return hint || sq.keywords.slice(0, 4).join(' ');
  }

  /** 带退避重试与适配器降级的搜索；全部失败时记录 failedTask 并返回空 */
  private async searchWithFallback(
    sq: SubQuestion,
    query: string,
    round: number,
  ): Promise<SearchOutcome> {
    const adaptersTried: string[] = [];
    let firstAdapter: string | null = null;

    for (const adapter of this.adapters) {
      adaptersTried.push(adapter.name);
      for (let attempt = 1; attempt <= this.config.maxRetrievalAttempts; attempt++) {
        try {
          const hits = await adapter.search({ query, maxResults: this.config.resultsPerQuery });
          if (firstAdapter && firstAdapter !== adapter.name) {
            this.fallbacksUsed += 1;
            this.emit(
              'retrieval_fallback',
              `检索降级: ${firstAdapter} 失败，改用 ${adapter.name}`,
              {
                subQuestionId: sq.id,
                query,
                from: firstAdapter,
                to: adapter.name,
              },
            );
          }
          this.emit('retrieval_succeeded', `检索成功 [${sq.id}]: 命中 ${hits.length} 条`, {
            subQuestionId: sq.id,
            query,
            adapter: adapter.name,
            attempt,
            hits: hits.length,
          });
          return {
            hits,
            adapter,
            attempt,
            fallbackOf: firstAdapter ?? undefined,
          };
        } catch (err) {
          const detail = `适配器 ${adapter.name} 第 ${attempt} 次尝试失败: ${(err as Error).message}`;
          this.emit('retrieval_failed', `检索失败 [${sq.id}]: ${detail}`, {
            subQuestionId: sq.id,
            query,
            adapter: adapter.name,
            attempt,
            round,
          });
          if (attempt < this.config.maxRetrievalAttempts) {
            await this.sleep(this.config.retryBackoffMs * attempt);
          }
        }
      }
      if (!firstAdapter) firstAdapter = adapter.name;
    }

    this.failedTasks.push({
      subQuestionId: sq.id,
      query,
      adaptersTried,
      detail: `所有检索通道均失败（${adaptersTried.join(' -> ')}）`,
    });
    this.emit('retrieval_failed', `检索任务彻底失败 [${sq.id}]: 所有通道均不可用`, {
      subQuestionId: sq.id,
      query,
      adaptersTried,
      round,
    });
    return { hits: [], adapter: this.adapters[0]!, attempt: 0 };
  }

  /** 抓取正文；走搜索实际命中的适配器通道；失败只跳过该条命中，不计为任务失败 */
  private async fetchDoc(
    sq: SubQuestion,
    hit: SearchHit,
    adapter: SearchAdapter,
  ): Promise<FetchedDoc | null> {
    try {
      const doc = await adapter.fetch(hit.url);
      return {
        ...doc,
        title: doc.title || hit.title,
        publishedAt: doc.publishedAt ?? hit.publishedAt,
      };
    } catch (err) {
      this.emit(
        'retrieval_failed',
        `正文抓取失败 [${sq.id}]: ${hit.url} (${(err as Error).message})`,
        {
          subQuestionId: sq.id,
          url: hit.url,
        },
      );
      return null;
    }
  }

  /** 从文档中抽取与子问题相关的证据陈述 */
  private async extractEvidence(
    sq: SubQuestion,
    doc: FetchedDoc,
    hit: SearchHit,
    path: {
      round: number;
      query: string;
      adapterName: string;
      attempt: number;
      fallbackOf?: string;
    },
  ): Promise<Evidence[]> {
    const truncated = doc.text.slice(0, 6000);
    let result: ExtractionResult;
    try {
      result = await completeJson<ExtractionResult>(this.llm, {
        prompt: [
          '你是证据抽取专家。从下面的文档中抽取与子问题相关的事实性陈述。',
          '',
          `子问题: ${sq.question}`,
          `成功判据: ${sq.successCriteria}`,
          `文档标题: ${doc.title}`,
          '文档正文（截断）:',
          truncated,
          '',
          '要求:',
          '1. 每条证据是一个独立、可核查的事实性陈述（claim）；',
          '2. quote 摘录支撑该陈述的原文片段（200 字以内）；',
          '3. 与子问题无关的内容 isRelevant=false 或直接不输出；',
          '4. 最多输出 3 条。',
          '只输出 JSON: {"items":[{"claim","quote","isRelevant"}]}',
        ].join('\n'),
        schema: EXTRACTION_SCHEMA,
        label: `证据抽取[${sq.id}]`,
        maxRetries: 1,
        system: '你是严谨的研究助理，只输出符合要求的 JSON。',
      });
    } catch (err) {
      this.emit('retrieval_failed', `证据抽取失败 [${sq.id}]: ${(err as Error).message}`, {
        subQuestionId: sq.id,
        url: doc.url,
      });
      return [];
    }

    const evidence: Evidence[] = [];
    const sourceType: SourceType = hit.sourceType ?? this.inferSourceType(doc.url);
    for (const item of result.items) {
      if (!item.isRelevant) continue;
      const claim = String(item.claim ?? '').trim();
      const quote = String(item.quote ?? '')
        .trim()
        .slice(0, 200);
      if (!claim || !quote) continue;
      const claimKey = claim.toLowerCase();
      if (this.seenClaims.has(claimKey)) continue;
      this.seenClaims.add(claimKey);

      // 可信度 = 来源层级基准分 x 时效衰减；来源类型优先用搜索渠道标注
      const base = SOURCE_TIER[sourceType].baseCredibility;
      const credibility = clamp01(base * recencyDecay(doc.publishedAt));
      const ev: Evidence = {
        id: newId('EV'),
        subQuestionId: sq.id,
        claim,
        quote,
        source: {
          type: sourceType,
          title: doc.title,
          url: doc.url,
          publisher: hit.publisher,
          publishedAt: doc.publishedAt,
          retrievedVia: path.adapterName,
        },
        path: {
          round: path.round,
          query: path.query,
          adapter: path.adapterName,
          attempt: path.attempt,
          fallbackOf: path.fallbackOf,
        },
        credibility,
        retrievedAt: new Date().toISOString(),
      };
      evidence.push(ev);
      this.emit('evidence_extracted', `抽取证据 ${ev.id} [${sq.id}]: ${claim.slice(0, 50)}`, {
        subQuestionId: sq.id,
        evidenceId: ev.id,
        credibility: Math.round(ev.credibility * 100) / 100,
      });
    }
    return evidence;
  }

  /** 从 URL 域名启发式推断来源类型；搜索渠道已标注时优用标注值 */
  private inferSourceType(url: string): SourceType {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return 'unknown';
    }
    if (/(^|\.)gov(\.cn)?$|sse\.com\.cn|szse\.cn|csrc\.gov\.cn|sec\.gov$/.test(host)) {
      return 'regulatory_filing';
    }
    if (/(wind|choice|bloomberg|refinitiv|csindex)\./.test(host)) return 'financial_database';
    if (/(arxiv|cnki|ssrn|jstor)\./.test(host)) return 'academic';
    if (/(caixin|reuters|bloomberg|ft\.com|wsj|yicai|stcn|21jingji|cls\.cn)/.test(host)) {
      return 'news_media';
    }
    if (/(zhihu|weibo|x\.com|reddit|twitter)/.test(host)) return 'social_ugc';
    if (/(cnblogs|csdn|juejin|medium|substack)/.test(host)) return 'blog';
    return 'news_media';
  }
}

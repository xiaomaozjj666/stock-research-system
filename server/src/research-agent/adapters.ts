/**
 * 研究 Agent 的生产适配器
 * ------------------------------------------------------------------
 * research-agent 只依赖两个窄接口（LLMAdapter / SearchAdapter），本文件把它们
 * 接到系统既有通道上——这是深度研究能力从「可测试的库」变成「可上线的功能」的
 * 最后一公里：
 *
 *   LLMAdapter      -> llm/client.ts 的 chat()：多模型路由 + 限流重试 + 成本记账
 *   eastmoney.公告  -> quant/announcementProvider：交易所公告（Tier-1，最权威）
 *   eastmoney.新闻  -> quant/newsSignal.fetchLatestNews：个股新闻（Tier-2）
 *   internal.知识库 -> llm/rag.retrieveEvidence：内部语料 / 历史研报（Tier-2）
 *
 * 适配器数组的顺序即降级链：某个通道抛错或返回空结果时，编排器自动换下一个，
 * 并把「降级自谁」写进每条证据的 AcquisitionPath —— 最终报告里的每条结论都能
 * 回溯到具体的抓取路径（这是投研合规与可复现的底线）。
 *
 * 关于 fetch(url) 的缓存：新闻与知识库的数据在 search 阶段就已经拿到了正文，
 * 但编排器按「先搜后抓」的两段式协议工作，因此这里用有界缓存把正文暂存到
 * fetch 阶段取用。缓存必须有上限——进程是长驻的，少了这条限制就是缓慢的内存泄漏。
 */

import { chat } from '../llm/client.js';
import type { ChatMessage } from '../llm/client.js';
import type { LLMTask } from '../llm/config.js';
import { retrieveEvidence } from '../llm/rag.js';
import {
  ANNOUNCEMENT_CONTENT_LIMIT,
  fetchAnnouncementContent,
  fetchAnnouncementList,
} from '../quant/announcementProvider.js';
import { fetchLatestNews } from '../quant/newsSignal.js';
import type { LLMAdapter, LLMRequest } from './llm.js';
import type { FetchedDoc, SearchAdapter, SearchHit, SearchQuery } from './search.js';
import type { SourceType } from './types.js';

/* ------------------------------------------------------------------ 通用工具 */

/** 六位代码匹配：前后都不能紧邻数字，避免从「2026年600519元」里切出 026600 */
const CODE_RE = /(?:^|[^0-9])(\d{6})(?![0-9])/;

/**
 * 严格版 A 股前缀校验（沪主板/科创板/深主板/创业板/北交所）。
 *
 * 为什么不用 utils/stockCode 的 isAShareCode：那个函数只判 `\d{6}`，服务于
 * 「用户已经给出的代码」这一场景，宽松是对的；而这里是在**自由文本里扫描**，
 * 合同号 999999、批次号 123456 都会被误判成个股，进而发起一次毫无意义的公告
 * 查询。扫描场景要的是精度，所以单独收紧，两边语义差异在此显式声明。
 */
const A_SHARE_PREFIX_RE =
  /^(?:60[0135]\d{3}|68[89]\d{3}|00[0123]\d{3}|30[01]\d{3}|(?:43|83|87|88|92)\d{4})$/;

/**
 * 从自由文本里提取第一个合法的 A 股代码。
 * 研究问题既可能是「600519 最新公告解读」，也可能是「白酒行业 2027 年竞争格局」——
 * 后者取不到代码，公告/新闻通道应返回空结果，交由知识库通道或降级链处理。
 */
export function extractStockCode(text: string): string | null {
  if (typeof text !== 'string') return null;
  const global = new RegExp(CODE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    const candidate = m[1];
    if (candidate && A_SHARE_PREFIX_RE.test(candidate)) return candidate;
  }
  return null;
}

/**
 * 极简分词：中文按二元组、英文/数字按词。
 * 与 rag.ts 的 tokenize 保持同一口径——两处打分逻辑共用一种切法，
 * 避免「知识库能召回、公告召回不到」这类口径漂移。
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) ?? [];
  const cjk = lower.match(/[\u4e00-\u9fa5]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk[i]! + cjk[i + 1]!);
  return [...latin, ...bigrams];
}

/** 关键词命中数（标题权重高于摘要，标题命中一次记 2 分） */
function keywordScore(title: string, body: string, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  let score = 0;
  for (const t of tokenize(title)) if (terms.has(t)) score += 2;
  for (const t of tokenize(body)) if (terms.has(t)) score += 1;
  return score;
}

/**
 * 有界 FIFO 缓存：`search` 阶段存正文，`fetch` 阶段取用。
 * 上限 500 条足以覆盖单次研究的全部命中（maxDocsPerQuery × 子问题数 ≪ 500），
 * 又不会让长驻进程随请求数无界增长。
 */
class BoundedDocCache {
  private readonly map = new Map<string, FetchedDoc>();

  constructor(private readonly limit = 500) {}

  set(url: string, doc: FetchedDoc): void {
    if (this.map.size >= this.limit && !this.map.has(url)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(url, doc);
  }

  get(url: string): FetchedDoc | undefined {
    return this.map.get(url);
  }
}

/** 把正文截断到合理长度：LLM 抽取只读前若干字，超长正文纯属浪费 token */
function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/* ------------------------------------------------------------------ LLM 适配器 */

export interface LLMAdapterOptions {
  /** 适配器标识，写入事件与错误信息 */
  name?: string;
  /** 单次请求超时（毫秒）。规划/验证/编排都是长输出，留足余量 */
  timeoutMs?: number;
  /** 单次输出上限。规划要一次性吐出 8 个子问题的 JSON，过小会截断成非法 JSON */
  maxTokens?: number;
  /** 任务标签：走多模型路由（默认 reasoning，交给更强的模型做推理） */
  task?: LLMTask;
}

/**
 * 生产 LLM 适配器：桥接到既有的 chat()。
 *
 * 这里刻意**不做**任何重试——重试已经在 llm/client.ts 的请求层实现（429/5xx
 * 指数退避），结构化输出的「不合规重试」则由 research-agent/llm.ts 的
 * completeJson 负责。两层各司其职，适配器再加一层只会让总耗时和成本失控。
 */
export function createLLMAdapter(opts: LLMAdapterOptions = {}): LLMAdapter {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const maxTokens = opts.maxTokens ?? 3200;
  const task: LLMTask = opts.task ?? 'reasoning';

  return {
    name: opts.name ?? `llm.${task}`,
    async complete(req: LLMRequest): Promise<string> {
      const messages: ChatMessage[] = [];
      if (req.system && req.system.trim() !== '') {
        messages.push({ role: 'system', content: req.system });
      }
      messages.push({ role: 'user', content: req.prompt });

      const text = await chat(messages, {
        temperature: req.temperature ?? 0.2,
        maxTokens,
        task,
        timeout: timeoutMs,
      });

      // 空串不是合法回复：让它以异常形式冒泡，由 completeJson 的重试/降级接住，
      // 而不是把空串当成「模型认为没有内容」静默写进报告
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('LLM 返回空内容');
      }
      return text;
    },
  };
}

/* -------------------------------------------------------------- 公告检索适配器 */

export interface AnnouncementAdapterOptions {
  /** 拉取多少条公告参与排序（上限受上游 page_size 约束） */
  pageSize?: number;
  /** 正文截断长度 */
  contentLimit?: number;
}

/**
 * 公告检索适配器（Tier-1：公司官方披露）。
 *
 * 为什么把公告放在降级链首位：公告是交易所披露的原文，可被用户逐条核验，
 * 是投研结论里唯一「不可辩驳」的一类证据；新闻与研报都存在转述误差。
 */
export function createAnnouncementAdapter(opts: AnnouncementAdapterOptions = {}): SearchAdapter {
  const pageSize = opts.pageSize ?? 20;
  const contentLimit = opts.contentLimit ?? ANNOUNCEMENT_CONTENT_LIMIT;
  const cache = new BoundedDocCache();

  const toUrl = (artCode: string): string => `em-ann://${encodeURIComponent(artCode)}`;

  return {
    name: 'eastmoney.announcement',

    async search(q: SearchQuery): Promise<SearchHit[]> {
      const code = extractStockCode(q.query);
      if (!code) return []; // 非个股问题：让位给后续通道

      const { announcements } = await fetchAnnouncementList(code, pageSize);
      if (announcements.length === 0) return [];

      const terms = new Set(tokenize(q.query));
      const ranked = announcements
        .map((a) => ({ ...a, score: keywordScore(a.title, '', terms) }))
        .sort((x, y) => y.score - x.score || y.date.localeCompare(x.date));

      const sourceType: SourceType = 'company_disclosure';
      return ranked.slice(0, Math.max(1, q.maxResults)).map((a) => ({
        title: a.title || `${code} 公告`,
        url: toUrl(a.artCode),
        snippet: `${a.date} 公告`,
        publisher: '巨潮资讯 / 东方财富',
        publishedAt: a.date,
        sourceType,
      }));
    },

    async fetch(url: string): Promise<FetchedDoc> {
      const artCode = decodeURIComponent(url.replace(/^em-ann:\/\//, '')).trim();
      if (!artCode) throw new Error(`公告地址非法：${url}`);

      const text = await fetchAnnouncementContent(artCode);
      if (!text || text.trim() === '') {
        throw new Error(`公告正文为空：${artCode}`);
      }
      const doc: FetchedDoc = {
        url,
        title: '公告正文',
        text: clip(text, contentLimit),
      };
      cache.set(url, doc); // 留一份本地缓存：同一次运行内重复抓取直接命中
      return cache.get(url) ?? doc;
    },
  };
}

/* -------------------------------------------------------------- 新闻检索适配器 */

export interface NewsAdapterOptions {
  /** 正文保留长度（新闻摘要本身不长，默认给足） */
  contentLimit?: number;
}

/**
 * 个股新闻适配器（Tier-2：权威媒体报道）。
 *
 * 新闻没有稳定的原文 URL（东财返回的是 id + 摘要），因此用 `em-news://` 自定义
 * 协议承载 id，`fetch` 阶段从缓存回填正文。这样编排器的「先搜后抓」协议保持不变，
 * 事件与 AcquisitionPath 里也能看到真实的抓取动作。
 */
export function createNewsAdapter(opts: NewsAdapterOptions = {}): SearchAdapter {
  const contentLimit = opts.contentLimit ?? 1500;
  const cache = new BoundedDocCache();

  return {
    name: 'eastmoney.news',

    async search(q: SearchQuery): Promise<SearchHit[]> {
      const code = extractStockCode(q.query);
      if (!code) return [];

      const items = await fetchLatestNews(code);
      if (items.length === 0) return [];

      const terms = new Set(tokenize(q.query));
      const ranked = items
        .map((item) => ({
          item,
          score: keywordScore(item.title, item.summary ?? '', terms),
        }))
        .sort((x, y) => y.score - x.score || y.item.publishedAt.localeCompare(x.item.publishedAt));

      const sourceType: SourceType = 'news_media';
      return ranked.slice(0, Math.max(1, q.maxResults)).map(({ item }) => {
        const url = `em-news://${code}/${encodeURIComponent(item.id)}`;
        const body = [item.title, item.summary ?? ''].filter((s) => s !== '').join('\n\n');
        cache.set(url, {
          url,
          title: item.title,
          text: clip(body, contentLimit),
          publishedAt: item.publishedAt,
        });
        return {
          title: item.title,
          url,
          snippet: item.summary ?? '',
          publisher: item.source ?? '东方财富',
          publishedAt: item.publishedAt,
          sourceType,
        };
      });
    },

    async fetch(url: string): Promise<FetchedDoc> {
      const doc = cache.get(url);
      if (!doc) {
        throw new Error(`新闻正文未命中缓存：${url}（超出缓存容量或跨进程复用）`);
      }
      return doc;
    },
  };
}

/* ------------------------------------------------------------ 内部知识库适配器 */

export interface KnowledgeBaseAdapterOptions {
  /** 召回条数 */
  topK?: number;
  /** 正文保留长度 */
  contentLimit?: number;
}

/**
 * 内部知识库适配器（Tier-2：内部资料 / 历史研报）。
 *
 * 它同时充当降级链的兜底：公告与新闻都依赖个股代码，而行业/主题类问题只有这里
 * 可能命中。返回空数组时编排器会记为「全部通道无结果」，并在报告的局限性里声明，
 * 不会伪造证据。
 */
export function createKnowledgeBaseAdapter(opts: KnowledgeBaseAdapterOptions = {}): SearchAdapter {
  const topK = opts.topK ?? 5;
  const contentLimit = opts.contentLimit ?? 2000;
  const cache = new BoundedDocCache();

  return {
    name: 'internal.knowledge_base',

    async search(q: SearchQuery): Promise<SearchHit[]> {
      const docs = await retrieveEvidence(q.query, {
        topK: Math.max(topK, q.maxResults),
      });
      if (docs.length === 0) return [];

      const sourceType: SourceType = 'internal_doc';
      return docs.map((doc) => {
        const url = `kb://${encodeURIComponent(doc.id)}`;
        cache.set(url, {
          url,
          title: doc.source || `内部资料 ${doc.id}`,
          text: clip(doc.text, contentLimit),
        });
        return {
          title: doc.source || `内部资料 ${doc.id}`,
          url,
          snippet: clip(doc.text, 160),
          publisher: '内部知识库',
          sourceType,
        };
      });
    },

    async fetch(url: string): Promise<FetchedDoc> {
      const doc = cache.get(url);
      if (!doc) throw new Error(`知识库正文未命中缓存：${url}`);
      return doc;
    },
  };
}

/* ---------------------------------------------------------------- 默认装配 */

/**
 * 默认检索通道：公告（最权威）-> 新闻 -> 内部知识库（兜底）。
 *
 * 顺序即优先级，不是随便排的：同一事实若公告与新闻都提到了，编排器会先用公告
 * 取证，最终引用里的来源层级更高，可信度基准分也更高（SOURCE_TIER 决定）。
 */
export function createDefaultSearchAdapters(): SearchAdapter[] {
  return [createAnnouncementAdapter(), createNewsAdapter(), createKnowledgeBaseAdapter()];
}

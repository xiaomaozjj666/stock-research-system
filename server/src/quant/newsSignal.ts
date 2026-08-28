/**
 * 新闻情绪信号（News Sentiment Signal）
 * ----------------------------------------------------------------------------
 * 把「最新消息」转化为可用于回测/预测的严谨情绪信号，是整个系统"根据最新消息
 * 进行回测"的基础数据层。
 *
 * 数学模型（全部文档化、确定性、可测）：
 *
 * 1) 单条新闻极性 polarity ∈ [−1, 1]
 *    - 若调用方已标注 polarity（来自情绪模型/专家/上游），直接使用；
 *    - 否则用词典法 lexiconPolarity(text) 确定性打分：预置看多/看空词库，
 *      每条命中词贡献 ±1，最终按命中次数归一化并夹紧到 [−1, 1]。
 *
 * 2) 截面聚合（含时效性加权）—— aggregateNewsSentiment
 *    - 时效权重 w_i = exp(−λ · ageDays_i)，λ = RECENCY_LAMBDA（半衰期 ≈ ln2/λ ≈ 5.8 天）；
 *    - 加权极性 p = Σ(w_i · polarity_i) / Σw_i ∈ [−1, 1]；无新闻 → 0；
 *    - 情绪 z 分：d = 0.5 + 0.5·p ∈ (0, 1)，z = logit(d) = ln(d/(1−d))，
 *      端点夹紧到 [Z_CLIP, 1−Z_CLIP] 避免 ±∞，与 factorAnalytics.desirabilityToZ 同构，
 *      可直接纳入因子组合 z；
 *    - 看多占比 bullishRatio = #{polarity_i > 0.1} / N ∈ [0, 1]；
 *    - 新鲜度 freshness = Σw_i / N ∈ (0, 1]（=1 表示全部为当日，越接近 0 越陈旧）；
 *    - 影响强度 weightedImpact = |p| · freshness ∈ [0, 1]（用于报告与排序）。
 *
 * 3) 实时抓取 fetchLatestNews(code)：尽力而为（best-effort）
 *    - 依次尝试若干公开新闻/公告端点；任一网络或解析失败均被吞掉，返回 []（绝不抛错）；
 *    - 抓取到的原始新闻用 lexiconPolarity 自动打分；
 *    - 在受限/离线环境（如沙箱）下优雅降级为 []，模型本身与单测不依赖网络。
 */

// LLM 语义抽取（可选增强）：LLM 可用时用语义打分替代硬编码词表，失败回退词典法
import { isLLMAvailable, chatJSON } from '../llm/index.js';

// 时效衰减系数（半衰期 ≈ ln2 / 0.12 ≈ 5.8 天）
const RECENCY_LAMBDA = 0.12;
// 情绪 z 分 logit 端点夹紧，避免 ±∞
const Z_CLIP = 0.001;

/** 看多（利好）词库：命中贡献 +1 */
const BULLISH_WORDS: string[] = [
  '利好',
  '超预期',
  '大幅增长',
  '高增长',
  '创新高',
  '新高',
  '突破',
  '中标',
  '签约',
  '订单',
  '扩产',
  '回购',
  '增持',
  '扭亏',
  '盈利',
  '大涨',
  '暴涨',
  '获批',
  '提价',
  '上调',
  '增资',
  '复苏',
  '放量',
  '拐点',
  '困境反转',
  '机构买入',
  '买入评级',
  '上调评级',
  '分红',
  '高分红',
  '超预期增长',
  '产能释放',
  '需求旺盛',
  '量价齐升',
];

/** 看空（利空）词库：命中贡献 −1 */
const BEARISH_WORDS: string[] = [
  '利空',
  '下滑',
  '亏损',
  '爆雷',
  '暴雷',
  '减持',
  '下调',
  '降级',
  '诉讼',
  '处罚',
  '退市',
  '跌停',
  '暴跌',
  '商誉减值',
  '警示',
  '立案',
  '冻结',
  '停产',
  '召回',
  '计提减值',
  '业绩变脸',
  '下调评级',
  '卖出评级',
  '机构卖出',
  '监管',
  '调查',
  '违规',
  '造假',
  '停产整顿',
  '需求疲软',
  '量价齐跌',
  '库存高企',
  '现金流紧张',
  '债务危机',
  '质押平仓',
];

export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  /** 发布时间：ISO 日期或 datetime 字符串 */
  publishedAt: string;
  source?: string;
  /** 可选预标注极性 ∈ [−1, 1]；缺省由词典法推算 */
  polarity?: number;
}

export interface NewsSignal {
  /** 时效性加权极性 ∈ [−1, 1] */
  polarity: number;
  /** 情绪 z 分（与因子 z 同构，可直接进入因子组合） */
  sentimentZ: number;
  /** 看多占比 ∈ [0, 1] */
  bullishRatio: number;
  /** 新闻条数 */
  newsCount: number;
  /** 新鲜度 ∈ (0, 1]（=1 表示全部为当日新闻） */
  freshness: number;
  /** 影响强度 ∈ [0, 1] */
  weightedImpact: number;
  /** 按时效排序的原始新闻 */
  items: NewsItem[];
  /** 是否有可用新闻 */
  hasNews: boolean;
}

/**
 * 取新闻集合的最早发布日期（YYYY-MM-DD）。
 * 供回测 newsOverlay.since 使用：情绪姿态仅应用于该日期及之后的 bar，
 * 避免用「现在才知道的消息」改写历史交易（前视偏差）。
 */
export function earliestNewsDate(items: NewsItem[]): string | undefined {
  const dates = items
    .map((n) => (typeof n.publishedAt === 'string' ? n.publishedAt.slice(0, 10) : ''))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates[0] || undefined;
}

/** 词典法：对单条文本给出确定性极性 ∈ [−1, 1] */
export function lexiconPolarity(text: string): number {
  if (!text) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const w of BULLISH_WORDS) {
    if (t.includes(w.toLowerCase())) {
      score += 1;
      hits += 1;
    }
  }
  for (const w of BEARISH_WORDS) {
    if (t.includes(w.toLowerCase())) {
      score -= 1;
      hits += 1;
    }
  }
  if (hits === 0) return 0;
  return Math.max(-1, Math.min(1, score / hits));
}

/** 单条新闻最终极性：优先使用预标注，否则词典法推算 */
export function scoreNewsItem(item: NewsItem): number {
  if (typeof item.polarity === 'number' && isFinite(item.polarity)) {
    return Math.max(-1, Math.min(1, item.polarity));
  }
  return lexiconPolarity(`${item.title} ${item.summary ?? ''}`);
}

/** 计算新闻发布至今的天数；解析失败视为 30 天前（低时效权重） */
function ageInDays(publishedAt: string, now: number): number {
  const ts = Date.parse(publishedAt);
  if (!isFinite(ts)) return 30;
  const days = (now - ts) / (24 * 60 * 60 * 1000);
  return days < 0 ? 0 : days; // 未来时间按当日计
}

/** logit 变换（端点夹紧，避免 ±∞） */
function logit(d: number): number {
  const x = Math.min(1 - Z_CLIP, Math.max(Z_CLIP, d));
  return Math.log(x / (1 - x));
}

export interface AggregateOptions {
  /** 覆盖时效衰减系数（默认 RECENCY_LAMBDA） */
  lambda?: number;
  /** 参考"现在"（默认 Date.now()），便于测试注入 */
  now?: number;
}

/**
 * 将一组新闻聚合为一个 NewsSignal。空输入返回中性信号（hasNews=false）。
 */
export function aggregateNewsSentiment(items: NewsItem[], opts: AggregateOptions = {}): NewsSignal {
  const lambda = opts.lambda ?? RECENCY_LAMBDA;
  const now = opts.now ?? Date.now();

  if (!items || items.length === 0) {
    return {
      polarity: 0,
      sentimentZ: 0,
      bullishRatio: 0,
      newsCount: 0,
      freshness: 0,
      weightedImpact: 0,
      items: [],
      hasNews: false,
    };
  }

  const scored = items.map((it) => ({
    item: it,
    p: scoreNewsItem(it),
    age: ageInDays(it.publishedAt, now),
  }));

  let sumW = 0;
  let sumWP = 0;
  let bullish = 0;
  for (const s of scored) {
    const w = Math.exp(-lambda * s.age);
    sumW += w;
    sumWP += w * s.p;
    if (s.p > 0.1) bullish += 1;
  }

  const polarity = sumW > 0 ? sumWP / sumW : 0;
  const d = 0.5 + 0.5 * polarity; // ∈ (0,1)
  const sentimentZ = logit(d);
  const bullishRatio = bullish / scored.length;
  const freshness = sumW / scored.length; // ∈ (0,1]
  const weightedImpact = Math.min(1, Math.abs(polarity) * freshness);

  // 按时效升序排序（最新在前）
  const sorted = [...scored].sort((a, b) => a.age - b.age).map((s) => s.item);

  return {
    polarity,
    sentimentZ,
    bullishRatio,
    newsCount: scored.length,
    freshness,
    weightedImpact,
    items: sorted,
    hasNews: true,
  };
}

/**
 * 实时抓取最新新闻（尽力而为，绝不抛错）。
 * 依次尝试若干公开端点，解析出 {title, summary, publishedAt, source} 后自动词典打分。
 * 任何网络/解析失败都被吞掉，返回 []（调用方应以 [] 表示"暂无可用的实时新闻"）。
 */
export async function fetchLatestNews(code: string): Promise<NewsItem[]> {
  // 候选端点：个股公告/新闻（东方财富系）。沙箱仅放行部分子域，失败即降级。
  const secucode = code.startsWith('6') ? `${code}.SH` : `${code}.SZ`;
  const endpoints: { url: string; parse: (json: any) => NewsItem[] }[] = [
    {
      // 个股公告列表
      url: `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=10&page_index=1&stock_list=${secucode}`,
      parse: (json) =>
        (json?.data?.list ?? []).map((n: any, i: number) => ({
          id: `ann-${i}`,
          title: String(n.title ?? n.notice_title ?? ''),
          summary: n.summary ?? n.content ?? undefined,
          publishedAt: n.ei_time ?? n.notice_date ?? n.datetime ?? new Date().toISOString(),
          source: '东方财富公告',
        })),
    },
    {
      // 个股新闻（datacenter 系，沙箱可能可用）
      url: `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_WEB_TECHNIQUE&columns=ALL&filter=(SECUCODE%3D%22${secucode}%22)&pageSize=10`,
      parse: (json) =>
        (json?.data?.list ?? json?.result?.data ?? []).map((n: any, i: number) => ({
          id: `news-${i}`,
          title: String(n.TITLE ?? n.title ?? n.content ?? ''),
          summary: n.SUMMARY ?? n.summary ?? n.ABSTRACT ?? undefined,
          publishedAt: n.DATE ?? n.publishDate ?? n.notice_date ?? new Date().toISOString(),
          source: '东方财富新闻',
        })),
    },
  ];

  for (const ep of endpoints) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(ep.url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const json = await resp.json();
      const list = ep.parse(json).filter((n) => n.title && n.title.length > 0);
      if (list.length > 0) return list;
    } catch {
      // 忽略：尝试下一个端点
    }
  }
  return [];
}

/**
 * 用语义理解给新闻打极性分（仅 LLM 可用时启用；否则返回 null，调用方回退词典法）。
 * 模型对每条新闻返回 polarity∈[−1,1] 与 impact∈[0,1]，写回 NewsItem.polarity，
 * 下游 aggregateNewsSentiment 会优先采用预标注极性，从而与词典法同构、可测。
 */
export async function scoreNewsWithLLM(items: NewsItem[]): Promise<NewsItem[] | null> {
  if (!isLLMAvailable() || items.length === 0) return null;
  try {
    const payload = items.map((it, i) => ({
      i,
      title: it.title,
      summary: it.summary ?? '',
      publishedAt: it.publishedAt,
    }));
    const raw = await chatJSON<{ scores?: { i: number; polarity: number; impact: number }[] }>(
      [
        {
          role: 'system',
          content:
            '你是金融新闻情绪分析器。对每条新闻给出极性 polarity(-1看空~1看多)与影响强度 impact(0~1)。只返回 JSON。',
        },
        {
          role: 'user',
          content: `请分析以下新闻，返回 {"scores":[{"i":序号,"polarity":数值,"impact":数值}]}。\n${JSON.stringify(payload)}`,
        },
      ],
      { temperature: 0.2, maxTokens: 1200, timeout: 30000 },
    );

    if (!Array.isArray(raw.scores)) return null;
    const byIndex = new Map(raw.scores.map((s) => [s.i, s]));
    return items.map((it, i) => {
      const s = byIndex.get(i);
      if (!s) return it;
      const polarity = Math.max(-1, Math.min(1, Number(s.polarity) || 0));
      return { ...it, polarity };
    });
  } catch {
    return null; // 回退词典法
  }
}

/**
 * 便捷封装：抓取最新新闻并聚合为 NewsSignal。
 * LLM 可用时先用语义抽取增强极性，否则/失败时回退词典法。
 * 返回 { signal, source }；source 为 'live'（抓到新闻）或 'none'（无可用新闻）。
 */
export async function extractNewsSignal(
  code: string,
): Promise<{ signal: NewsSignal; source: 'live' | 'none' }> {
  const items = await fetchLatestNews(code);
  if (items.length === 0) {
    return { signal: aggregateNewsSentiment([]), source: 'none' };
  }
  let scored = items;
  if (isLLMAvailable()) {
    try {
      const enriched = await scoreNewsWithLLM(items);
      if (enriched) scored = enriched;
    } catch {
      // 回退词典法
    }
  }
  const signal = aggregateNewsSentiment(scored);
  return { signal, source: signal.hasNews ? 'live' : 'none' };
}

export const NEWS_MODEL_CONSTANTS = {
  RECENCY_LAMBDA,
  Z_CLIP,
  HALF_LIFE_DAYS: Math.log(2) / RECENCY_LAMBDA,
} as const;

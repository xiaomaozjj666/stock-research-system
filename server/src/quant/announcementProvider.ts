/**
 * 公告数据源（东方财富公告网关）——列表 + 全文
 * ============================================================================
 * 解决「专家研判只看得到结构化数字、看不到公司自己说了什么」的断层：
 * 分析管线与 Chat Agent 都能引用最近公告的标题与正文原文（如业绩预告、
 * 重大合同、股东增减持），关键结论可回指到公告原文。
 *
 * **字段口径**（2026-09-12 文档化，网络可达时经 /api/quant/announcements 实测校准）：
 *  - 列表：np-anotice-stock.eastmoney.com/api/security/ann
 *    ?stock_list={code}&page_size={n}&page_index=1&ann_type=A&client_source=web
 *    → data.list[]: { art_code, title, notice_date, columns[] }
 *  - 正文：np-cnotice-stock.eastmoney.com/api/content/ann?art_code={art}&client_source=web
 *    → data.notice_content（纯文本正文；PDF 公告该字段可能为空——如实返回空串）
 *
 * 缓存纪律：已发布公告不可变 → 正文 30 天；列表随新公告追加 → 24h
 * （QUANT_ANNOUNCEMENT_CACHE_TTL_HOURS 可覆盖，0 = 关闭）。上游失败如实抛错，
 * 由调用方降级（与 eventProvider 同语义）。
 */
import { withQuantCache } from './quantCache.js';

const LIST_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const CONTENT_URL = 'https://np-cnotice-stock.eastmoney.com/api/content/ann';

export interface AnnouncementRow {
  /** 公告正文 art_code（拉全文的键） */
  artCode: string;
  title: string;
  /** 公告日期 YYYY-MM-DD */
  date: string;
}

export interface AnnouncementListResult {
  code: string;
  announcements: AnnouncementRow[];
}

function announcementCacheTtlMs(): number {
  const raw = process.env.QUANT_ANNOUNCEMENT_CACHE_TTL_HOURS;
  if (raw !== undefined && raw.trim() !== '') {
    const hours = Number(raw);
    if (Number.isFinite(hours)) return hours > 0 ? hours * 60 * 60 * 1000 : 0;
  }
  return 24 * 60 * 60 * 1000;
}

const CONTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ListResponse {
  data?: { list?: Array<{ art_code?: string; title?: string; notice_date?: string }> } | null;
}

interface ContentResponse {
  data?: { notice_content?: string } | null;
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!resp.ok) {
    throw new Error(`东财公告 HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 单股公告列表（默认最近 10 条，降序） */
export async function fetchAnnouncementList(
  code: string,
  pageSize = 10,
): Promise<AnnouncementListResult> {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) {
    throw new Error('公告查询需 6 位 A 股代码');
  }
  const size = Math.max(1, Math.min(Math.floor(pageSize), 30));
  return withQuantCache(`ann_list_${c}_${size}`, announcementCacheTtlMs(), async () => {
    const url = `${LIST_URL}?sr=-1&page_size=${size}&page_index=1&ann_type=A&client_source=web&stock_list=${c}&f_node=0&s_node=0`;
    const json = (await fetchJson(url)) as ListResponse;
    const list = json?.data?.list ?? [];
    const announcements = list
      .filter((a) => typeof a.art_code === 'string' && a.art_code !== '')
      .map((a) => ({
        artCode: String(a.art_code),
        title: String(a.title ?? '').trim(),
        date: String(a.notice_date ?? '').slice(0, 10),
      }));
    return { code: c, announcements };
  });
}

/** 公告正文全文（纯文本；已发布公告不可变 → 30 天缓存） */
export async function fetchAnnouncementContent(artCode: string): Promise<string> {
  const art = artCode.trim();
  if (!art) throw new Error('artCode 必填');
  return withQuantCache(`ann_content_${art}`, CONTENT_TTL_MS, async () => {
    const url = `${CONTENT_URL}?art_code=${encodeURIComponent(art)}&client_source=web&page_index=1`;
    const json = (await fetchJson(url)) as ContentResponse;
    return String(json?.data?.notice_content ?? '');
  });
}

/** 全文截断上限（LLM 语境与工具回包共用） */
export const ANNOUNCEMENT_CONTENT_LIMIT = 2500;

/**
 * LLM 语境块：最近公告标题一览 + 最新一篇正文摘录。
 * 只呈现事实原文（截断标注），不做摘要改写——判断留给专家/模型。
 */
export async function buildAnnouncementBrief(code: string): Promise<string | null> {
  const { announcements } = await fetchAnnouncementList(code, 8);
  if (announcements.length === 0) return null;
  const lines: string[] = ['【最近公告（东财，标题为原文）】'];
  for (const a of announcements) {
    lines.push(`${a.date} ${a.title}`);
  }
  const latest = announcements[0];
  try {
    const content = await fetchAnnouncementContent(latest.artCode);
    if (content.trim()) {
      const truncated =
        content.length > ANNOUNCEMENT_CONTENT_LIMIT
          ? `${content.slice(0, ANNOUNCEMENT_CONTENT_LIMIT)}…（已截断，全文经 art_code=${latest.artCode} 获取）`
          : content;
      lines.push('', `【最新公告正文｜${latest.date} ${latest.title}】`, truncated);
    }
  } catch {
    // 正文拉取失败不拖垮标题块
  }
  return lines.join('\n');
}

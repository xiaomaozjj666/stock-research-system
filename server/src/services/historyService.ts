/**
 * 研究历史记录（轻量、落盘）
 * ----------------------------------------------------------------------------
 * 每次股票分析完成时自动保存（同股票代码去重更新，保持每只股票仅一条最新记录），
 * 前端历史页可列出、回看（恢复完整分析结果）与删除。
 * 去重会覆盖旧结果，因此额外保留一份「精简时间线」（每只股票最近 N 条 {date,score,rating}），
 * 否则用户无法回答"观点怎么变的"——只能看到最新一份快照。
 *
 * 持久化：单 JSON 文件（HISTORY_FILE env 可重定向，与 watchlist/paper/audit 同模式），
 * "临时文件 + 原子 rename"写入；容量超上限时淘汰最旧记录；所有 IO 错误静默降级。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisResult } from '../types.js';

/** 评分/评级时间线单点（精简：只留回看"观点怎么变的"所需字段，不带完整 result） */
export interface HistoryTimelinePoint {
  /** YYYY-MM-DD（createdAt 取日期部分，与 computeVsPrevious 同口径） */
  date: string;
  score: number;
  rating: string;
}

/** 历史记录条目的摘要字段（列表接口返回，不携带完整 result） */
export interface HistorySummary {
  id: string;
  stockCode: string;
  stockName: string;
  createdAt: string;
  rating: string;
  totalScore: number;
  industry?: string;
  /**
   * 评分/评级时间线（由旧到新，含当前这条）；仅在有记录时出现。
   * 旧数据（本字段上线前落盘）没有它 → 保持 undefined，前端据此不渲染变化量。
   */
  timeline?: HistoryTimelinePoint[];
}

/** 历史记录完整条目（详情接口返回，result 可恢复研究报告渲染） */
export interface HistoryItem extends HistorySummary {
  result: AnalysisResult;
}

/** 新增/更新历史时提交的内容 */
export interface HistoryEntryInput {
  stockCode: string;
  stockName: string;
  industry?: string;
  rating: string;
  totalScore: number;
  result: AnalysisResult;
}

interface HistoryStore {
  items: HistoryItem[];
}

const DEFAULT_HISTORY_FILE = path.join(import.meta.dirname, '..', 'data', 'history.json');
/** 历史记录容量上限：超出后淘汰最旧记录 */
export const MAX_HISTORY_ITEMS = 100;
/** 每只股票保留的时间线长度上限：只留最近 N 次，避免列表响应体随使用时长膨胀 */
export const MAX_TIMELINE_POINTS = 20;

/**
 * 运行时解析落盘路径：支持 HISTORY_FILE 环境变量重定向（与 watchlist/paper/audit 同模式）。
 * 惰性解析而非模块级常量，测试可在 beforeAll 中设置 env 后生效。
 */
function getHistoryFile(): string {
  return process.env.HISTORY_FILE && process.env.HISTORY_FILE.length > 0
    ? process.env.HISTORY_FILE
    : DEFAULT_HISTORY_FILE;
}

function readStore(): HistoryStore {
  try {
    const file = getHistoryFile();
    if (!fs.existsSync(file)) return { items: [] };
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as HistoryStore;
    return parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch {
    // 文件损坏/不可读：视为空历史（不阻断）
    return { items: [] };
  }
}

function writeStore(store: HistoryStore): boolean {
  try {
    const file = getHistoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换，避免半写状态
    return true;
  } catch {
    return false;
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 毫秒级单调时钟：Date.now() 在快速连续保存（如批量测试/脚本）时可能落在同一毫秒，
// createdAt 相同会让"按时间倒序 + 淘汰最旧"依赖数组稳定序（结果错误：淘汰的是后保存的）。
// 同毫秒时强制 +1ms 递增，保证 createdAt 严格单调、排序与淘汰语义永远正确。
let lastCreatedAtMs = 0;
function monotonicNowIso(): string {
  const now = Date.now();
  const ts = now > lastCreatedAtMs ? now : lastCreatedAtMs + 1;
  lastCreatedAtMs = ts;
  return new Date(ts).toISOString();
}

/**
 * 只保留结构合法的点并裁剪到 MAX_TIMELINE_POINTS。
 * 文件可能来自旧版本或被手改，脏数据不应让列表接口报错或把非法字段透给前端。
 */
function sanitizeTimeline(value: unknown): HistoryTimelinePoint[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryTimelinePoint[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Partial<HistoryTimelinePoint>;
    if (typeof p.date !== 'string' || !Number.isFinite(p.score)) continue;
    out.push({
      date: p.date,
      score: Number(p.score),
      rating: typeof p.rating === 'string' ? p.rating : '',
    });
  }
  return out.slice(-MAX_TIMELINE_POINTS);
}

/**
 * 追加一个时间线点并裁剪到上限。
 * 旧数据（timeline 字段上线前落盘）缺失时间线时，用「本次将被覆盖的那次快照」补种起点：
 * 否则老记录第一次更新后只有 1 个点，用户依然看不到"变了多少"。
 */
function appendTimeline(
  existing: HistoryItem,
  nowIso: string,
  input: HistoryEntryInput,
): HistoryTimelinePoint[] {
  const points = sanitizeTimeline(existing.timeline);
  if (points.length === 0 && typeof existing.createdAt === 'string') {
    points.push({
      date: existing.createdAt.slice(0, 10),
      score: existing.totalScore,
      rating: existing.rating,
    });
  }
  points.push({ date: nowIso.slice(0, 10), score: input.totalScore, rating: input.rating });
  return points.slice(-MAX_TIMELINE_POINTS);
}

/**
 * 条目 → 列表摘要：剥掉完整 result（响应体瘦身），时间线做一次净化；
 * 空时间线不返回空数组，让"无时间线"在类型上就是 undefined（前端不必区分 [] 与缺失）。
 */
function toSummary(item: HistoryItem): HistorySummary {
  const { result: _result, timeline, ...summary } = item;
  const points = sanitizeTimeline(timeline);
  return points.length > 0 ? { ...summary, timeline: points } : summary;
}

/**
 * 保存/更新一条历史记录：同股票代码去重（更新为最新分析，id 保留），
 * 容量超上限时淘汰最旧记录。返回保存后的条目；写盘失败返回 null（不阻断分析主流程）。
 */
export function saveHistoryEntry(input: HistoryEntryInput): HistoryItem | null {
  const store = readStore();
  const now = monotonicNowIso();
  const existing = store.items.find((it) => it.stockCode === input.stockCode);

  let saved: HistoryItem;
  if (existing) {
    // 时间线必须先按"被覆盖前"的值计算，再覆盖其余字段
    existing.timeline = appendTimeline(existing, now, input);
    existing.stockName = input.stockName;
    existing.industry = input.industry;
    existing.rating = input.rating;
    existing.totalScore = input.totalScore;
    existing.result = input.result;
    existing.createdAt = now;
    saved = existing;
  } else {
    saved = {
      id: makeId(),
      stockCode: input.stockCode,
      stockName: input.stockName,
      industry: input.industry,
      rating: input.rating,
      totalScore: input.totalScore,
      createdAt: now,
      timeline: [{ date: now.slice(0, 10), score: input.totalScore, rating: input.rating }],
      result: input.result,
    };
    store.items.push(saved);
  }

  // 容量上限：按时间倒序保留最新 MAX_HISTORY_ITEMS 条
  if (store.items.length > MAX_HISTORY_ITEMS) {
    store.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    store.items = store.items.slice(0, MAX_HISTORY_ITEMS);
  }

  if (!writeStore(store)) return null;
  return saved;
}

/** 历史列表（倒序，最新在前；不含完整 result，仅摘要字段 + 精简时间线） */
export function listHistory(limit = 50): HistorySummary[] {
  const store = readStore();
  return store.items
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 200)))
    .map(toSummary);
}

/**
 * 该股票上一次分析的摘要（记忆反思闭环用）：
 * 在 saveHistoryEntry 之前调用，返回同股票当前最新记录（即"上一次分析"）；
 * 无记录返回 null。
 */
export function getPreviousAnalysis(stockCode: string): HistorySummary | null {
  const store = readStore();
  const prev = store.items.find((it) => it.stockCode === stockCode);
  if (!prev) return null;
  return toSummary(prev);
}

/**
 * 计算「较上次分析」对比（记忆反思闭环，纯函数便于单测）：
 * 由当前条目（评级/评分）与上次摘要（getPreviousAnalysis 返回值）计算
 * vs_previous 结构；prev 为 null 时返回 null。
 */
export function computeVsPrevious(
  current: { rating: string; totalScore: number },
  prev: HistorySummary | null,
): {
  previous_date: string;
  previous_rating: string;
  previous_score: number;
  score_delta: number;
  rating_changed: boolean;
} | null {
  if (!prev) return null;
  return {
    previous_date: prev.createdAt.slice(0, 10),
    previous_rating: prev.rating,
    previous_score: prev.totalScore,
    score_delta: Math.round((current.totalScore - prev.totalScore) * 100) / 100,
    rating_changed: current.rating !== prev.rating,
  };
}

/** 历史详情（含完整 result，供前端恢复研究报告） */
export function getHistoryItem(id: string): HistoryItem | null {
  const store = readStore();
  return store.items.find((it) => it.id === id) ?? null;
}

/** 删除一条历史记录；返回是否删除成功 */
export function deleteHistoryItem(id: string): boolean {
  const store = readStore();
  const next = store.items.filter((it) => it.id !== id);
  if (next.length === store.items.length) return false;
  store.items = next;
  return writeStore(store);
}

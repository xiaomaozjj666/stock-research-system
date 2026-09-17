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
 * 读取走模块级内存 store（写后更新），同一请求只读一次写一次——历史库满额时
 * 单次 JSON.parse ≈ 38ms，重复读会在长连接（SSE）场景下阻塞事件循环。
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

/**
 * 历史库落盘结构（同时作为「内存快照」形态对外暴露）：
 * 由 readHistoryStore() 读一次后可作为 saveHistoryEntry() 的第二参数复用。
 */
export interface HistoryStore {
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

/**
 * 模块级内存 store（单进程单写者）。
 * ----------------------------------------------------------------------------
 * 此前每次分析收尾都要「读文件 + JSON.parse 整份历史库」两遍：routes/analysis.ts 先调
 * getPreviousAnalysis()（读一次），再调 saveHistoryEntry()（内部又读一次）。实测
 * server/src/data/history.json 达 199KB（单条可达 66KB，因为 result 是整份报告），
 * 库满（100 条）时约 14.7MB、单次 JSON.parse ≈ 38ms，于是每次收尾白阻塞事件循环
 * 0.14–0.18s；而 /api/analyze/stream、/api/chat/stream 都是长连接，事件循环一卡全体等。
 *
 * 现在：读走内存、写后更新缓存（脏标记即缓存本身是否有效），同一请求只读一次写一次。
 * 不做 mtime 校验——本模块是 history.json 的唯一写者；外部（测试夹具/运维手工）直接改写
 * 落盘文件后，调用 resetHistoryStoreCache() 强制重读即可。
 */
let storeCache: { file: string; store: HistoryStore } | null = null;

/**
 * 清空内存缓存：供测试隔离、或外部直接改写了落盘文件后强制重读（生产路径无需调用）。
 */
export function resetHistoryStoreCache(): void {
  storeCache = null;
}

/**
 * 读取历史库快照（内存缓存命中则不读盘、不 parse）。
 * 同一请求内可「读一次、复用给 saveHistoryEntry(input, store)」，让整条链路只读一次写一次。
 * 注意：返回的是浅拷贝，可自由读；但同一份快照不要跨多次写入复用（后一次会覆盖前一次）。
 */
export function readHistoryStore(): HistoryStore {
  return { items: [...readStore().items] };
}

function readStore(): HistoryStore {
  const file = getHistoryFile();
  if (storeCache && storeCache.file === file) return storeCache.store; // 缓存命中：不读盘
  let store: HistoryStore;
  try {
    if (!fs.existsSync(file)) {
      store = { items: [] };
    } else {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as HistoryStore;
      store = parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
    }
  } catch {
    // 文件损坏/不可读：视为空历史（不阻断）。**不写缓存**——一次瞬时读失败不该把
    // 「空历史」钉在内存里（否则下一次写入会把整份历史覆盖为空），下次调用重试读盘。
    return { items: [] };
  }
  storeCache = { file, store };
  return store;
}

function writeStore(store: HistoryStore): boolean {
  const file = getHistoryFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换，避免半写状态
    storeCache = { file, store }; // 写后更新缓存：后续读直接命中内存
    return true;
  } catch {
    // 写失败：落盘内容与缓存可能不一致（tmp 残留等），清缓存让下次读盘重建
    storeCache = null;
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
 *
 * @param reuseStore 复用调用方已读到的 store（可选）：同一请求里先 getPreviousAnalysis()
 *   再 saveHistoryEntry() 时传入（见 readHistoryStore()），可确保只读一次盘。
 *   不传时命中模块级内存缓存，效果相同；签名向后兼容（新增可选参数）。
 */
export function saveHistoryEntry(
  input: HistoryEntryInput,
  reuseStore?: HistoryStore,
): HistoryItem | null {
  const store = reuseStore && Array.isArray(reuseStore.items) ? reuseStore : readStore();
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

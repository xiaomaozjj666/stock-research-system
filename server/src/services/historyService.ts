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
 *
 * 异步化（2026-11 架构整改）：
 * 此前读写全部走同步 fs（readFileSync/writeFileSync/renameSync），rename 瞬态失败
 * 还用 Atomics.wait 做同步 sleep。历史库满额（100 条 ≈ 14.7MB）时单次 JSON.parse
 * ≈ 38ms、单次写回数十毫秒，/api/analyze/stream、/api/chat/stream 都是长连接，
 * 事件循环一卡全体等。现在：
 * - 所有 fs 操作一律走 node:fs/promises（含瞬态重试的 sleep 也改为 setTimeout），
 *   模块内不存在任何阻塞事件循环的路径；
 * - 进程内缓存带 mtime 失效：命中缓存时只做一次异步 stat（微秒级），mtime 不变
 *   直接返回内存快照，变了（含外部删除）自动重读——外部（测试夹具/运维手工）
 *   改写落盘文件不再需要手动 resetHistoryStoreCache()；
 * - 「读-改-写」经进程内串行队列执行：并发保存/删除不会交错成丢失更新。
 * API 语义不变：导出函数 Promise 化，返回结构、去重/淘汰/时间线/降级规则逐字保持。
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { DATA_ROOT } from '../dataRoot.js';
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

const DEFAULT_HISTORY_FILE = path.join(DATA_ROOT, 'history.json');
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
 * 模块级内存 store（单进程单写者）+ mtime 失效。
 * ----------------------------------------------------------------------------
 * 读走内存、写后更新缓存；命中时仅用一次异步 stat 校验 mtime——不读全量文件、
 * 不 JSON.parse。外部直接改写/删除落盘文件后 mtime 变化（或 stat 失败），缓存自动
 * 失效重读；resetHistoryStoreCache() 仍保留，供"内容变了但 mtime 被刻意保持"等
 * 极端场景强制重读。
 */
interface StoreCacheEntry {
  file: string;
  store: HistoryStore;
  /**
   * 建立缓存时落盘文件的 mtime（毫秒）；null 表示建立缓存时文件不存在（ENOENT）
   * 或写盘后 stat 失败——两种情况下次读都会重新加载，不会把过期内容钉在内存里。
   */
  mtimeMs: number | null;
  /**
   * 写盘失败后的「内存权威」标记：盘上内容已落后于内存（原子替换要么成功要么
   * 没发生，旧文件未动），此时 mtime 校验必然失配，若据此重读会把已完成的更新
   * 静默回滚。标记期间跳过校验，直到下一次成功写盘。
   */
  memoryAuthoritative: boolean;
}
let storeCache: StoreCacheEntry | null = null;

/**
 * 清空内存缓存：供测试隔离、或外部直接改写了落盘文件且 mtime 未变时强制重读
 * （常规外部改写由 mtime 校验自动发现，生产路径无需调用）。
 */
export function resetHistoryStoreCache(): void {
  storeCache = null;
}

/**
 * 读取历史库快照（内存缓存命中且 mtime 未变则不读盘、不 parse）。
 * 同一请求内可「读一次、复用给 saveHistoryEntry(input, store)」，让整条链路只读一次写一次。
 * 注意：返回的是浅拷贝，可自由读；但同一份快照不要跨多次写入复用（后一次会覆盖前一次）。
 */
export async function readHistoryStore(): Promise<HistoryStore> {
  return { items: [...(await readStore()).items] };
}

/** 从盘加载并建立缓存；损坏/不可读返回空历史且**不写缓存**（下次调用重试）。 */
async function loadFromDisk(file: string): Promise<HistoryStore> {
  let store: HistoryStore;
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as HistoryStore;
    store = parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // 文件不存在 = 确定的空历史（不是故障），可以缓存；外部新建文件后 mtime
      // 校验会发现"建立缓存时无文件、现在有"，自动重读。
      store = { items: [] };
      storeCache = { file, store, mtimeMs: null, memoryAuthoritative: false };
      return store;
    }
    // 文件损坏/不可读：视为空历史（不阻断）。**不写缓存**——一次瞬时读失败不该把
    // 「空历史」钉在内存里（否则下一次写入会把整份历史覆盖为空），下次调用重试读盘。
    return { items: [] };
  }
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await fsp.stat(file)).mtimeMs;
  } catch {
    // 读到内容却 stat 失败（极端竞态）：保持 null，下次读重新加载，绝不误信缓存
  }
  storeCache = { file, store, mtimeMs, memoryAuthoritative: false };
  return store;
}

async function readStore(): Promise<HistoryStore> {
  const file = getHistoryFile();
  const cached = storeCache;
  if (cached && cached.file === file) {
    if (cached.memoryAuthoritative) return cached.store; // 写失败后内存是权威，不回滚
    try {
      const st = await fsp.stat(file);
      if (cached.mtimeMs !== null && st.mtimeMs === cached.mtimeMs) {
        return cached.store; // 缓存命中：mtime 未变，不读盘
      }
    } catch {
      // 文件被外部删除：建立缓存时本就无文件（ENOENT 缓存）则仍然有效
      if (cached.mtimeMs === null) return cached.store;
    }
    // mtime 变化 / 文件被删 / 出现新文件：落到下方重读
  }
  return loadFromDisk(file);
}

/**
 * rename 的瞬态失败重试（Windows 专属痛点）。
 * 杀毒/搜索索引服务会短暂锁定刚写出的 tmp 或目标文件，rename 随即
 * EPERM/EBUSY——数百毫秒后自动放手。graceful-fs 对同类问题的标准处置就是
 * 短暂重试；不重试的话单次锁定就会触发整条「写失败」降级路径。
 * 重试间隔用 setTimeout 让出事件循环（此前的 Atomics.wait 同步 sleep 会把
 * 所有在途请求一起卡住，已随异步化彻底移除）。非锁定类错误（EINVAL/ENOENT 等）
 * 不属于瞬态，直接上抛由调用方降级。
 */
async function renameWithRetry(tmp: string, file: string): Promise<void> {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  let lastErr: unknown;
  for (const delay of [0, 50, 100]) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!transient.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
    }
  }
  throw lastErr;
}

async function writeStore(store: HistoryStore): Promise<boolean> {
  const file = getHistoryFile();
  const tmp = `${file}.tmp`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
    await renameWithRetry(tmp, file); // 原子替换，避免半写状态；瞬态锁定重试见函数注释
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await fsp.stat(file)).mtimeMs;
    } catch {
      /* stat 失败则 mtimeMs=null，下次读重新加载（多一次读盘，正确性不受影响） */
    }
    storeCache = { file, store, mtimeMs, memoryAuthoritative: false }; // 写后更新缓存
    return true;
  } catch {
    // 写失败（重试后仍失败）：**保留内存 store 作为权威**，并跳过 mtime 校验。
    // rename 失败时盘上旧文件未被动过（原子替换要么成功要么没发生），
    // 此前清缓存会让下次 readStore 从旧盘重建——本次已完成的条目新增/
    // 去重更新/时间线追加被静默回滚（丢用户研究历史）；保留缓存则盘暂时
    // 滞后一条，下一次 writeStore 全量重写时自动追上。tmp 残留一并
    // best-effort 清理（不影响正确性，只是不留孤儿文件）。
    storeCache = { file, store, mtimeMs: null, memoryAuthoritative: true };
    try {
      await fsp.unlink(tmp);
    } catch {
      /* tmp 可能尚未创建 */
    }
    return false;
  }
}

/**
 * 「读-改-写」串行队列：saveHistoryEntry/deleteHistoryItem 都是先读快照、内存修改、
 * 再全量写回。异步化后若不做串行化，两个并发保存会在 await 点交错——各自拿着
 * 旧快照写回，后写覆盖先写（丢失更新）。队列把整个变更操作串行执行，读操作
 * （list/get/getPrevious）不进队列，保持并发吞吐。
 */
let mutationQueue: Promise<unknown> = Promise.resolve();
function enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(op, op); // 前序失败不阻塞后续变更
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
): Promise<HistoryItem | null> {
  return enqueueMutation(async () => {
    const store = reuseStore && Array.isArray(reuseStore.items) ? reuseStore : await readStore();
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

    if (!(await writeStore(store))) return null;
    return saved;
  });
}

/** 历史列表（倒序，最新在前；不含完整 result，仅摘要字段 + 精简时间线） */
export async function listHistory(limit = 50): Promise<HistorySummary[]> {
  const store = await readStore();
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
export async function getPreviousAnalysis(stockCode: string): Promise<HistorySummary | null> {
  const store = await readStore();
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
export async function getHistoryItem(id: string): Promise<HistoryItem | null> {
  const store = await readStore();
  return store.items.find((it) => it.id === id) ?? null;
}

/** 删除一条历史记录；返回是否删除成功 */
export function deleteHistoryItem(id: string): Promise<boolean> {
  return enqueueMutation(async () => {
    const store = await readStore();
    const next = store.items.filter((it) => it.id !== id);
    if (next.length === store.items.length) return false;
    store.items = next;
    return writeStore(store);
  });
}

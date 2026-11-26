/**
 * 研究历史记录（SQLite 持久层）
 * ----------------------------------------------------------------------------
 * 每次股票分析完成时自动保存（同股票代码去重更新，保持每只股票仅一条最新记录），
 * 前端历史页可列出、回看（恢复完整分析结果）与删除。
 * 去重会覆盖旧结果，因此额外保留一份「精简时间线」（每只股票最近 N 条
 * {date,score,rating}），否则用户无法回答"观点怎么变的"——只能看到最新一份快照。
 *
 * 为什么从 JSON 换成 SQLite（2026-11）：
 * 旧实现是「单 JSON 文件 + 默认 100 条上限」。100 条不是产品上限，而是性能妥协：
 * 整库 JSON.parse/序列化随条数线性变慢（满额约 14.7MB），历史条目越有价值越不敢留。
 * 现在改用 Node 24 内置的 `node:sqlite`（零新依赖）：
 *  - 列表/详情/去重全部走索引查询，不再整库解析；
 *  - 默认保留 2000 条（`HISTORY_MAX_ITEMS` 或设置页仍可覆盖），长期使用不会
 *    因为"文件太大"而被迫丢弃研究结论；
 *  - 首次启动自动把旧 `history.json` 迁入并留档（`.migrated-<ts>`），不丢历史。
 *
 * 保留的既有语义（刻意逐条对齐）：
 *  - **损坏留档**：数据库文件无法打开/自检失败时，改名为 `.corrupt-<ts>` 后按空库
 *    重建；留档失败（权限/锁定）则禁止写入，宁可本次保存失败，也不覆盖唯一副本。
 *    旧 JSON 迁移时遇到损坏文件走同一处置（损坏且无法留档 → 禁止写入）。
 *  - **写入保护**：写失败只记 warning，返回 null，不阻断分析主流程。
 *  - **串行化**：变更仍经进程内队列，API 语义（Promise）不变；SQLite 事务保证
 *    去重、时间线追加、容量淘汰原子完成。
 *  - **严格单调 createdAt**：同毫秒连续保存时 +1ms，容量淘汰语义稳定。
 *
 * 路径：
 *  - `HISTORY_DB_FILE` 显式指定数据库文件；
 *  - 未设置但设了 `HISTORY_FILE`（旧 JSON 路径）时，数据库落在同目录同名 `.db`
 *    （测试/冒烟只重定向 HISTORY_FILE 也能天然隔离）；
 *  - 否则默认 `server/data/history.db`。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DATA_ROOT } from '../dataRoot.js';
import type { AnalysisResult } from '../types.js';
import logger from '../utils/logger.js';
import { resolveHistoryMaxItems } from './settings.js';

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

/** 默认保留条数：SQLite 下不再受「整库解析」约束，默认从 100 提高到 2000 */
export const DEFAULT_HISTORY_MAX_ITEMS = 2000;
/** 硬上限：再大就超出「本地单机研究历史」的合理体量 */
const HARD_MAX_HISTORY_ITEMS = 50_000;
/** 每只股票保留的时间线长度上限：只留最近 N 次，避免列表响应体随使用时长膨胀 */
export const MAX_TIMELINE_POINTS = 20;

/**
 * 运行时解析历史容量：设置页 > `HISTORY_MAX_ITEMS` > 默认 2000（整数，1–50000）。
 * 非法环境变量静默回落默认值，避免一条写错的环境变量把历史裁剪成 0 条。
 */
export function historyMaxItemsStatus(): {
  value: number;
  source: 'settings' | 'env' | 'default';
} {
  const raw = process.env.HISTORY_MAX_ITEMS?.trim();
  let envOverride: number | null = null;
  if (raw) {
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1) {
      envOverride = Math.min(value, HARD_MAX_HISTORY_ITEMS);
    }
  }
  return resolveHistoryMaxItems(DEFAULT_HISTORY_MAX_ITEMS, envOverride);
}

/** 当前生效的历史保留条数 */
export function maxHistoryItems(): number {
  return historyMaxItemsStatus().value;
}

/** 容量硬上限（设置页展示/校验用） */
export const HISTORY_MAX_ITEMS_HARD_LIMIT = HARD_MAX_HISTORY_ITEMS;

/** 旧版 JSON 历史路径：仅作为一次性迁移来源（也用于推导默认 DB 路径） */
function legacyJsonPath(): string {
  const explicit = process.env.HISTORY_FILE?.trim();
  return explicit && explicit.length > 0 ? explicit : path.join(DATA_ROOT, 'history.json');
}

/** SQLite 数据库路径（见文件头「路径」说明） */
export function historyDbPath(): string {
  const explicit = process.env.HISTORY_DB_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const legacy = process.env.HISTORY_FILE?.trim();
  if (legacy && legacy.length > 0) {
    return /\.json$/i.test(legacy) ? legacy.replace(/\.json$/i, '.db') : `${legacy}.db`;
  }
  return path.join(DATA_ROOT, 'history.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history_items (
  id          TEXT PRIMARY KEY,
  stock_code  TEXT NOT NULL UNIQUE,
  stock_name  TEXT NOT NULL,
  industry    TEXT,
  rating      TEXT NOT NULL,
  total_score REAL NOT NULL,
  created_at  TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_items_created_at ON history_items(created_at DESC);
CREATE TABLE IF NOT EXISTS history_timeline (
  history_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  point_date  TEXT NOT NULL,
  score       REAL NOT NULL,
  rating      TEXT NOT NULL,
  PRIMARY KEY (history_id, seq),
  FOREIGN KEY (history_id) REFERENCES history_items(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS history_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface DbState {
  path: string;
  db: DatabaseSync | null;
  /** 文件损坏且无法留档：读按空历史、写一律拒绝（不覆盖唯一副本） */
  writeProtected: boolean;
}

let state: DbState | null = null;

function closeState(): void {
  if (state?.db) {
    try {
      state.db.close();
    } catch {
      /* 关闭失败不影响后续重建 */
    }
  }
  state = null;
}

/**
 * 清空数据库连接并丢弃缓存：供测试隔离、或外部改写了 DB 文件后强制重开
 * （常规运行无需调用；SQLite 自身保证读到已提交数据）。
 */
export function resetHistoryStoreCache(): void {
  closeState();
}

/** 显式关闭连接（优雅关闭 / 测试 teardown 释放文件句柄，Windows 上才能删除临时目录） */
export function closeHistoryStore(): void {
  closeState();
}

/** 只处理普通文件：目录绝不改名（会把整棵目录搬走） */
function quarantineDbFile(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  const target = `${file}.corrupt-${Date.now()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(file, target);
      // WAL/SHM 属于同一份数据库，一并挪走，避免新库被旧日志干扰
      for (const suffix of ['-wal', '-shm']) {
        try {
          if (fs.existsSync(`${file}${suffix}`))
            fs.renameSync(`${file}${suffix}`, `${target}${suffix}`);
        } catch {
          /* 附属文件挪不走不致命 */
        }
      }
      logger.warn('研究历史数据库损坏，已改名留档并按空库重建（历史需人工恢复）', {
        file,
        backup: target,
      });
      return true;
    } catch (error) {
      if (attempt === 2) {
        logger.error('研究历史数据库损坏且无法留档，已禁止写入以免覆盖原文件', {
          file,
          err: error,
        });
        return false;
      }
    }
  }
  return false;
}

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const verdict = check ? String(Object.values(check)[0] ?? '') : '';
    if (verdict !== 'ok') {
      throw new Error(`SQLite quick_check 未通过：${verdict || 'unknown'}`);
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      /* 打开过程中的异常已由外层处置 */
    }
    throw error;
  }
}

/** 打开（或复用）数据库；打不开时返回「写保护」状态而不是抛错，保证读接口始终可用 */
function ensureState(): DbState {
  const file = historyDbPath();
  if (state && state.path === file) return state;
  if (state) closeState();

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    logger.error('研究历史目录创建失败，本次按空历史处理且禁止写入', { file, err: error });
    state = { path: file, db: null, writeProtected: true };
    return state;
  }

  let db: DatabaseSync;
  try {
    db = openDatabase(file);
  } catch (error) {
    logger.error('研究历史数据库打开失败', { file, err: error });
    if (!quarantineDbFile(file)) {
      state = { path: file, db: null, writeProtected: true };
      return state;
    }
    try {
      db = openDatabase(file);
    } catch (retryError) {
      logger.error('研究历史数据库重建失败，本次按空历史处理且禁止写入', {
        file,
        err: retryError,
      });
      state = { path: file, db: null, writeProtected: true };
      return state;
    }
  }

  state = { path: file, db, writeProtected: false };
  migrateLegacyJson(state);
  return state;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO history_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM history_meta WHERE key = ?').get(key) as
    { value?: string } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

/** 留档旧 JSON；失败返回 false（此时禁止写入，避免旧文件是唯一副本却被无视） */
function quarantineLegacyJson(file: string): boolean {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    logger.warn('旧研究历史 JSON 损坏，已改名留档并按空库继续（历史需人工恢复）', { file });
    return true;
  } catch (error) {
    logger.error('旧研究历史 JSON 损坏且无法留档，已禁止写入以免覆盖原文件', { file, err: error });
    return false;
  }
}

/**
 * 首次打开时把旧 `history.json` 一次性迁入 SQLite，并把原文件改名为 `.migrated-<ts>`。
 * 迁移成功后写 meta 标记；失败（含损坏留档失败）也会写标记——否则每次启动都会
 * 重复处理同一个坏文件，并在每轮留下新的 `.corrupt-*`。
 */
function migrateLegacyJson(current: DbState): void {
  const db = current.db;
  if (!db) return;
  if (getMeta(db, 'legacy_json_migrated')) return;
  const legacy = legacyJsonPath();
  if (path.resolve(legacy) === path.resolve(current.path)) {
    setMeta(db, 'legacy_json_migrated', new Date().toISOString());
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(legacy, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      setMeta(db, 'legacy_json_migrated', new Date().toISOString());
      return;
    }
    logger.warn('旧研究历史 JSON 读取失败，本次跳过迁移（文件保持原样）', { legacy, err: error });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn('旧研究历史 JSON 解析失败，按损坏文件处置', { legacy, err: error });
    if (!quarantineLegacyJson(legacy)) current.writeProtected = true;
    setMeta(db, 'legacy_json_migrated', new Date().toISOString());
    return;
  }

  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    logger.warn('旧研究历史 JSON 结构非法（缺少 items 数组），按损坏文件处置', { legacy });
    if (!quarantineLegacyJson(legacy)) current.writeProtected = true;
    setMeta(db, 'legacy_json_migrated', new Date().toISOString());
    return;
  }

  let imported = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const rawItem of items) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as Partial<HistoryItem>;
        if (
          typeof item.id !== 'string' ||
          typeof item.stockCode !== 'string' ||
          typeof item.createdAt !== 'string'
        ) {
          continue;
        }
        const result = item.result;
        if (!result || typeof result !== 'object') continue;
        db.prepare(
          `INSERT INTO history_items (id, stock_code, stock_name, industry, rating, total_score, created_at, result_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(stock_code) DO UPDATE SET
             stock_name = excluded.stock_name,
             industry = excluded.industry,
             rating = excluded.rating,
             total_score = excluded.total_score,
             created_at = excluded.created_at,
             result_json = excluded.result_json`,
        ).run(
          item.id,
          item.stockCode,
          typeof item.stockName === 'string' ? item.stockName : item.stockCode,
          typeof item.industry === 'string' ? item.industry : null,
          typeof item.rating === 'string' ? item.rating : '',
          Number.isFinite(item.totalScore) ? Number(item.totalScore) : 0,
          item.createdAt,
          JSON.stringify(result),
        );
        const row = db
          .prepare('SELECT id FROM history_items WHERE stock_code = ?')
          .get(item.stockCode) as { id?: string } | undefined;
        const timeline = sanitizeTimeline(item.timeline);
        if (row?.id && timeline.length > 0) {
          replaceTimeline(db, row.id, timeline);
        }
        imported += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    logger.warn('旧研究历史迁移失败，原文件保持原样（下次启动会重试）', { legacy, err: error });
    return;
  }

  try {
    fs.renameSync(legacy, `${legacy}.migrated-${Date.now()}`);
  } catch (error) {
    // 迁移已完成：原文件挪不走不致命，用 meta 标记阻止重复导入即可
    logger.warn('旧研究历史已迁移，但原文件改名失败（已用标记避免重复导入）', {
      legacy,
      err: error,
    });
  }
  setMeta(db, 'legacy_json_migrated', new Date().toISOString());
  logger.info('研究历史已从 JSON 迁移到 SQLite', { legacy, imported });
}

/**
 * 「读-改-写」串行队列：SQLite 单条写入很快，但文件名/路径可能在调用间变化，
 * 且 saveHistoryEntry 依赖「先查再写」的事务一致性。队列保证同一进程内的
 * 保存/删除按调用顺序执行；读操作不进队列，保持并发吞吐。
 */
let mutationQueue: Promise<unknown> = Promise.resolve();
function enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(op, op);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 毫秒级单调时钟：快速连续保存可能落在同一毫秒，createdAt 相同会让容量淘汰
// 依赖查询排序的不确定性（结果错误：淘汰的是后保存的）。同毫秒强制 +1ms。
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

/** 追加一个时间线点并裁剪到上限；旧数据缺时间线时用「将被覆盖的那次快照」补种起点 */
function appendTimeline(
  existing: { createdAt: string; totalScore: number; rating: string } | null,
  points: HistoryTimelinePoint[],
  nowIso: string,
  input: HistoryEntryInput,
): HistoryTimelinePoint[] {
  const next = sanitizeTimeline(points);
  if (next.length === 0 && existing && typeof existing.createdAt === 'string') {
    next.push({
      date: existing.createdAt.slice(0, 10),
      score: existing.totalScore,
      rating: existing.rating,
    });
  }
  next.push({ date: nowIso.slice(0, 10), score: input.totalScore, rating: input.rating });
  return next.slice(-MAX_TIMELINE_POINTS);
}

function replaceTimeline(
  db: DatabaseSync,
  historyId: string,
  points: HistoryTimelinePoint[],
): void {
  db.prepare('DELETE FROM history_timeline WHERE history_id = ?').run(historyId);
  const insert = db.prepare(
    'INSERT INTO history_timeline (history_id, seq, point_date, score, rating) VALUES (?, ?, ?, ?, ?)',
  );
  points.slice(-MAX_TIMELINE_POINTS).forEach((point, index) => {
    insert.run(historyId, index, point.date, point.score, point.rating);
  });
}

function readTimeline(db: DatabaseSync, historyId: string): HistoryTimelinePoint[] {
  const rows = db
    .prepare(
      'SELECT point_date, score, rating FROM history_timeline WHERE history_id = ? ORDER BY seq ASC',
    )
    .all(historyId) as { point_date?: string; score?: number; rating?: string }[];
  return sanitizeTimeline(
    rows.map((r) => ({ date: r.point_date, score: r.score, rating: r.rating })),
  );
}

interface SummaryRow {
  id: string;
  stock_code: string;
  stock_name: string;
  industry: string | null;
  rating: string;
  total_score: number;
  created_at: string;
}

const SUMMARY_COLUMNS = 'id, stock_code, stock_name, industry, rating, total_score, created_at';

/**
 * SQLite 返回的行是 `Record<string, SQLOutputValue>`（类型层面未知）。
 * 这里做一次边界收敛：字段类型不符的行直接丢弃（视为损坏数据），
 * 而不是用 `as` 把未知值硬转成业务类型——后者会让损坏行一路透到接口。
 */
function coerceSummaryRow(row: unknown): SummaryRow | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.stock_code !== 'string' ||
    typeof r.stock_name !== 'string' ||
    typeof r.rating !== 'string' ||
    typeof r.created_at !== 'string'
  ) {
    return null;
  }
  const score = Number(r.total_score);
  if (!Number.isFinite(score)) return null;
  return {
    id: r.id,
    stock_code: r.stock_code,
    stock_name: r.stock_name,
    industry: typeof r.industry === 'string' ? r.industry : null,
    rating: r.rating,
    total_score: score,
    created_at: r.created_at,
  };
}

function toSummary(row: SummaryRow, timeline: HistoryTimelinePoint[]): HistorySummary {
  const summary: HistorySummary = {
    id: row.id,
    stockCode: row.stock_code,
    stockName: row.stock_name,
    createdAt: row.created_at,
    rating: row.rating,
    totalScore: Number(row.total_score),
  };
  if (typeof row.industry === 'string' && row.industry.length > 0) {
    summary.industry = row.industry;
  }
  if (timeline.length > 0) summary.timeline = timeline;
  return summary;
}

/** 列表用的时间线：一条 SQL 取回本页所有 id 的点，避免 N+1 查询 */
function timelinesFor(db: DatabaseSync, ids: string[]): Map<string, HistoryTimelinePoint[]> {
  const grouped = new Map<string, HistoryTimelinePoint[]>();
  if (ids.length === 0) return grouped;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT history_id, point_date, score, rating FROM history_timeline
       WHERE history_id IN (${placeholders}) ORDER BY history_id, seq ASC`,
    )
    .all(...ids) as {
    history_id?: string;
    point_date?: string;
    score?: number;
    rating?: string;
  }[];
  for (const row of rows) {
    if (typeof row.history_id !== 'string') continue;
    if (typeof row.point_date !== 'string' || !Number.isFinite(row.score)) continue;
    const list = grouped.get(row.history_id) ?? [];
    list.push({
      date: row.point_date,
      score: Number(row.score),
      rating: typeof row.rating === 'string' ? row.rating : '',
    });
    grouped.set(row.history_id, list);
  }
  for (const [id, points] of grouped) grouped.set(id, points.slice(-MAX_TIMELINE_POINTS));
  return grouped;
}

/**
 * 保存/更新一条历史记录：同股票代码去重（更新为最新分析，id 保留），
 * 容量超上限时淘汰最旧记录。返回保存后的条目；写盘失败/写保护返回 null
 * （不阻断分析主流程）。
 */
export function saveHistoryEntry(input: HistoryEntryInput): Promise<HistoryItem | null> {
  return enqueueMutation(async () => {
    const current = ensureState();
    if (!current.db || current.writeProtected) {
      logger.error('研究历史数据库不可写，本次保存已放弃（请人工修复落盘文件）', {
        file: current.path,
      });
      return null;
    }
    const db = current.db;
    const now = monotonicNowIso();

    try {
      db.exec('BEGIN IMMEDIATE');
      let saved: HistoryItem;
      try {
        const existing = db
          .prepare(
            'SELECT id, stock_code, stock_name, industry, rating, total_score, created_at FROM history_items WHERE stock_code = ?',
          )
          .get(input.stockCode) as SummaryRow | undefined;

        if (existing) {
          const previousPoints = readTimeline(db, existing.id);
          const timeline = appendTimeline(
            {
              createdAt: existing.created_at,
              totalScore: Number(existing.total_score),
              rating: existing.rating,
            },
            previousPoints,
            now,
            input,
          );
          db.prepare(
            `UPDATE history_items SET stock_name = ?, industry = ?, rating = ?, total_score = ?,
               created_at = ?, result_json = ? WHERE id = ?`,
          ).run(
            input.stockName,
            input.industry ?? null,
            input.rating,
            input.totalScore,
            now,
            JSON.stringify(input.result),
            existing.id,
          );
          replaceTimeline(db, existing.id, timeline);
          saved = {
            id: existing.id,
            stockCode: input.stockCode,
            stockName: input.stockName,
            createdAt: now,
            rating: input.rating,
            totalScore: input.totalScore,
            result: input.result,
            timeline,
          };
          if (input.industry) saved.industry = input.industry;
        } else {
          const id = makeId();
          db.prepare(
            `INSERT INTO history_items (id, stock_code, stock_name, industry, rating, total_score, created_at, result_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            input.stockCode,
            input.stockName,
            input.industry ?? null,
            input.rating,
            input.totalScore,
            now,
            JSON.stringify(input.result),
          );
          const timeline: HistoryTimelinePoint[] = [
            { date: now.slice(0, 10), score: input.totalScore, rating: input.rating },
          ];
          replaceTimeline(db, id, timeline);
          saved = {
            id,
            stockCode: input.stockCode,
            stockName: input.stockName,
            createdAt: now,
            rating: input.rating,
            totalScore: input.totalScore,
            result: input.result,
            timeline,
          };
          if (input.industry) saved.industry = input.industry;
        }

        enforceCapacity(db, maxHistoryItems());
        db.exec('COMMIT');
        return saved;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      logger.warn('研究历史写入失败，本次保存已放弃', { file: current.path, err: error });
      return null;
    }
  });
}

/** 容量上限：按 createdAt 倒序保留最新 N 条，其余连时间线一并删除（外键 CASCADE） */
function enforceCapacity(db: DatabaseSync, limit: number): void {
  const row = db.prepare('SELECT COUNT(*) AS c FROM history_items').get() as
    { c?: number } | undefined;
  const count = Number(row?.c ?? 0);
  if (count <= limit) return;
  db.prepare(
    `DELETE FROM history_items WHERE id IN (
       SELECT id FROM history_items ORDER BY created_at DESC LIMIT -1 OFFSET ?
     )`,
  ).run(limit);
}

/** 历史列表（倒序，最新在前；不含完整 result，仅摘要字段 + 精简时间线） */
export async function listHistory(limit = 50): Promise<HistorySummary[]> {
  const current = ensureState();
  if (!current.db) return [];
  const db = current.db;
  const normalized = Math.max(1, Math.min(limit, 200));
  const rows = db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM history_items ORDER BY created_at DESC LIMIT ?`)
    .all(normalized)
    .map(coerceSummaryRow)
    .filter((row): row is SummaryRow => row !== null);
  if (rows.length === 0) return [];
  const timelines = timelinesFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toSummary(row, timelines.get(row.id) ?? []));
}

/**
 * 该股票上一次分析的摘要（记忆反思闭环用）：
 * 在 saveHistoryEntry 之前调用，返回同股票当前最新记录（即"上一次分析"）；
 * 无记录返回 null。
 */
export async function getPreviousAnalysis(stockCode: string): Promise<HistorySummary | null> {
  const current = ensureState();
  if (!current.db) return null;
  const db = current.db;
  const row = db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM history_items WHERE stock_code = ?`)
    .get(stockCode) as SummaryRow | undefined;
  if (!row) return null;
  return toSummary(row, readTimeline(db, row.id));
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
  const current = ensureState();
  if (!current.db) return null;
  const db = current.db;
  const row = db
    .prepare(`SELECT ${SUMMARY_COLUMNS}, result_json FROM history_items WHERE id = ?`)
    .get(id) as (SummaryRow & { result_json?: string }) | undefined;
  if (!row) return null;

  let result: AnalysisResult;
  try {
    result = JSON.parse(String(row.result_json)) as AnalysisResult;
  } catch (error) {
    logger.warn('研究历史详情内容损坏，无法恢复报告', { id, err: error });
    return null;
  }
  return { ...toSummary(row, readTimeline(db, row.id)), result };
}

/** 删除一条历史记录；返回是否删除成功 */
export function deleteHistoryItem(id: string): Promise<boolean> {
  return enqueueMutation(async () => {
    const current = ensureState();
    if (!current.db || current.writeProtected) return false;
    try {
      const res = current.db.prepare('DELETE FROM history_items WHERE id = ?').run(id);
      return Number(res.changes) > 0;
    } catch (error) {
      logger.warn('研究历史删除失败', { id, err: error });
      return false;
    }
  });
}

/**
 * 按当前容量上限立即裁剪（设置页把上限调低后调用）。
 * 不裁剪的话，用户看到「已设为 500」但列表仍是 2000 条，要等下一次保存才生效。
 */
export function trimHistoryToLimit(): Promise<void> {
  return enqueueMutation(async () => {
    const current = ensureState();
    if (!current.db || current.writeProtected) return;
    try {
      current.db.exec('BEGIN IMMEDIATE');
      try {
        enforceCapacity(current.db, maxHistoryItems());
        current.db.exec('COMMIT');
      } catch (error) {
        current.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      logger.warn('研究历史容量裁剪失败', { file: current.path, err: error });
    }
  });
}

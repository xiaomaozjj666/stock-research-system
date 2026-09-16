import * as fs from 'fs';
import * as path from 'path';
import type { WatchlistAlert } from './alerts.js';

/**
 * 自选股/持仓监控清单（Watchlist）
 * ----------------------------------------------------------------------------
 * 轻量级持久化：把用户关注的 6 位股票代码存在 server/data/watchlist.json。
 * 设计要点：
 *  - 路径在「每次调用时」解析（支持测试用 process.env.WATCHLIST_FILE 重定向），
 *    便于单测用临时文件，无需依赖模块级单例。
 *  - 写入前校验代码格式（6 位数字），去重，保持顺序稳定。
 *  - 所有读写失败都降级为内存空表，不抛错（监控功能不应拖垮主进程）。
 *
 * 本文件同时承担「最近一次异动监控快照」的落盘（见文件下半部分）：
 * 两者同属自选股监控域，合并在一处可避免为一个字段级存储再开模块。
 */

const DEFAULT_FILE = path.join(import.meta.dirname, '..', 'data', 'watchlist.json');

function storeFile(): string {
  return process.env.WATCHLIST_FILE && process.env.WATCHLIST_FILE.length > 0
    ? process.env.WATCHLIST_FILE
    : DEFAULT_FILE;
}

function isValidCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** 从磁盘读取清单（文件不存在/损坏 → 返回 []，不抛） */
export function getWatchlist(): string[] {
  try {
    const file = storeFile();
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 仅保留合法代码，去重保序
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of parsed) {
      if (typeof c === 'string' && isValidCode(c) && !seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 覆盖式写入完整清单（已校验/去重），返回写入后的清单 */
function persist(codes: string[]): string[] {
  try {
    const file = storeFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(codes, null, 2), 'utf-8');
  } catch {
    /* 写入失败不影响内存态 */
  }
  return codes;
}

/** 新增一只（去重）。返回最新清单。非法代码返回原清单且不写入。 */
export function addToWatchlist(code: string): string[] {
  if (!isValidCode(code)) return getWatchlist();
  const cur = getWatchlist();
  if (cur.includes(code)) return cur;
  return persist([...cur, code]);
}

/** 移除一只（若不存在也返回原清单，幂等）。 */
export function removeFromWatchlist(code: string): string[] {
  const cur = getWatchlist();
  const next = cur.filter((c) => c !== code);
  if (next.length === cur.length) return cur;
  return persist(next);
}

/** 批量设置清单（用于导入/全量替换）。自动校验+去重。 */
export function setWatchlist(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) {
    if (typeof c === 'string' && isValidCode(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return persist(out);
}

/* ============================================================================
 * 最近一次异动监控快照（落盘，供页面刷新/复访回看）
 * ----------------------------------------------------------------------------
 * 监控是分钟级动作，结果只回给当次请求的话，用户一离开页面/刷新就丢——
 * 预警能力建好了却触达不到人。因此把「最近一次」结果落盘：
 *   - 路径支持 WATCHLIST_ALERTS_FILE 重定向（与 WATCHLIST_FILE 同模式）。
 *   - 只保留最近一次快照（覆盖写）：预警有时效，堆历史快照既无意义又会无限增长；
 *     条数上限作用在 alerts 数组上，防止单轮异动把文件撑大。
 *   - 「临时文件 + rename」原子写：进程若在写盘中途被杀，读侧也不会看到半截 JSON。
 *   - 读取失败/文件损坏一律返回稳定空结构（不抛、不 404），前端只需一条渲染分支。
 * ==========================================================================*/

/** 最近一次监控快照（GET /api/watchlist/alerts 的响应结构） */
export interface WatchlistAlertsSnapshot {
  /** 快照生成时间（ISO）；从未监控过时为 null */
  generatedAt: string | null;
  /** 本轮监控覆盖的股票数 */
  monitored: number;
  /** 异动预警条目 */
  alerts: WatchlistAlert[];
}

/** 单份快照的预警条数上限：文件大小不随自选股/新闻量无限增长 */
export const MAX_ALERTS_PER_SNAPSHOT = 200;

const DEFAULT_ALERTS_FILE = path.join(import.meta.dirname, '..', 'data', 'watchlistAlerts.json');

/** 快照文件路径：每次调用时解析，测试用 WATCHLIST_ALERTS_FILE 重定向到临时文件 */
function alertsFile(): string {
  return process.env.WATCHLIST_ALERTS_FILE && process.env.WATCHLIST_ALERTS_FILE.length > 0
    ? process.env.WATCHLIST_ALERTS_FILE
    : DEFAULT_ALERTS_FILE;
}

/** 稳定的空快照：前端不必区分「无快照」与「读失败」两条分支 */
function emptySnapshot(): WatchlistAlertsSnapshot {
  return { generatedAt: null, monitored: 0, alerts: [] };
}

/**
 * 只保留结构合法的预警条目并裁剪到上限。
 * 文件可能被手改或由旧版本写入，脏数据不应让接口 500，也不应把脏字段透给前端。
 */
function sanitizeAlerts(value: unknown): WatchlistAlert[] {
  if (!Array.isArray(value)) return [];
  const out: WatchlistAlert[] = [];
  for (const raw of value) {
    if (out.length >= MAX_ALERTS_PER_SNAPSHOT) break; // 上限裁剪：先到先留
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Partial<WatchlistAlert>;
    if (typeof a.code !== 'string' || typeof a.detail !== 'string') continue;
    if (a.level !== 'strong-bull' && a.level !== 'strong-bear' && a.level !== 'high-impact') {
      continue;
    }
    out.push({
      code: a.code,
      name: typeof a.name === 'string' ? a.name : null,
      level: a.level,
      polarity: Number.isFinite(a.polarity) ? Number(a.polarity) : 0,
      weightedImpact: Number.isFinite(a.weightedImpact) ? Number(a.weightedImpact) : 0,
      detail: a.detail,
    });
  }
  return out;
}

/**
 * 规范化快照（裁剪条数上限 + 收敛脏值）。
 * 落盘与 HTTP 响应共用同一份，避免出现「前端看到 300 条、磁盘只剩 200 条」的不一致。
 */
export function normalizeAlertsSnapshot(input: {
  generatedAt: string | null;
  monitored: number;
  alerts: WatchlistAlert[];
}): WatchlistAlertsSnapshot {
  const monitored = Number.isFinite(input.monitored) ? Math.max(0, Math.floor(input.monitored)) : 0;
  return {
    generatedAt: typeof input.generatedAt === 'string' ? input.generatedAt : null,
    monitored,
    alerts: sanitizeAlerts(input.alerts),
  };
}

/** 读取最近一次监控快照；无文件 / 损坏 / 从未监控 → 稳定空结构（不抛错） */
export function getWatchlistAlertsSnapshot(): WatchlistAlertsSnapshot {
  try {
    const file = alertsFile();
    if (!fs.existsSync(file)) return emptySnapshot();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<WatchlistAlertsSnapshot>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptySnapshot();
    return normalizeAlertsSnapshot({
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
      monitored: Number(parsed.monitored) || 0,
      alerts: sanitizeAlerts(parsed.alerts),
    });
  } catch {
    // 文件损坏/不可读：视为「还没监控过」，监控能力本身不受影响
    return emptySnapshot();
  }
}

/**
 * 覆盖写入最近一次监控快照（原子写）。返回是否落盘成功；
 * 失败只静默降级——调用方此刻已经把结果返回给用户了，写盘失败不该让监控请求失败。
 */
export function saveWatchlistAlertsSnapshot(snapshot: WatchlistAlertsSnapshot): boolean {
  const file = alertsFile();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换：读侧永远看到完整 JSON
    return true;
  } catch {
    // 失败清理临时文件，避免 rename 失败（如目标被占用）时留下 .tmp 残留
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 清理失败也不再抛 */
    }
    return false;
  }
}

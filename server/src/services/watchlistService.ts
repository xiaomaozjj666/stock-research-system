import * as fs from 'fs';
import * as path from 'path';
import type { WatchlistAlert } from './alerts.js';
import logger from '../utils/logger.js';
import { normalizeAShareCode } from '../utils/stockCode.js';

/**
 * 自选股/持仓监控清单（Watchlist）
 * ----------------------------------------------------------------------------
 * 轻量级持久化：把用户关注的 6 位股票代码存在 server/data/watchlist.json。
 * 设计要点：
 *  - 路径在「每次调用时」解析（支持测试用 process.env.WATCHLIST_FILE 重定向），
 *    便于单测用临时文件，无需依赖模块级单例。
 *  - 写入前校验代码格式（6 位数字，统一走 utils/stockCode 的闸门），去重，保持顺序稳定。
 *  - **条数有上限**（默认 200，WATCHLIST_MAX 可调，见 watchlistMax）：清单会被下游
 *    批量回测/监控整表消费，无上限等于给「一次请求跑几百只股票」留后门。
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
  return normalizeAShareCode(code) !== null;
}

/* ============================================================================
 * 清单容量（条数上限）
 * ----------------------------------------------------------------------------
 * 为什么需要：addToWatchlist 原本无上限，清单可被无限撑大；而 /api/watchlist/monitor
 * 会对**整张清单**跑长任务（逐只拉 2 年 K 线 + 新闻）。无上限时单个用户可以
 * 用一个 POST 循环把服务推进「一次请求几百只股票」的深水区。
 * 超限时由调用方（路由）返回**可操作的 400**（说明上限与如何清理），
 * 而不是静默截断——静默截断会让用户以为已经加进去了。
 * ==========================================================================*/

/** 清单条数上限默认值（WATCHLIST_MAX 可覆盖） */
export const DEFAULT_WATCHLIST_MAX = 200;

/**
 * 当前清单容量上限：每次调用时解析环境变量，便于测试与运行期调整。
 * 非法值（NaN / ≤0 / 小数）一律回落默认值：容量配错不该把写入口变成「永远 400」。
 */
export function watchlistMax(): number {
  const raw = Number(process.env.WATCHLIST_MAX);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_WATCHLIST_MAX;
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

/**
 * 新增一只（去重）。返回最新清单。
 * - 非法代码：返回原清单且不写入；
 * - 已达上限：同样返回原清单且不写入（调用方应在写入前用 `watchlistMax()` 预检并
 *   返回可操作的 400；这里再守一道，防止其它调用方绕过容量上限）。
 */
export function addToWatchlist(code: string): string[] {
  const normalized = normalizeAShareCode(code);
  if (normalized === null) return getWatchlist();
  const cur = getWatchlist();
  if (cur.includes(normalized)) return cur;
  if (cur.length >= watchlistMax()) return cur;
  return persist([...cur, normalized]);
}

/** 移除一只（若不存在也返回原清单，幂等）。非法代码按「不存在」处理，不写入。 */
export function removeFromWatchlist(code: string): string[] {
  const normalized = normalizeAShareCode(code);
  if (normalized === null) return getWatchlist();
  const cur = getWatchlist();
  const next = cur.filter((c) => c !== normalized);
  if (next.length === cur.length) return cur;
  return persist(next);
}

/**
 * 批量设置清单（用于导入/全量替换）。自动校验+去重。
 * 与逐只新增一致地受容量上限约束：超过上限的部分**不写入**并打 warn 留痕
 * （本函数没有 HTTP 出口，无法回可操作 400；调用方若需强提示应先自行预检条数）。
 */
export function setWatchlist(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const max = watchlistMax();
  for (const c of codes) {
    const normalized = normalizeAShareCode(c);
    if (normalized === null || seen.has(normalized)) continue;
    if (out.length >= max) {
      logger.warn('[watchlist] 批量设置超过清单上限，超出部分未写入', {
        max,
        requested: codes.length,
      });
      break;
    }
    seen.add(normalized);
    out.push(normalized);
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
  /** 本轮监控实际取数的股票数 */
  monitored: number;
  /** 异动预警条目 */
  alerts: WatchlistAlert[];
  /**
   * 本轮请求的清单总只数（monitor 单次上限裁剪前的只数）。
   * 只在发生过上限裁剪时出现，用于让「monitored < requested」这件事可解释。
   */
  requested?: number;
  /**
   * 因单次上限被跳过、本轮**未取数**的只数。
   * 关键点：这是如实披露而非静默降级——清单 200 只而上限 20 时，
   * 用户必须能从响应里看出「只监控了前 20 只，还有 180 只没看」。
   */
  skipped?: number;
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
 * requested/skipped 仅在**真的发生了上限裁剪**（skipped > 0）时输出：
 * 没有裁剪时响应结构与既有契约逐字一致，前端老代码不必感知新字段。
 */
export function normalizeAlertsSnapshot(input: {
  generatedAt: string | null;
  monitored: number;
  alerts: WatchlistAlert[];
  requested?: number;
  skipped?: number;
}): WatchlistAlertsSnapshot {
  const monitored = Number.isFinite(input.monitored) ? Math.max(0, Math.floor(input.monitored)) : 0;
  const requested =
    Number.isFinite(input.requested) && Number(input.requested) > 0
      ? Math.floor(Number(input.requested))
      : 0;
  // 上限：跳过的只数不可能超过请求的只数（脏输入不该透出「跳过 999 只/共 3 只」这种自相矛盾的值）
  const skippedRaw = Number.isFinite(input.skipped)
    ? Math.max(0, Math.floor(Number(input.skipped)))
    : 0;
  const skipped = requested > 0 ? Math.min(skippedRaw, requested) : skippedRaw;
  return {
    generatedAt: typeof input.generatedAt === 'string' ? input.generatedAt : null,
    monitored,
    alerts: sanitizeAlerts(input.alerts),
    ...(skipped > 0 ? { requested: Math.max(requested, skipped), skipped } : {}),
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
      requested: Number(parsed.requested) || 0,
      skipped: Number(parsed.skipped) || 0,
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

import * as fs from 'fs';
import * as path from 'path';

/**
 * 自选股/持仓监控清单（Watchlist）
 * ----------------------------------------------------------------------------
 * 轻量级持久化：把用户关注的 6 位股票代码存在 server/data/watchlist.json。
 * 设计要点：
 *  - 路径在「每次调用时」解析（支持测试用 process.env.WATCHLIST_FILE 重定向），
 *    便于单测用临时文件，无需依赖模块级单例。
 *  - 写入前校验代码格式（6 位数字），去重，保持顺序稳定。
 *  - 所有读写失败都降级为内存空表，不抛错（监控功能不应拖垮主进程）。
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

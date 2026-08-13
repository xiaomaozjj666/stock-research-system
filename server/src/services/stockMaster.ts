import * as fs from 'fs';
import * as path from 'path';
import { fetchJson } from '../utils/http.js';

export interface SecurityMasterEntry {
  code: string;
  name: string;
  industry?: string;
}

const DEFAULT_MASTER_CACHE = path.join(import.meta.dirname, '..', 'data', 'stockMaster.json');
const MASTER_TTL = 24 * 60 * 60 * 1000; // 1 天

/**
 * 运行时解析缓存路径：支持 MASTER_CACHE env 重定向（与 watchlist/paper/audit 同模式）。
 * 惰性解析而非模块级常量，测试可在 beforeEach 中设置 env 后生效。
 */
function getMasterCacheFile(): string {
  return process.env.MASTER_CACHE && process.env.MASTER_CACHE.length > 0
    ? process.env.MASTER_CACHE
    : DEFAULT_MASTER_CACHE;
}

let masterCache: SecurityMasterEntry[] | null = null;
let masterLoadPromise: Promise<SecurityMasterEntry[]> | null = null;

// 上市标记前缀：C=上市初期(次日起5日) N=上市首日 XD/XR/DR=除权除息 ST/*ST/PT=风险警示
const NAME_PREFIXES = ['*ST', 'ST', 'PT', 'XD', 'XR', 'DR', 'N', 'C'];

/** 归一化股票名：去前缀 + 仅保留中文字符，便于子串/模糊匹配 */
export function normalizeName(name: string): string {
  let n = name.trim();
  for (const p of NAME_PREFIXES) {
    if (n.startsWith(p)) {
      n = n.slice(p.length);
      break;
    }
  }
  return n.replace(/[^一-龥]/g, '');
}

/** 加载 A 股全量证券主数据（分页拉取 + 内存缓存 + 磁盘缓存兜底） */
export async function loadStockMaster(force = false): Promise<SecurityMasterEntry[]> {
  if (masterCache && !force) return masterCache;
  if (masterLoadPromise) return masterLoadPromise;

  masterLoadPromise = (async () => {
    // 1. 磁盘缓存（校验含 industry 字段，避免旧格式缓存）
    try {
      if (fs.existsSync(getMasterCacheFile())) {
        const raw = JSON.parse(await fs.promises.readFile(getMasterCacheFile(), 'utf-8'));
        if (
          Date.now() - raw.timestamp < MASTER_TTL &&
          Array.isArray(raw.data) &&
          raw.data.length > 1000 &&
          (raw.data[0] as SecurityMasterEntry)?.industry !== undefined
        ) {
          masterCache = raw.data as SecurityMasterEntry[];
          return masterCache;
        }
      }
    } catch {
      /* 缓存损坏，忽略 */
    }

    // 2. 从东方财富分页拉取全量列表（单页有上限，需翻页）
    const fsFilter = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
    const pageSize = 500;
    const all: SecurityMasterEntry[] = [];

    const fetchPage = async (
      pn: number,
      retries = 3,
    ): Promise<{ total: number; items: SecurityMasterEntry[] }> => {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pageSize}&fs=${fsFilter}&fields=f12,f14,f100&_=${Date.now()}`;
      const json = (await fetchJson(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://quote.eastmoney.com/',
        },
        timeoutMs: 12000,
        retries,
      })) as {
        data?: {
          total?: number;
          diff?: Record<string, { f12: string; f14: string; f100?: string }>;
        };
      };
      const diff = json?.data?.diff;
      if (!diff) throw new Error(`证券全表第 ${pn} 页获取失败`);
      const items = Object.values(diff).map((it) => ({
        code: it.f12,
        name: it.f14,
        industry: it.f100 || '',
      }));
      return { total: json.data?.total ?? items.length, items };
    };

    const first = await fetchPage(1);
    all.push(...first.items);
    const total = first.total;
    for (let pn = 2; all.length < total; pn++) {
      const page = await fetchPage(pn);
      if (page.items.length === 0) break;
      all.push(...page.items);
    }

    masterCache = all;

    try {
      await fs.promises.writeFile(
        getMasterCacheFile(),
        JSON.stringify({ timestamp: Date.now(), data: all }),
        'utf-8',
      );
    } catch {
      /* 写入失败，忽略 */
    }
    return all;
  })();

  try {
    return await masterLoadPromise;
  } finally {
    masterLoadPromise = null;
  }
}

function longestCommonSubstring(a: string, b: string): string {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  let maxLen = 0;
  let end = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > maxLen) {
          maxLen = dp[i][j];
          end = i;
        }
      }
    }
  }
  return a.slice(end - maxLen, end);
}

/**
 * 模糊匹配：支持全称/子串/部分重叠。
 * 评分：精确匹配 100 > 包含匹配 80 > 公共子串 60~。
 */
export function fuzzyMatch(keyword: string, master: SecurityMasterEntry[]): SecurityMasterEntry[] {
  const q = keyword.trim();
  if (!q) return [];

  const codeQuery = /^\d{6}$/.test(q);
  const qNorm = normalizeName(q);

  const scored: { entry: SecurityMasterEntry; score: number }[] = [];
  for (const e of master) {
    if (codeQuery) {
      if (e.code === q) scored.push({ entry: e, score: 100 });
      continue;
    }
    const nNorm = normalizeName(e.name);
    if (!nNorm) continue;

    if (qNorm === nNorm) {
      scored.push({ entry: e, score: 100 });
      continue;
    }
    if (qNorm.length >= 2 && (nNorm.includes(qNorm) || qNorm.includes(nNorm))) {
      scored.push({ entry: e, score: 80 });
      continue;
    }
    // 公共中文字串（长度>=2），避免“银行/科技”等过泛词淹没结果
    if (qNorm.length >= 2 && nNorm.length >= 2) {
      const common = longestCommonSubstring(qNorm, nNorm);
      if (common.length >= 2) {
        scored.push({ entry: e, score: 60 - (4 - common.length) });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const result: SecurityMasterEntry[] = [];
  for (const s of scored) {
    if (seen.has(s.entry.code)) continue;
    seen.add(s.entry.code);
    result.push(s.entry);
    if (result.length >= 10) break;
  }
  return result;
}

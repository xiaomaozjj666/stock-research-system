/**
 * Baostock 桥接（Python sidecar · 指数历史成分）
 * ============================================================================
 * Baostock 是 Python-only 库，本模块按「一次性子进程 + JSON over stdin/stdout」
 * 协议调用 `scripts/baostock-sidecar.py`，取它独有的数据：**指数历史成分**
 * （hs300/zz500/sz50，含其后退市证券——修复幸存者偏差的最后一块，东财免费通道
 * 与 Tushare 免费积分都给不了，见 tushareAdapter 的实测记录）。
 *
 * 协议与诚实边界：
 *  - 请求经 stdin 传入（绕开 Windows argv 引号转义），stdout 只允许出现一行
 *    JSON 响应（sidecar 已把第三方噪声重定向到 stderr）；协议内错误也是 JSON
 *    （{ok:false,error}），只有 Python 缺失/崩溃才会拿不到 JSON；
 *  - Python 解释器经 `PYTHON_BIN` 环境变量指定（默认 `python`）；未安装
 *    Python/baostock 时调用抛错，调用方必须降级——免费东财通道是主通道；
 *  - **缓存纪律**：指定日期的历史成分不可变 → 30 天缓存；不指定日期（最新快照）
 *    → 默认 24h（QUANT_BAOSTOCK_CACHE_TTL_HOURS 可覆盖，0=关闭）。上游失败时
 *    回落陈旧缓存（与 tushareAdapter 同模式），同 key 并发去重只打一次子进程；
 *  - 子进程超时 60s（login+查询实测数秒级），超时/崩溃如实抛错。
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { withQuantCache, readCacheEntry } from './quantCache.js';

export const BAOSTOCK_INDEXES = ['hs300', 'zz500', 'sz50'] as const;
export type BaostockIndex = (typeof BAOSTOCK_INDEXES)[number];

export interface IndexConstituent {
  /** 6 位数字代码（sidecar 已从 sh.600000 归一） */
  code: string;
  name: string | null;
}

export interface IndexConstituentsResult {
  index: BaostockIndex;
  requestedDate: string | null;
  /** 成分快照的实际调仓日（早于或等于 requestedDate 的最近一次） */
  updateDate: string | null;
  count: number;
  constituents: IndexConstituent[];
}

function pythonBin(): string {
  const raw = process.env.PYTHON_BIN ?? '';
  return raw.trim() !== '' ? raw.trim() : 'python';
}

/** sidecar 脚本路径（src/quant 与 dist/quant 均上溯两级到 server/scripts） */
function sidecarPath(): string {
  return path.join(import.meta.dirname, '..', '..', 'scripts', 'baostock-sidecar.py');
}

function baostockCacheTtlMs(): number {
  const raw = process.env.QUANT_BAOSTOCK_CACHE_TTL_HOURS;
  if (raw !== undefined && raw.trim() !== '') {
    const hours = Number(raw);
    if (Number.isFinite(hours)) return hours > 0 ? hours * 60 * 60 * 1000 : 0;
  }
  return 24 * 60 * 60 * 1000;
}

/** 调用 sidecar 一次（spawn → stdin JSON → stdout 一行 JSON），60s 超时 */
function invokeSidecar(
  index: BaostockIndex,
  date: string | null,
): Promise<IndexConstituentsResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [sidecarPath()], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Baostock sidecar 超时（60s）'));
    }, 60_000);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        reject(
          new Error(
            `未找到 Python 解释器（${pythonBin()}）：请安装 Python 并 pip install baostock，或用 PYTHON_BIN 指定解释器`,
          ),
        );
      } else {
        reject(new Error(`Baostock sidecar 启动失败：${e.message}`));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) {
        reject(
          new Error(
            `Baostock sidecar 无 JSON 输出（exit=${code}）${stderr.trim() ? `：${stderr.trim().split('\n').at(-1)}` : ''}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(line) as
          (IndexConstituentsResult & { ok: true }) | { ok: false; error: string };
        if (parsed.ok) resolve(parsed);
        else reject(new Error(`Baostock sidecar：${parsed.error}`));
      } catch {
        reject(new Error(`Baostock sidecar 输出解析失败：${line.slice(0, 120)}`));
      }
    });
    child.stdin.write(JSON.stringify({ index, ...(date ? { date } : {}) }));
    child.stdin.end();
  });
}

/** 长缓存 + 陈旧兜底（与 tushareAdapter 同模式）：上游失败回落任意已缓存数据 */
async function withBaostockStaleCache<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<T> {
  if (!(ttlMs > 0)) return producer();
  try {
    return await withQuantCache(key, ttlMs, producer);
  } catch (err) {
    const stale = readCacheEntry<T>(key);
    if (stale) return stale.data;
    throw err;
  }
}

const inflight = new Map<string, Promise<IndexConstituentsResult>>();

/**
 * 指数成分快照（缓存包装）：指定 date 的历史快照不可变 → 30 天缓存；
 * 未指定 date（最新）→ 默认 24h。同 key 并发去重，只起一个子进程。
 */
export async function fetchIndexConstituentsCached(
  index: BaostockIndex,
  date?: string | null,
): Promise<IndexConstituentsResult> {
  const requestedDate = date && date.trim() !== '' ? date.trim() : null;
  const key = `baostock_cons_${index}_${requestedDate ?? 'latest'}`;
  const ttl = requestedDate ? 30 * 24 * 60 * 60 * 1000 : baostockCacheTtlMs();
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = withBaostockStaleCache(key, ttl, () => invokeSidecar(index, requestedDate)).finally(
    () => inflight.delete(key),
  );
  inflight.set(key, p);
  return p;
}

/**
 * 健康披露块（/api/quant/health 用）：以 hs300 成分缓存（含陈旧兜底）作为端到端
 * 探针——Python/baostock/网络任一缺失都如实反映在 available/detail 上。
 */
export async function baostockHealth(): Promise<Record<string, unknown>> {
  try {
    const r = await fetchIndexConstituentsCached('hs300');
    return {
      available: true,
      hs300Count: r.count,
      updateDate: r.updateDate,
      python: pythonBin(),
    };
  } catch (error) {
    return { available: false, detail: (error as Error).message, python: pythonBin() };
  }
}

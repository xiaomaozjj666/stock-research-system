/**
 * 上游预检（Preflight）
 * ------------------------------------------------------------------
 * 借鉴 reverse-skill 的「按需自举工具链」：动手前先检查依赖是否就绪，缺失就
 * 明确告知，而不是闷头跑到超时再甩一个 502。
 *
 * 起因（真实事故）：行情源在会话间不可达时，截面评估仍会为每只股票逐个发起
 * 网络调用，等满超时后才 502——用户干等数十秒，拿到一句没有行动指引的报错。
 * 预检把这件事提前到毫秒级判定：源不可达 + 无本地缓存可兜底时立刻返回 503，
 * 并附上「哪一项不可用」的清单。
 *
 * 探针结果按 60 秒记忆（memoize）：预检本身不该成为新的网络放大源。
 */
import * as fs from 'fs';
import { fetchJson } from '../utils/http.js';
import { isLLMAvailable } from '../llm/config.js';
import { getQuantCacheDir } from './quantCache.js';

/** 单项检查结果 */
export interface PreflightCheck {
  key: 'upstream' | 'llm' | 'cache';
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  /** 三项全通过 */
  ok: boolean;
  checks: PreflightCheck[];
  /** 降级提示：可用的兜底手段（如磁盘缓存可支撑陈旧数据） */
  degraded: string[];
  checkedAt: string;
}

const UPSTREAM_PROBE_URL =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&fields1=f1&fields2=f51,f53&klt=101&fqt=1&beg=20240101&end=20240110&lmt=20';
const PROBE_TTL_MS = 60_000;

let cached: { at: number; upstream: PreflightCheck } | null = null;

/** 探测行情源（60s 内复用结果）；只求「通不通」，不关心数据内容 */
export async function probeUpstream(): Promise<PreflightCheck> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.upstream;
  let check: PreflightCheck;
  try {
    await fetchJson(UPSTREAM_PROBE_URL, { timeoutMs: 4000, retries: 0 });
    check = { key: 'upstream', ok: true, detail: '行情源可达' };
  } catch (error) {
    check = {
      key: 'upstream',
      ok: false,
      detail: `行情源不可达：${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
  cached = { at: Date.now(), upstream: check };
  return check;
}

/** 本地量化缓存可用条目数（磁盘只读，无网络） */
export function cacheEntryCount(): number {
  try {
    const dir = getQuantCacheDir();
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/** 执行完整预检 */
export async function runPreflight(): Promise<PreflightResult> {
  const upstream = await probeUpstream();
  const llm: PreflightCheck = {
    key: 'llm',
    ok: isLLMAvailable(),
    detail: isLLMAvailable() ? 'LLM 已配置' : 'LLM 未配置：深度研判将走规则降级',
  };
  const count = cacheEntryCount();
  const cache: PreflightCheck = {
    key: 'cache',
    ok: count > 0,
    detail: count > 0 ? `本地缓存 ${count} 条（可支撑陈旧数据兜底）` : '本地缓存为空',
  };
  const degraded: string[] = [];
  if (!upstream.ok && cache.ok) degraded.push('行情源不可用，将回落磁盘缓存的陈旧数据');
  if (!upstream.ok && !cache.ok) degraded.push('行情源与本地缓存均不可用，本次无法装配面板');
  if (!llm.ok) degraded.push('LLM 未配置，研究与对话走规则降级');
  return {
    ok: upstream.ok && llm.ok && cache.ok,
    checks: [upstream, llm, cache],
    degraded,
    checkedAt: new Date().toISOString(),
  };
}

/** 测试用：清空探针记忆 */
export function resetPreflightCache(): void {
  cached = null;
}

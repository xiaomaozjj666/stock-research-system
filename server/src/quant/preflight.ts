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
  key: 'upstream' | 'upstream_list' | 'llm' | 'cache';
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  /** 核心依赖全通过（行情源 + LLM + 缓存；板块列表源单独披露，见 upstream_list） */
  ok: boolean;
  checks: PreflightCheck[];
  /** 降级提示：可用的兜底手段（如磁盘缓存可支撑陈旧数据） */
  degraded: string[];
  checkedAt: string;
}

const UPSTREAM_PROBE_URL =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&fields1=f1&fields2=f51,f53&klt=101&fqt=1&beg=20240101&end=20240110&lmt=20';
/**
 * 板块列表源（push2 clist）独立探测：K 线 host（push2his）与列表 host（push2）
 * 是两个域名，可用性互不绑定——实测出现过「K 线通、板块列表挂」的组合。
 * 只探 K 线会把 board 路径误判为可用，陪跑整轮超时才 502。
 */
const UPSTREAM_LIST_PROBE_URL =
  'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1&po=1&np=1&fltt=2&fid=f20&fs=m%3A90%2Bt%3A2&fields=f12';
const PROBE_TTL_MS = 60_000;

const probeCache = new Map<string, { at: number; check: PreflightCheck }>();

/** 探测一个上游 host（60s 内复用结果）；只求「通不通」，不关心数据内容 */
async function probeHost(
  key: PreflightCheck['key'],
  url: string,
  label: string,
): Promise<PreflightCheck> {
  const memo = probeCache.get(key);
  if (memo && Date.now() - memo.at < PROBE_TTL_MS) return memo.check;
  let check: PreflightCheck;
  try {
    await fetchJson(url, { timeoutMs: 4000, retries: 0 });
    check = { key, ok: true, detail: `${label}可达` };
  } catch (error) {
    check = {
      key,
      ok: false,
      detail: `${label}不可达：${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
  probeCache.set(key, { at: Date.now(), check });
  return check;
}

/** 探测行情 K 线源（push2his，门槛 bars/财务/指数类取数） */
export async function probeUpstream(): Promise<PreflightCheck> {
  return probeHost('upstream', UPSTREAM_PROBE_URL, '行情源');
}

/** 探测板块列表源（push2 clist，门槛 board universe 成分股取数） */
export async function probeUpstreamList(): Promise<PreflightCheck> {
  return probeHost('upstream_list', UPSTREAM_LIST_PROBE_URL, '板块列表源');
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
  const upstreamList = await probeUpstreamList();
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
  if (!upstreamList.ok) {
    degraded.push('板块列表源不可达：board universe 将走本地缓存成分股，无缓存时该路径 503');
  }
  if (!llm.ok) degraded.push('LLM 未配置，研究与对话走规则降级');
  return {
    // 核心依赖 = 行情源 + LLM + 缓存；板块列表源按需披露（只影响 board 路径）
    ok: upstream.ok && llm.ok && cache.ok,
    checks: [upstream, upstreamList, llm, cache],
    degraded,
    checkedAt: new Date().toISOString(),
  };
}

/** 测试用：清空探针记忆 */
export function resetPreflightCache(): void {
  probeCache.clear();
}

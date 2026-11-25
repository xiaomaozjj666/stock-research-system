/**
 * 深度研究断点（Research Checkpoint）
 * ----------------------------------------------------------------------------
 * 深度研究一次要跑几十次 LLM 调用（规划 / 每条文档的证据抽取 / 每个子问题的
 * 交叉验证 / 结论编排），分钟级、有真金白银成本。而 SSE 连接一旦断开
 * （关标签页、切网络、代理超时），整次研究作废、费用白烧——这是此前明确
 * 「不做断线重连」留下的长期缺口。
 *
 * 本模块按「轮次边界」把可续跑的中间状态落盘：
 *   - 规划完成后立即落一次（保住计划，续跑不再花一次规划 LLM 调用）；
 *   - 每轮结束（检索 + 验证完成）落一次（保住已验证子问题与全部证据）。
 * 续跑时携带 runId 重新请求，从「已完成轮次 + 1」继续，已完成子问题直接复用
 * 验证结论与证据，不重复检索、不重复付费。
 *
 * 与 researchLibrary 的关系：
 *   researchLibrary 存**已跑完**的研究（研究台账，供复查）；
 *   本模块存**未跑完**的断点（存活期有限，完成后即清理），两者互不替代。
 *
 * 存储布局：<dir>/<runId>.json（一条研究一个文件，原子写）。
 * IO 全部 best-effort：写失败只降级为「无法续跑」，绝不影响研究本身。
 */
import * as fs from 'fs';
import * as path from 'path';

import { DATA_ROOT } from '../dataRoot.js';
import type {
  ResearchConfig,
  ResearchSnapshot,
  ScopeConstraints,
} from '../research-agent/index.js';

/** 最多保留的断点数：超出后淘汰最旧的（其明细文件一并删除） */
const MAX_CHECKPOINTS = 20;

/** 断点存活期：研究证据有时效性，过期不再复用（默认 6 小时，与 analyze 断点一致） */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 可持久化 / 可恢复的中间状态。
 * 直接复用编排器的 ResearchSnapshot，避免「落盘形状」与「恢复形状」各写一份后分叉。
 */
export type ResearchCheckpointSnapshot = ResearchSnapshot;

/** 单条断点完整记录 */
export interface ResearchCheckpointRecord {
  runId: string;
  question: string;
  scope: ScopeConstraints;
  /** 原请求的编排参数：续跑沿用，保证同一 token 预算下跑完 */
  config: Partial<ResearchConfig>;
  createdAt: string;
  updatedAt: string;
  snapshot: ResearchCheckpointSnapshot;
}

/** 断点摘要（「未完成的研究」列表用，刻意不含计划/证据正文） */
export interface ResearchCheckpointSummary {
  runId: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  roundsCompleted: number;
  evidenceCount: number;
}

const DEFAULT_DIR = path.join(DATA_ROOT, 'research-checkpoints');

/** 断点目录：支持 RESEARCH_CHECKPOINT_DIR 重定向（测试用 tmp 目录，运维可挂独立盘） */
export function getResearchCheckpointDir(): string {
  const override = process.env.RESEARCH_CHECKPOINT_DIR;
  return override && override.trim().length > 0 ? override : DEFAULT_DIR;
}

/**
 * runId 白名单：id 会直接拼进文件名，必须挡掉 `../`、绝对路径、盘符等
 * 任何可能逃出断点目录的形态。生成端只会产出小写字母/数字/连字符。
 */
export function isResearchRunId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

let seq = 0;
/** 新建一次研究的 runId（形如 `lz9k2p-1-8f3a`：时间戳 base36 + 序号 + 随机后缀） */
export function newResearchRunId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fileFor(runId: string): string {
  return path.join(getResearchCheckpointDir(), `${runId}.json`);
}

function dirPath(): string {
  return getResearchCheckpointDir();
}

function ttlMs(): number {
  const raw = process.env.RESEARCH_CHECKPOINT_TTL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

function writeJsonAtomic(file: string, payload: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 读取原始记录（不做过期判断；损坏/形态不符返回 null） */
function readRaw(runId: string): ResearchCheckpointRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(runId), 'utf-8')) as ResearchCheckpointRecord;
    if (!parsed || parsed.runId !== runId) return null;
    const snap = parsed.snapshot;
    if (!snap || typeof snap !== 'object') return null;
    // 断点被续跑依赖的最小形态：计划、证据数组、验证数组、统计、轮次
    if (!snap.plan || !Array.isArray(snap.evidence) || !Array.isArray(snap.verifications)) {
      return null;
    }
    if (!snap.stats || typeof snap.stats !== 'object') return null;
    if (typeof snap.roundsCompleted !== 'number' || snap.roundsCompleted < 0) return null;
    if (!Array.isArray(snap.events)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 保存 / 覆盖一条断点。失败（磁盘满 / 无权限）返回 false——调用方不得据此
 * 改变研究流程：断点只是「断了还能续」的优化，不是研究正确性的前提。
 *
 * createdAt 只在首次写入时生成；同一 runId 的后续写入沿用原值，续跑链的
 * 「这次研究是几点开始的」不会因为断点重写而被改写。
 */
export function saveResearchCheckpoint(input: {
  runId: string;
  question: string;
  scope: ScopeConstraints;
  config: Partial<ResearchConfig>;
  snapshot: ResearchCheckpointSnapshot;
}): boolean {
  if (!isResearchRunId(input.runId)) return false;
  const now = new Date().toISOString();
  const prev = readRaw(input.runId);
  const record: ResearchCheckpointRecord = {
    runId: input.runId,
    question: input.question,
    scope: input.scope,
    config: input.config,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    snapshot: input.snapshot,
  };
  if (!writeJsonAtomic(fileFor(input.runId), record)) return false;

  // 超出上限淘汰最旧的（best-effort：删不掉只是占点磁盘）
  const all = readAll();
  if (all.length > MAX_CHECKPOINTS) {
    for (const old of all.slice(MAX_CHECKPOINTS)) {
      try {
        fs.unlinkSync(fileFor(old.runId));
      } catch {
        /* 忽略 */
      }
    }
  }
  return true;
}

/** 读取断点；不存在 / 过期 / 损坏返回 null。过期即清理，避免陈旧证据被误用 */
export function loadResearchCheckpoint(runId: unknown): ResearchCheckpointRecord | null {
  if (!isResearchRunId(runId)) return null;
  const record = readRaw(runId);
  if (!record) return null;
  const ttl = ttlMs();
  const age = Date.now() - new Date(record.updatedAt).getTime();
  // ttl <= 0 表示不提供续跑；age 与 ttl 相等即视为到期（同 analysisCheckpoint 口径）
  if (!Number.isFinite(age) || ttl <= 0 || age >= ttl) {
    clearResearchCheckpoint(runId);
    return null;
  }
  return record;
}

/** 删除断点（研究成功完成后调用）；失败静默 */
export function clearResearchCheckpoint(runId: unknown): void {
  if (!isResearchRunId(runId)) return;
  try {
    fs.unlinkSync(fileFor(runId));
  } catch {
    /* 文件可能已不存在 */
  }
}

/** 列出全部断点记录（新 -> 旧），供列表与淘汰共用 */
function readAll(): ResearchCheckpointRecord[] {
  const dir = dirPath();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: ResearchCheckpointRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const runId = name.slice(0, -'.json'.length);
    if (!isResearchRunId(runId)) continue;
    const record = readRaw(runId);
    if (record) records.push(record);
  }
  records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return records;
}

/**
 * 列出可续跑的断点摘要（新 -> 旧）。
 * 过期项顺带清理；返回条数受 limit 与 MAX_CHECKPOINTS 双重约束。
 */
export function listResearchCheckpoints(limit = 20): ResearchCheckpointSummary[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_CHECKPOINTS) : 20;
  const ttl = ttlMs();
  const cutoff = Date.now() - ttl;
  const items: ResearchCheckpointSummary[] = [];
  for (const record of readAll()) {
    const updated = new Date(record.updatedAt).getTime();
    if (ttl <= 0 || !Number.isFinite(updated) || updated <= cutoff) {
      clearResearchCheckpoint(record.runId);
      continue;
    }
    items.push({
      runId: record.runId,
      question: record.question,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      roundsCompleted: record.snapshot.roundsCompleted,
      evidenceCount: record.snapshot.evidence.length,
    });
    if (items.length >= safeLimit) break;
  }
  return items;
}

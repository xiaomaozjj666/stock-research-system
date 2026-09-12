/**
 * 研究简报（Research Digest）
 * ----------------------------------------------------------------------------
 * 把散在各处的「研究状态」收拢成一份定期快照：全市场初筛最新结果、实验台账
 * 概览、与上一份简报相比的增量。目的是无人值守研究闭环——定时跑一份、
 * 手动随时跑一份，读列表就能知道「系统最近替我做了什么、发现了什么」。
 *
 * 与飞书推送（已移除）的边界：简报只落站内，经 API 读取；生成是纯数据聚合
 * （不调 LLM、不打上游行情——初筛结果读既有落盘，台账读本地文件），秒级完成，
 * 不会成为定时任务的负担。
 *
 * 存储：与 factorLedger 同模式（单 JSON 文件 + env 重定向 + 原子写 + 容量淘汰
 * + IO 静默降级）。新简报插最前，超容量淘汰最旧。
 */
import * as fs from 'fs';
import * as path from 'path';
import { readLatestScreenerRun, type ScreenerRunResult } from './screener.js';
import { summarizeFactorExperiments } from './factorLedger.js';

const MAX_DIGESTS = 60;

export interface DigestScreenerSection {
  /** 初筛运行时刻（无记录为 null） */
  at: string | null;
  scanned: number | null;
  eligible: number | null;
  /** 命中总数与代表性命中（前 10 条，按策略去重优先） */
  hitCount: number | null;
  topHits: { code: string; name: string; strategy: string; detail: string }[];
}

export interface DigestLedgerSection {
  total: number;
  kept: number;
  /** 期望假阳性上界（采信数 × 5%） */
  keptExpectedFalse: number;
  keptOosShare: number;
  bySource: Record<string, number>;
}

export interface ResearchDigest {
  id: string;
  createdAt: string;
  screener: DigestScreenerSection;
  ledger: DigestLedgerSection;
  /** 与上一份简报相比的事实增量 */
  notes: string[];
}

interface DigestStore {
  items: ResearchDigest[];
}

const DEFAULT_DIGEST_FILE = path.join(import.meta.dirname, '..', 'data', 'researchDigests.json');

function getDigestFile(): string {
  return process.env.RESEARCH_DIGEST_FILE && process.env.RESEARCH_DIGEST_FILE.length > 0
    ? process.env.RESEARCH_DIGEST_FILE
    : DEFAULT_DIGEST_FILE;
}

function readStore(): DigestStore {
  try {
    const file = getDigestFile();
    if (!fs.existsSync(file)) return { items: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as DigestStore;
    return parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeStore(store: DigestStore): boolean {
  try {
    const file = getDigestFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
function makeId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 初筛 section 组装（无记录如实给 null 字段） */
function screenerSection(run: ScreenerRunResult | null): DigestScreenerSection {
  if (!run) {
    return { at: null, scanned: null, eligible: null, hitCount: null, topHits: [] };
  }
  const topHits = run.hits.slice(0, 10).map((h) => ({
    code: h.code,
    name: h.name ?? '',
    strategy: h.strategy,
    detail: h.detail,
  }));
  return {
    at: run.at,
    scanned: run.scanned,
    eligible: run.eligible,
    hitCount: run.hits.length,
    topHits,
  };
}

export interface DigestDeps {
  /** 默认读最近一次初筛落盘结果 */
  readScreener?: () => ScreenerRunResult | null;
  /** 默认读实验台账概览 */
  readLedger?: () => ReturnType<typeof summarizeFactorExperiments>;
  now?: () => Date;
}

/**
 * 生成一份研究简报并落盘（插最前，超容量淘汰最旧）。
 * 与上一份简报的增量以事实化 notes 给出（新实验数、初筛命中变化）。
 * 写盘失败时返回内存中的简报（调用方仍可展示），只是不持久。
 */
export function runResearchDigest(deps: DigestDeps = {}): ResearchDigest {
  const store = readStore();
  const previous = store.items[0] ?? null;

  const screenerRun = deps.readScreener ? deps.readScreener() : readLatestScreenerRun();
  const ledger = deps.readLedger ? deps.readLedger() : summarizeFactorExperiments();

  const notes: string[] = [];
  if (previous) {
    const newExperiments = ledger.total - previous.ledger.total;
    if (newExperiments > 0) {
      notes.push(`自上一份简报新增 ${newExperiments} 条因子实验记录`);
    } else if (newExperiments < 0) {
      notes.push('台账记录数较上一份简报减少（可能发生了清理或淘汰）');
    }
    if (screenerRun && previous.screener.at && screenerRun.at !== previous.screener.at) {
      notes.push(
        `初筛已更新：本次扫描 ${screenerRun.scanned} 只、合格 ${screenerRun.eligible} 只、命中 ${screenerRun.hits.length} 条`,
      );
    } else if (!screenerRun && previous.screener.at) {
      notes.push('初筛记录不可读（落盘文件可能被清理）');
    }
    if (previous.ledger.kept !== ledger.kept) {
      notes.push(`采信实验数 ${previous.ledger.kept} → ${ledger.kept}`);
    }
  } else {
    notes.push('首份简报：后续将按与本次的差值披露研究增量');
  }
  if (ledger.kept > 0) {
    notes.push(
      `当前采信 ${ledger.kept} 条（期望假阳性上界 ${ledger.keptExpectedFalse}），OOS 稳定占比 ${Math.round(ledger.keptOosShare * 100)}%`,
    );
  }
  if (screenerRun && screenerRun.hits.length === 0 && screenerRun.eligible > 0) {
    notes.push('本次初筛无命中：形态与 RPS 条件均未触发，属正常市场状态');
  }

  const digest: ResearchDigest = {
    id: makeId(),
    createdAt: (deps.now ? deps.now() : new Date()).toISOString(),
    screener: screenerSection(screenerRun),
    ledger: {
      total: ledger.total,
      kept: ledger.kept,
      keptExpectedFalse: ledger.keptExpectedFalse,
      keptOosShare: ledger.keptOosShare,
      bySource: ledger.bySource,
    },
    notes,
  };

  const ok = writeStore({ items: [digest, ...store.items].slice(0, MAX_DIGESTS) });
  return ok ? digest : { ...digest, notes: [...digest.notes, '（写盘失败：本次简报未持久化）'] };
}

/** 按时间倒序列出简报 */
export function listResearchDigests(limit = 20): ResearchDigest[] {
  const items = [...readStore().items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), MAX_DIGESTS)) : 20;
  return items.slice(0, n);
}

/**
 * 启动定时简报：QUANT_DIGEST_INTERVAL_HOURS 控制间隔（小数允许，如 0.5=30 分钟），
 * 默认 0 = 关闭（不改变既有部署的行为）。测试环境不起定时器。
 * 由 server/src/index.ts 显式调用；启动时不立即跑（避免与预热/预检抢上游），
 * 手动触发走 POST /api/quant/digests/run。
 */
export function startDigestScheduler(): void {
  const raw = Number(process.env.QUANT_DIGEST_INTERVAL_HOURS);
  if (!Number.isFinite(raw) || raw <= 0) return;
  const intervalMs = Math.max(raw * 3_600_000, 60_000);
  if (process.env.NODE_ENV === 'test') return;
  const timer = setInterval(() => {
    try {
      runResearchDigest();
    } catch {
      // 简报是辅助产物：定时失败静默，下个周期再试
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

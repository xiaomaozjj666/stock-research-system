/**
 * 深度研究库（Research Library）
 * ----------------------------------------------------------------------------
 * 把每一次跑完的深度研究结果落盘，形成可回看的研究台账。存在理由很具体：
 * 一次深度研究要跑几十次 LLM 调用（分钟级、有真金白银成本），而前端一旦刷新
 * 页面，报告、逐条引用、执行轨迹就全部丢失——用户想回头核验某条结论时无从找起。
 * 主流投研工作台（AlphaSense Deep Research / FundaPod 等）都把「历史研究」
 * 当作基础设施：结论可以离开当前会话被复查。
 *
 * 存储布局（与 researchDigest / factorLedger 同一套「单文件 + env 重定向 + 原子写」
 * 风格，但拆成目录 + 索引两级）：
 *
 *   <dir>/index.json      只存摘要（问题、标题、置信度、统计），几十条也只有几十 KB
 *   <dir>/<id>.json       单次研究的完整结果（报告 / 证据 / 事件 / 统计）
 *
 * 为什么不像 digest 那样用一个文件存全部：列表页只需要摘要，而单次结果含完整
 * 报告与事件流，几十次研究堆在一个文件里会变成几 MB，每次列目录都要 sync 读一次
 * 全量 JSON 并解析——这是把「便宜操作」做成了「贵操作」。分包后列目录只读索引，
 * 回看某次研究才读那一个文件。
 *
 * IO 全部 best-effort：写失败返回 null，调用方（研究路由）不得因此判定研究失败
 * ——研究本身已经完成，落盘只是增强。
 */
import * as fs from 'fs';
import * as path from 'path';

import { DATA_ROOT } from '../dataRoot.js';
import type { AgentRunResult, ScopeConstraints } from '../research-agent/index.js';

/** 保留的最大研究数：超出后淘汰最旧的（其明细文件一并删除） */
const MAX_RUNS = 30;

/** 单次研究摘要（列表页用，不含报告正文） */
export interface ResearchRunSummary {
  id: string;
  question: string;
  createdAt: string;
  title: string;
  overallConfidence: number;
  confidenceLabel: string;
  rounds: number;
  evidenceCount: number;
  sectionCount: number;
  conflictCount: number;
  stopReason?: string;
}

/** 单次研究完整记录 */
export interface SavedResearchRun {
  id: string;
  question: string;
  scope: ScopeConstraints;
  createdAt: string;
  result: AgentRunResult;
}

interface LibraryIndex {
  items: ResearchRunSummary[];
}

const DEFAULT_LIBRARY_DIR = path.join(DATA_ROOT, 'research-runs');
const INDEX_FILE = 'index.json';

/** 研究库目录：支持 RESEARCH_LIBRARY_DIR 重定向（测试用 tmp 目录，运维可挂独立盘） */
export function getResearchLibraryDir(): string {
  const override = process.env.RESEARCH_LIBRARY_DIR;
  return override && override.trim().length > 0 ? override : DEFAULT_LIBRARY_DIR;
}

/**
 * id 白名单校验：id 会直接拼进文件名，必须挡掉 `../`、绝对路径、盘符等
 * 任何可能逃出研究库目录的形态。生成端只会产出小写字母/数字/连字符。
 */
function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

function indexPath(): string {
  return path.join(getResearchLibraryDir(), INDEX_FILE);
}

function runPath(id: string): string {
  return path.join(getResearchLibraryDir(), `${id}.json`);
}

function readIndex(): LibraryIndex {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf-8');
    const parsed = JSON.parse(raw) as LibraryIndex;
    if (!parsed || !Array.isArray(parsed.items)) return { items: [] };
    // 索引文件只作列表用：逐条过滤掉形态不完整的条目，避免一条脏数据让整页报错
    const items = parsed.items.filter(
      (it): it is ResearchRunSummary =>
        Boolean(it) && typeof it === 'object' && isSafeId((it as ResearchRunSummary).id),
    );
    return { items };
  } catch {
    return { items: [] };
  }
}

function writeJsonAtomic(file: string, payload: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
function makeId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 从完整结果提炼列表摘要 */
function toSummary(id: string, question: string, createdAt: string, result: AgentRunResult) {
  return {
    id,
    question,
    createdAt,
    title: result.report.title,
    overallConfidence: result.report.overallConfidence,
    confidenceLabel: result.report.confidenceLabel,
    rounds: result.stats.rounds,
    evidenceCount: result.stats.evidenceCount,
    sectionCount: result.report.sections.length,
    conflictCount: result.report.conflicts.length,
    ...(result.stats.stopReason ? { stopReason: result.stats.stopReason } : {}),
  };
}

/**
 * 保存一次研究。失败（磁盘满 / 无权限）时返回 null——调用方不得据此改变响应，
 * 研究结果本身已经返回给用户了。
 */
export function saveResearchRun(input: {
  question: string;
  scope: ScopeConstraints;
  result: AgentRunResult;
}): ResearchRunSummary | null {
  const id = makeId();
  const createdAt = input.result.report.generatedAt || new Date().toISOString();
  const summary = toSummary(id, input.question, createdAt, input.result);
  const record: SavedResearchRun = {
    id,
    question: input.question,
    scope: input.scope,
    createdAt,
    result: input.result,
  };

  if (!writeJsonAtomic(runPath(id), record)) return null;

  const index = readIndex();
  index.items.unshift(summary);
  const evicted = index.items.splice(MAX_RUNS);
  if (!writeJsonAtomic(indexPath(), index)) {
    // 索引没写成：把刚写的明细删掉，避免产生「永远列不出来」的孤儿文件
    try {
      fs.unlinkSync(runPath(id));
    } catch {
      /* 忽略 */
    }
    return null;
  }
  // 淘汰最旧的明细文件（best-effort：删不掉也只是占点磁盘，不影响读取）
  for (const old of evicted) {
    try {
      fs.unlinkSync(runPath(old.id));
    } catch {
      /* 忽略 */
    }
  }
  return summary;
}

/** 列出最近的研究（新 -> 旧） */
export function listResearchRuns(limit = 20): ResearchRunSummary[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_RUNS) : 20;
  return readIndex().items.slice(0, safeLimit);
}

/** 读取单次研究完整记录；id 非法或文件缺失/损坏返回 null */
export function getResearchRun(id: unknown): SavedResearchRun | null {
  if (!isSafeId(id)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(runPath(id), 'utf-8')) as SavedResearchRun;
    return parsed && parsed.result && parsed.result.report ? parsed : null;
  } catch {
    return null;
  }
}

/** 删除单次研究；返回是否确实删掉了（索引与明细任一存在即算成功） */
export function deleteResearchRun(id: unknown): boolean {
  if (!isSafeId(id)) return false;
  const index = readIndex();
  const before = index.items.length;
  index.items = index.items.filter((it) => it.id !== id);
  const removedFromIndex = index.items.length !== before;
  let removedFile = false;
  try {
    fs.unlinkSync(runPath(id));
    removedFile = true;
  } catch {
    /* 文件可能已不存在 */
  }
  if (removedFromIndex) writeJsonAtomic(indexPath(), index);
  return removedFromIndex || removedFile;
}

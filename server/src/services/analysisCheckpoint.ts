import * as fs from 'fs';
import * as path from 'path';
import type {
  FinancialData,
  ValuationData,
  StockInfo,
  ExpertOpinion,
  ControversyPoint,
  PriceHistoryPoint,
} from '../types.js';
import type { NewsSignal } from '../quant/newsSignal.js';
import logger from '../utils/logger.js';

/**
 * 分析流水线断点续跑（借鉴 TradingAgents 的 checkpoint resume）。
 *
 * 背景：一次完整分析要串行经过「取数 → 8 位专家研判 → 仲裁」三段高成本环节
 * （后两段各含多次 LLM 调用）。原先任一段失败都会让整次分析作废，
 * 重跑还需重新支付全部 LLM 成本。
 *
 * 本模块按阶段把中间产物落盘（每只股票一个 JSON 文件），
 * 中断后携带 resume 重入即可从最后一个成功阶段继续，成功后自动清除。
 */

/** 可续跑的阶段（越靠后越大，用于展示"已完成至哪个阶段"） */
export type CheckpointStage = 'data' | 'experts' | 'arbitration';

const STAGE_LABEL: Record<CheckpointStage, string> = {
  data: '数据获取',
  experts: '专家研判',
  arbitration: '辩论仲裁',
};

export function stageLabel(stage: CheckpointStage): string {
  return STAGE_LABEL[stage];
}

/** 断点有效期：行情/财务数据有时效性，过期不再复用（默认 6 小时） */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface CheckpointDataPayload {
  info: StockInfo;
  financial: FinancialData;
  valuation: ValuationData;
  newsSignal: NewsSignal | null;
  priceHistory: PriceHistoryPoint[];
}

export interface AnalysisCheckpoint {
  stockCode: string;
  updatedAt: string;
  stage: CheckpointStage;
  /**
   * 断点代次标识：同一次分析（含其续跑链）共享同一个 runId。
   * saveCheckpoint 只在代次一致时合并旧产物，loadCheckpoint 可要求代次相符——
   * 并发两代写同一股票时不会把 A 代的专家结论并进 B 代的断点（跨代错配）。
   * 旧格式断点没有该字段，读取时按「未知代次」处理（不参与代次校验）。
   */
  runId?: string;
  data?: CheckpointDataPayload;
  expertOpinions?: ExpertOpinion[];
  degradedExperts?: string[];
  /** 按 key 取用的专家结论（专家降级时为 undefined），供下游自省逻辑使用 */
  expertByKey?: Record<string, ExpertOpinion | undefined>;
  controversies?: ControversyPoint[];
  finalOpinion?: ExpertOpinion;
}

const DEFAULT_DIR = path.join(import.meta.dirname, '..', 'data', 'checkpoints');

/** 代次序号：同一毫秒内多次新建也能得到不同 id */
let runSeq = 0;

/**
 * 新建断点代次 id（形如 `lz9k2p-1-8f3a`：时间戳 base36 + 序号 + 随机后缀）。
 * 带时间戳前缀是为了排障时能从文件名/断点内容直接看出这一代是什么时候起的。
 */
export function newRunId(): string {
  runSeq += 1;
  return `${Date.now().toString(36)}-${runSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 清洗代次 id，用于拼接临时文件名（防路径穿越；id 由 newRunId 生成，正常不会被改写） */
function sanitizeRunId(runId: string): string {
  return runId.replace(/[^0-9a-zA-Z_-]/g, '_');
}

function getDir(): string {
  const env = process.env.ANALYSIS_CHECKPOINT_DIR;
  return env && env.length > 0 ? env : DEFAULT_DIR;
}

function getTtlMs(): number {
  const raw = process.env.ANALYSIS_CHECKPOINT_TTL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

function fileFor(stockCode: string): string {
  // 股票代码恒为 6 位数字，但仍做一次收敛，避免路径穿越
  const safe = /^\d{6}$/.test(stockCode) ? stockCode : stockCode.replace(/[^0-9a-zA-Z_-]/g, '_');
  return path.join(getDir(), `${safe}.json`);
}

/**
 * 读取断点；不存在 / 过期 / 损坏 / 代次不符时返回 null（任何异常静默降级为「无断点」）。
 *
 * @param runId 需要校验的代次：传入时只有代次完全一致的断点才可用（并发另一代的断点视为无断点）。
 *              续跑方在读取时尚不知道上一代 id，可省略以获得任意代断点并采用其 runId。
 */
export function loadCheckpoint(stockCode: string, runId?: string): AnalysisCheckpoint | null {
  try {
    const file = fileFor(stockCode);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as AnalysisCheckpoint;
    if (!parsed || parsed.stockCode !== stockCode) return null;
    if (runId !== undefined && parsed.runId !== runId) return null;

    const ttl = getTtlMs();
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    // ttl <= 0 表示不复用任何断点；age >= ttl 视为过期（age 与 ttl 相等即刚好到期）。
    // 不可用 age > ttl：写入与读取落在同一毫秒时 age === 0，ttl 为 0 会被误判为未过期。
    if (!Number.isFinite(age) || ttl <= 0 || age >= ttl) {
      clearCheckpoint(stockCode, parsed.runId); // 过期即清理，避免陈旧数据被误用
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 合并写入断点（保留本代已有阶段产物，仅覆盖本次传入的字段）。
 * 写盘失败静默降级：断点只是优化手段，不影响分析正确性。
 *
 * @param runId 本代代次（由调用方在开跑时 newRunId 得到，续跑沿用它）。
 *              磁盘上残留的其他代断点**不参与合并**——否则并发两代会互相污染：
 *              A 的 experts 产物被 merge 进 B 的断点后，B 中断续跑会拿到
 *              「B 的数据 + A 的专家结论」拼成的报告。
 */
export function saveCheckpoint(
  stockCode: string,
  patch: Omit<AnalysisCheckpoint, 'stockCode' | 'updatedAt' | 'runId'>,
  runId: string,
): void {
  try {
    const dir = getDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(stockCode);
    const prev = loadCheckpointRaw(file);
    // 只有同代才作为合并基底；异代（或旧格式无 runId）一律从头开始，杜绝跨代混写
    const base = prev && prev.runId === runId ? prev : null;
    const next: AnalysisCheckpoint = {
      ...(base ?? {}),
      ...patch,
      stockCode,
      runId,
      updatedAt: new Date().toISOString(),
    };
    // 临时名带代次：并发两代各写各的 tmp，不会互相踩到半写文件
    const tmp = `${file}.${sanitizeRunId(runId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换，避免半写状态
  } catch (err) {
    logger.warn('分析断点写入失败，降级为不续跑', { stockCode, err: err as Error });
  }
}

/**
 * 清除断点（分析成功完成后调用）；失败静默。
 *
 * @param runId 传入时只清本代文件（代次不符则不动），避免把并发另一代的在途断点删掉；
 *              省略时无条件清除（全新分析要丢弃任意残留旧代）。
 */
export function clearCheckpoint(stockCode: string, runId?: string): void {
  try {
    const file = fileFor(stockCode);
    if (!fs.existsSync(file)) return;
    if (runId !== undefined) {
      const onDisk = loadCheckpointRaw(file);
      if (!onDisk || onDisk.runId !== runId) return;
    }
    fs.unlinkSync(file);
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 读取原始断点内容（不做过期判断，供 saveCheckpoint 合并时使用） */
function loadCheckpointRaw(file: string): AnalysisCheckpoint | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as AnalysisCheckpoint;
  } catch {
    return null;
  }
}

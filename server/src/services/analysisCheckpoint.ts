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
  data?: CheckpointDataPayload;
  expertOpinions?: ExpertOpinion[];
  degradedExperts?: string[];
  /** 按 key 取用的专家结论（专家降级时为 undefined），供下游自省逻辑使用 */
  expertByKey?: Record<string, ExpertOpinion | undefined>;
  controversies?: ControversyPoint[];
  finalOpinion?: ExpertOpinion;
}

const DEFAULT_DIR = path.join(import.meta.dirname, '..', 'data', 'checkpoints');

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

/** 读取断点；不存在 / 过期 / 损坏时返回 null（任何异常静默降级为"无断点"） */
export function loadCheckpoint(stockCode: string): AnalysisCheckpoint | null {
  try {
    const file = fileFor(stockCode);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as AnalysisCheckpoint;
    if (!parsed || parsed.stockCode !== stockCode) return null;

    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(age) || age > getTtlMs()) {
      clearCheckpoint(stockCode); // 过期即清理，避免陈旧数据被误用
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 合并写入断点（保留已有阶段产物，仅覆盖本次传入的字段）。
 * 写盘失败静默降级：断点只是优化手段，不影响分析正确性。
 */
export function saveCheckpoint(
  stockCode: string,
  patch: Omit<AnalysisCheckpoint, 'stockCode' | 'updatedAt'>,
): void {
  try {
    const dir = getDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(stockCode);
    const prev = loadCheckpointRaw(file);
    const next: AnalysisCheckpoint = {
      ...(prev ?? {}),
      ...patch,
      stockCode,
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换，避免半写状态
  } catch (err) {
    logger.warn('分析断点写入失败，降级为不续跑', { stockCode, err: err as Error });
  }
}

/** 清除断点（分析成功完成后调用）；失败静默 */
export function clearCheckpoint(stockCode: string): void {
  try {
    const file = fileFor(stockCode);
    if (fs.existsSync(file)) fs.unlinkSync(file);
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

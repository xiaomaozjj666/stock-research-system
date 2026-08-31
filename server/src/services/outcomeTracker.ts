import * as fs from 'fs';
import * as path from 'path';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import type { RatingAccuracy } from '../types.js';
import logger from '../utils/logger.js';

/**
 * 决策-结果闭环（评级事后校准）。
 *
 * 背景（借鉴 TradingAgents 的 decision log）：系统原先的 vs_previous 只比对
 * 「上次评级 vs 这次评级」的观点漂移，回答不了「上次说买入，后来到底涨没涨」。
 * 本模块把每次分析的评级与分析时价格记入只增台账，到期后回填实际收益，
 * 并据此统计各评级的命中率，供仲裁阶段校准使用。
 *
 * 独立台账而非复用 historyService：后者按股票代码去重（每只股票仅保留最新一条），
 * 无法累积同一只股票的多次评级样本，不满足命中率统计的样本量要求。
 */

/** 最短持有天数：不足则该条评级尚未到期，暂不评估 */
export const MIN_HOLD_DAYS = 20;
/** 超额收益基准：沪深300 */
const BENCHMARK_CODE = '000300';
/** 命中率统计的最小样本量：不足时不给出准确率（避免小样本误导） */
const MIN_SAMPLE_FOR_ACCURACY = 3;
/** 台账容量上限：超出后淘汰最旧的已评估记录 */
const MAX_OUTCOME_ITEMS = 500;

/** 看多倾向评级：区间收益为正算命中 */
const BULLISH_RATINGS = ['优先跟踪', '持续观察'];
/** 看空倾向评级：区间收益非正算命中 */
const BEARISH_RATINGS = ['建议规避'];

export interface OutcomeRecord {
  id: string;
  stockCode: string;
  rating: string;
  totalScore: number;
  /** 分析时的价格（评级发出时的基准价） */
  entryPrice: number;
  createdAt: string;
  /** 已评估时填充以下字段 */
  evaluatedAt?: string;
  exitPrice?: number;
  returnPct?: number;
  /** 相对沪深300的超额收益（%）；基准不可得时为 null */
  excessPct?: number | null;
  /** 评级方向是否兑现；中性评级（谨慎观望）不参与判定，为 null */
  hit?: boolean | null;
  holdingDays?: number;
}

interface OutcomeStore {
  items: OutcomeRecord[];
}

const DEFAULT_FILE = path.join(import.meta.dirname, '..', 'data', 'outcomes.json');

function getFile(): string {
  const env = process.env.OUTCOME_FILE;
  return env && env.length > 0 ? env : DEFAULT_FILE;
}

function readStore(): OutcomeStore {
  try {
    const file = getFile();
    if (!fs.existsSync(file)) return { items: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as OutcomeStore;
    return parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeStore(store: OutcomeStore): boolean {
  try {
    const file = getFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换，避免半写状态
    return true;
  } catch {
    return false;
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

const pctChange = (from: number, to: number) => (from > 0 ? ((to - from) / from) * 100 : 0);

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

/**
 * 取某标的最新收盘价；数据不可得或为模拟数据时返回 null。
 * 模拟数据是行情 API 不可达时的合成价格，绝不能用于事后校准（会污染结论）。
 */
async function latestClose(code: string, sinceIso?: string): Promise<number | null> {
  const end = new Date();
  const start = sinceIso ? new Date(sinceIso) : new Date(end.getTime() - 15 * 24 * 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const rows = await fetchOHLCVData(code, fmt(start), fmt(end));
  if (!rows || rows.length === 0) return null;
  if (rows.some((r) => r.isSimulated)) return null;
  const last = rows[rows.length - 1];
  return last && last.close > 0 ? last.close : null;
}

/** 评级方向是否兑现；中性评级返回 null（不参与命中率统计） */
export function judgeHit(rating: string, returnPct: number): boolean | null {
  if (BULLISH_RATINGS.includes(rating)) return returnPct > 0;
  if (BEARISH_RATINGS.includes(rating)) return returnPct <= 0;
  return null;
}

/**
 * 记录一次分析发出的评级（待评估）。
 * 写盘失败静默：事后校准是增强能力，不阻断分析主流程。
 */
export function recordAnalysis(input: {
  stockCode: string;
  rating: string;
  totalScore: number;
  entryPrice: number;
}): void {
  if (!(input.entryPrice > 0)) return; // 无有效价格则无法事后校准
  try {
    const store = readStore();
    store.items.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      stockCode: input.stockCode,
      rating: input.rating,
      totalScore: input.totalScore,
      entryPrice: input.entryPrice,
      createdAt: new Date().toISOString(),
    });
    if (store.items.length > MAX_OUTCOME_ITEMS) {
      // 优先淘汰已评估的最旧记录；全未评估时淘汰最旧
      const evaluated = store.items.filter((it) => it.evaluatedAt);
      const pool = evaluated.length > 0 ? evaluated : store.items;
      const dropId = pool.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id;
      store.items = store.items.filter((it) => it.id !== dropId);
    }
    writeStore(store);
  } catch (err) {
    logger.warn('评级台账写入失败，降级跳过', { stockCode: input.stockCode, err: err as Error });
  }
}

/**
 * 回填到期评级的实际结果（每次最多处理 limit 条，控制耗时）。
 * 单条失败不影响其他条目；返回本次成功评估的条数。
 */
export async function evaluateOutcomes(limit = 3): Promise<number> {
  let done = 0;
  try {
    const store = readStore();
    const pending = store.items
      .filter((it) => !it.evaluatedAt && it.entryPrice > 0)
      .filter((it) => daysSince(it.createdAt) >= MIN_HOLD_DAYS)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));

    for (const item of pending) {
      try {
        // 个体区间收益与基准区间收益并行取，起点统一为评级发出日
        const [exitPrice, benchRows] = await Promise.all([
          latestClose(item.stockCode),
          fetchOHLCVData(
            BENCHMARK_CODE,
            item.createdAt.slice(0, 10),
            new Date().toISOString().slice(0, 10),
          ).catch(() => []),
        ]);
        if (exitPrice === null) continue; // 行情不可得，留待下次

        const returnPct = round2(pctChange(item.entryPrice, exitPrice));
        let excessPct: number | null = null;
        if (
          benchRows.length >= 2 &&
          !benchRows.some((r) => r.isSimulated) &&
          benchRows[0].close > 0
        ) {
          const benchReturn = pctChange(benchRows[0].close, benchRows[benchRows.length - 1].close);
          excessPct = round2(returnPct - benchReturn);
        }

        item.evaluatedAt = new Date().toISOString();
        item.exitPrice = exitPrice;
        item.returnPct = returnPct;
        item.excessPct = excessPct;
        item.hit = judgeHit(item.rating, returnPct);
        item.holdingDays = Math.round(daysSince(item.createdAt));
        done += 1;
      } catch (err) {
        logger.warn('单条评级结果回填失败', { stockCode: item.stockCode, err: err as Error });
      }
    }
    if (done > 0) writeStore(store);
  } catch (err) {
    logger.warn('评级结果回填失败，降级跳过', { err: err as Error });
  }
  return done;
}

/**
 * 统计某只股票历史评级的命中情况。
 * 同时给出该股样本与全市场样本（样本不足时 accuracyPct 为 null）。
 */
export function getRatingAccuracy(stockCode: string): {
  stock: RatingAccuracy;
  overall: RatingAccuracy;
} {
  const items = readStore().items.filter((it) => it.evaluatedAt);
  return {
    stock: summarize(items.filter((it) => it.stockCode === stockCode)),
    overall: summarize(items),
  };
}

function summarize(records: OutcomeRecord[]): RatingAccuracy {
  const judged = records.filter((it) => typeof it.hit === 'boolean');
  const returns = records
    .map((it) => it.returnPct)
    .filter((v): v is number => typeof v === 'number');
  const judgedCount = judged.length;
  const hitCount = judged.filter((it) => it.hit === true).length;
  return {
    sampleCount: records.length,
    judgedCount,
    hitCount,
    accuracyPct:
      judgedCount >= MIN_SAMPLE_FOR_ACCURACY ? round2((hitCount / judgedCount) * 100) : null,
    avgReturnPct:
      returns.length > 0 ? round2(returns.reduce((s, v) => s + v, 0) / returns.length) : null,
  };
}

/**
 * 把命中率摘要格式化为可注入仲裁提示的自然语言。
 * 样本不足时返回 null（避免小样本噪声干扰仲裁判断）。
 */
export function formatAccuracyHint(stockCode: string): string | null {
  const { stock, overall } = getRatingAccuracy(stockCode);
  const parts: string[] = [];
  if (stock.accuracyPct !== null) {
    parts.push(
      `该股(${stockCode})历史评级命中率 ${stock.accuracyPct}%（${stock.hitCount}/${stock.judgedCount} 次方向判断兑现）`,
    );
  }
  if (overall.accuracyPct !== null) {
    parts.push(
      `全样本评级命中率 ${overall.accuracyPct}%（${overall.hitCount}/${overall.judgedCount}）`,
    );
  }
  if (parts.length === 0) return null;
  if (overall.avgReturnPct !== null) {
    parts.push(`历史评级后平均区间收益 ${overall.avgReturnPct}%`);
  }
  return parts.join('；') + '。请据此校准本次判断的自信程度，命中率偏低时应更保守。';
}

// === 定时回填 ===
// evaluateOutcomes 目前只在分析触发时执行（每次限量），若某只股票长期无人分析，
// 其台账将停留在"待评估"，命中率统计随之失真。此处提供进程级定时回填。

/** 默认回填间隔：6 小时（行情时效与成本平衡） */
const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动后首次回填的错峰延迟 */
const FIRST_RUN_DELAY_MS = 30 * 1000;
/** 每轮回填条数上限 */
const REFRESH_BATCH_SIZE = 5;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 启动评级结果定时回填（仅进程入口调用；测试环境经 NODE_ENV!=='test' 隔离）。
 * 首轮在启动后错峰执行，之后按间隔周期回填；单轮失败静默，下次再试。
 * 重复调用为幂等（已启动则忽略）。
 */
export function startOutcomeRefresher(intervalMs = DEFAULT_REFRESH_INTERVAL_MS): void {
  if (refreshTimer || refreshInterval) return;
  const tick = () => {
    void evaluateOutcomes(REFRESH_BATCH_SIZE).catch(() => undefined);
  };
  refreshTimer = setTimeout(tick, FIRST_RUN_DELAY_MS);
  refreshInterval = setInterval(tick, intervalMs);
  // 不阻止进程退出（与 scheduler.ts 自治循环同一约定）
  for (const t of [refreshTimer, refreshInterval]) {
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  }
}

/** 停止定时回填（优雅关闭时调用）；未启动时为安全空操作 */
export function stopOutcomeRefresher(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

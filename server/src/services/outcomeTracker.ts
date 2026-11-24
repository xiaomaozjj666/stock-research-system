import * as fs from 'fs';
import * as path from 'path';

import { DATA_ROOT } from '../dataRoot.js';
import {
  A_SHARE_BENCHMARK_SECID,
  fetchKlineBySecid,
  fetchOHLCVData,
} from '../quant/dataProvider.js';
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
/**
 * 超额收益基准：沪深300。
 * **必须走 secid（1.000300）而不是代码**：resolveSecid('000300') 会按「非 6 开头
 * → 深市」拼成 0.000300，上游返回空 → 模拟数据降级 → excessPct 恒为 null。
 * 这条曾经让「相对沪深300 超额」整维从未生效（2026-11-20 子代理审查实测）。
 */
const BENCHMARK_SECID = A_SHARE_BENCHMARK_SECID;
const BENCHMARK_CACHE_TOKEN = 'A_SHARE_BENCHMARK';
/** 退出价最大陈旧度（自然日）：缓存尾部补拉失败时，数日前的收盘价不能当今日价 */
const MAX_EXIT_STALENESS_DAYS = 5;
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
  /**
   * 区间收益（%）。口径：**建仓/退出都用前复权（fqt=1）收盘价**——
   * 快照 entryPrice 是未复权的实时价，与复权收盘价混用会让送转/除息直接
   * 变成假命中/假失败（10 转 5 平盘 = −33%）。entryPrice 仅留作审计。
   */
  returnPct?: number;
  /** 评估时实际使用的复权建仓价（审计/复算用，可选） */
  entryAdjClose?: number;
  /** 相对沪深300的超额收益（%）；基准不可得时为 null */
  excessPct?: number | null;
  /** 评级方向是否兑现；中性评级（谨慎观望）不参与判定，为 null */
  hit?: boolean | null;
  holdingDays?: number;
}

interface OutcomeStore {
  items: OutcomeRecord[];
}

const DEFAULT_FILE = path.join(DATA_ROOT, 'outcomes.json');

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
  } catch (err) {
    // 损坏≠不存在：若静默当空台账，下一次写入会用空/半量数据把损坏文件整体覆盖，
    // 一次 JSON 截断就永久清零全部评级历史。改名留档（可人工恢复）+ 明确告警，
    // 让「台账坏了」这件事可见、可追溯。
    try {
      const file = getFile();
      if (fs.existsSync(file)) {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      }
    } catch {
      /* 留档失败：至少下面的 warn 会留下痕迹 */
    }
    logger.warn('评级台账损坏，已改名留档并按空台账继续（历史样本需人工恢复）', { err });
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

/**
 * 台账写入串行锁（**仅覆盖跨 await 的读-改-写**）。
 * evaluateOutcomes 是「读快照 → await 取行情 → 写回」的跨 await 读-改-写：
 * 并发/重叠执行（/api/compare 并行分析、6 小时定时回填与分析收尾重叠）会互相覆盖，
 * 导致评级记录或回填结果静默丢失。这里把此类异步操作排成队列串行执行。
 *
 * 边界（勿误解）：recordAnalysis 是**纯同步**读-改-写、不经过本队列——今日安全
 * 依赖单线程同步原子性。若将来给它加任何 await（如换异步文件 API），必须先接入
 * 本队列，否则会重新引入丢更新。跨进程（cluster/pm2）本锁不生效，需外部部署约束。
 */
let storeLock: Promise<void> = Promise.resolve();

function withStoreLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const result = storeLock.then(() => fn());
  // 无论成功失败都续上队列，避免一次异常让后续写入永久挂起
  storeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const pctChange = (from: number, to: number) => (from > 0 ? ((to - from) / from) * 100 : 0);

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
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
    if (!writeStore(store)) {
      // writeStore 内部吞掉异常只返回 false：不看返回值的话，磁盘满/目录只读时
      // 决策-结果闭环会永久失效且没有任何痕迹
      logger.warn('评级台账写入失败（磁盘/权限问题？），本次评级未入账', {
        stockCode: input.stockCode,
      });
    }
  } catch (err) {
    logger.warn('评级台账写入失败，降级跳过', { stockCode: input.stockCode, err: err as Error });
  }
}

/**
 * 回填到期评级的实际结果（每次最多处理 limit 条，控制耗时）。
 * 单条失败不影响其他条目；返回本次成功评估的条数。
 * signal 置位（上层限时超时）时停止向剩余条目取数：已完成条目仍会落盘，
 * 未完成的留待下一轮——回填是幂等的，中途收手不会留下半条脏记录。
 */
export async function evaluateOutcomes(limit = 3, signal?: AbortSignal): Promise<number> {
  return withStoreLock(() => evaluateOutcomesLocked(limit, signal));
}

async function evaluateOutcomesLocked(limit: number, signal?: AbortSignal): Promise<number> {
  let done = 0;
  try {
    const store = readStore();
    const pending = store.items
      .filter((it) => !it.evaluatedAt)
      .filter((it) => daysSince(it.createdAt) >= MIN_HOLD_DAYS)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));

    for (const item of pending) {
      if (signal?.aborted) break; // 已取消：不再为剩余条目打行情上游
      try {
        const startDate = item.createdAt.slice(0, 10);
        const endDate = new Date().toISOString().slice(0, 10);
        // 个股与基准都取「评级日 → 今天」整段：
        //  - 建仓价取区间**第一根真实收盘价**（fqt=1 复权口径与退出价一致；
        //    快照 entryPrice 是未复权实时价，送转/除息会把它变成假命中/假失败）；
        //  - 基准必须走 secid 1.000300（代码 000300 会被解析成深市 0.000300 → 空）。
        const [bars, benchRows] = await Promise.all([
          fetchOHLCVData(item.stockCode, startDate, endDate, signal).catch(() => []),
          fetchKlineBySecid(
            BENCHMARK_SECID,
            startDate,
            endDate,
            BENCHMARK_CACHE_TOKEN,
            15000,
            signal,
          ).catch(() => []),
        ]);
        const realBars = bars.filter((b) => !b.isSimulated && b.close > 0);
        // 至少 2 根才构成持有区间：区间内只有 1 根（评级日非交易日且此后停牌/
        // 数据只回 1 行）时建仓价=退出价，returnPct 恒 0 并**永久落盘判定**——
        // 看多记未命中、看空记命中，持续污染命中率。留待下次回填重试。
        if (realBars.length < 2) continue;
        const last = realBars[realBars.length - 1];
        // 缓存尾部补拉失败时，最后一行可能是数日前的价——不能当「今日退出价」
        // 永久落盘（写入 evaluatedAt 后不会再重评）
        if (daysSince(`${last.date}T00:00:00Z`) > MAX_EXIT_STALENESS_DAYS) continue;

        const entryAdjClose = realBars[0].close;
        const exitPrice = last.close;
        const returnPct = round2(pctChange(entryAdjClose, exitPrice));

        let excessPct: number | null = null;
        const realBench = benchRows.filter((r) => !r.isSimulated && r.close > 0);
        if (realBench.length >= 2) {
          const benchLast = realBench[realBench.length - 1];
          if (daysSince(`${benchLast.date}T00:00:00Z`) <= MAX_EXIT_STALENESS_DAYS) {
            const benchReturn = pctChange(realBench[0].close, benchLast.close);
            excessPct = round2(returnPct - benchReturn);
          }
        }

        item.evaluatedAt = new Date().toISOString();
        item.exitPrice = exitPrice;
        item.entryAdjClose = round2(entryAdjClose);
        item.returnPct = returnPct;
        item.excessPct = excessPct;
        item.hit = judgeHit(item.rating, returnPct);
        item.holdingDays = Math.round(daysSince(item.createdAt));
        done += 1;
      } catch (err) {
        // 本轮取数被取消：不是「回填失败」，不必为剩余条目重复报同一个原因
        if (signal?.aborted) break;
        logger.warn('单条评级结果回填失败', { stockCode: item.stockCode, err: err as Error });
      }
    }
    if (done > 0) {
      // 写前重读并按 id 合并，而不是写回本轮开始时的陈旧快照：
      // 取行情期间可能有新评级写入（recordAnalysis），整份覆盖会静默丢掉这些记录。
      const fresh = readStore();
      const byId = new Map(fresh.items.map((it) => [it.id, it]));
      for (const item of pending) {
        if (!item.evaluatedAt) continue; // 本轮未成功评估的条目保持原样
        const target = byId.get(item.id);
        if (!target) continue; // 期间已被容量淘汰，不再复活
        target.evaluatedAt = item.evaluatedAt;
        target.exitPrice = item.exitPrice;
        target.entryAdjClose = item.entryAdjClose;
        target.returnPct = item.returnPct;
        target.excessPct = item.excessPct;
        target.hit = item.hit;
        target.holdingDays = item.holdingDays;
      }
      if (!writeStore(fresh)) {
        logger.warn('评级回填结果写盘失败（磁盘/权限问题？），本轮结果将在下次重算', {
          evaluated: done,
        });
      }
    }
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
  const items = readStore().items;
  const evaluated = items.filter((it) => it.evaluatedAt);
  const attachPending = (acc: RatingAccuracy, pending: number): RatingAccuracy =>
    pending > 0 ? { ...acc, pendingCount: pending } : acc;
  const stockPending = items.filter((it) => it.stockCode === stockCode && !it.evaluatedAt).length;
  return {
    stock: attachPending(
      summarize(evaluated.filter((it) => it.stockCode === stockCode)),
      stockPending,
    ),
    overall: attachPending(summarize(evaluated), items.filter((it) => !it.evaluatedAt).length),
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

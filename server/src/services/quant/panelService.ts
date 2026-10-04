/**
 * 跨领域共用的量化面板辅助（取数扇出 / 入参校验 / 模拟数据闸门 / 台账留痕）
 *
 * 原本全部内联在 routes/quant.ts 里，被一个以上领域引用。按领域拆分时集中到
 * services/ 层而不是留在 routes/：这些是**业务规则**（如模拟数据必须拒绝计算 IC、
 * 持有期上限、并发硬上限），放进路由文件既测不到也会被复制成多份分叉。
 * 本文件由原 routes/quant.ts 机械迁移而来（2026-09-28），逻辑逐字未改。
 */

import {
  judgeFactor,
  type FactorPeriodReport,
  type FactorVerdict,
} from '../../quant/factorEvaluation.js';
import { getHarnessPolicy } from '../../quant/harnessPolicy.js';
import { type StockPanelInput } from '../../quant/crossSectionBuilder.js';
import {
  fetchBoardConstituentsWithMeta,
  hasCachedConstituents,
  isValidBoardCode,
} from '../../quant/universeProvider.js';
import {
  fetchFinancialDataCached,
  fetchQuarterlyFinancialsCached,
} from '../../quant/fundamentalCache.js';
import { type PreflightResult } from '../../quant/preflight.js';
import {
  fetchIndexConstituentsCached,
  BAOSTOCK_INDEXES,
  type BaostockIndex,
} from '../../quant/baostockBridge.js';
import {
  DateRangeParamError,
  DEFAULT_FACTOR_WINDOW_DAYS,
  resolveDateRange,
  type ResolveDateRangeSpec,
} from '../../utils/dateRange.js';
import {
  type FactorExperimentInput,
  type FactorExperimentSource,
} from '../../quant/factorLedger.js';
import { type PortfolioBacktestOptions } from '../../quant/portfolioBacktest.js';
import { fetchStockEvents } from '../../quant/eventProvider.js';
import { fetchMarginSeries } from '../../quant/marginProvider.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchOHLCVData } from '../../quant/dataProvider.js';
import { errorDetail } from '../../utils/errorDetail.js';
import logger from '../../utils/logger.js';

/**
 * 量化运行快照（可复现留痕）：把「这次是用什么参数 / 数据区间 / 运行时跑出来的」
 * 随结果返回并留档——研究报告事后要能复盘，光有结论没有参数是没法复现的。
 */
export function runSnapshot(fields: Record<string, unknown>): Record<string, unknown> {
  return { at: new Date().toISOString(), node: process.version, ...fields };
}
/**
 * 采信判定走**当前生效**的 Harness 策略（未经改进循环改动时即出厂值，行为与硬编码时期一致）。
 *
 * 每次调用现取策略，而不是在模块加载时缓存一份：改进循环可能在任何两次分析之间
 * 保留新判据，加载时缓存会让改动"看起来没生效"，排查起来极难。
 * getHarnessPolicy() 内部有内存缓存，逐持有期调用不产生额外 IO。
 */
export function judgeWithActivePolicy(p: FactorPeriodReport): FactorVerdict {
  return judgeFactor(p, getHarnessPolicy());
}
/** 评估结果的因子形态（台账只关心这几个字段，避免与评估器类型硬耦合） */
export interface LedgerFactorInput {
  name: string;
  report: {
    sampleSize?: number;
    byPeriod?: {
      period: number;
      ic?: { mean?: number; pValue?: number; n?: number };
      oos?: { stable?: boolean };
      quantile?: { rows?: unknown[]; monotonicity?: number; spread?: number };
      verdict?: { effective?: boolean };
    }[];
  };
}
/** 把评估结果摊平成台账条目：因子 × 持有期各一条 */
export function ledgerEntriesFromReport(
  factors: LedgerFactorInput[],
  meta: {
    source: FactorExperimentSource;
    universe: FactorExperimentInput['universe'];
    name?: string;
    expression?: string;
  },
): FactorExperimentInput[] {
  const out: FactorExperimentInput[] = [];
  for (const f of factors) {
    for (const p of f.report?.byPeriod ?? []) {
      // 判据输入留痕：改进循环据此回放候选判据。四项齐全才落块——残缺的证据
      // 会让回放把「字段缺失」误当成「数值为 0」，宁可这条记录不参与调优。
      const evidences =
        typeof p.ic?.n === 'number' &&
        typeof p.quantile?.monotonicity === 'number' &&
        typeof p.quantile?.spread === 'number' &&
        Array.isArray(p.quantile?.rows)
          ? {
              icN: p.ic.n,
              quantileRows: p.quantile.rows.length,
              monotonicity: p.quantile.monotonicity,
              spread: p.quantile.spread,
            }
          : null;
      out.push({
        source: meta.source,
        name: meta.name ?? f.name,
        ...(meta.expression ? { expression: meta.expression } : {}),
        universe: meta.universe,
        horizon: p.period,
        sampleSize: f.report?.sampleSize ?? 0,
        icMean: p.ic?.mean ?? Number.NaN,
        pValue: p.ic?.pValue ?? Number.NaN,
        oosStable: Boolean(p.oos?.stable),
        kept: Boolean(p.verdict?.effective),
        ...(evidences ? { evidence: evidences } : {}),
      });
    }
  }
  return out;
}
// === 持有期档位上限 ===
// horizons 里每一档都是一轮完整的全截面测算（CPU 与上游配额随档数线性放大），
// 此前只过滤了"有限且 > 0"，没有上界也没有个数上限：
// {"horizons":[1,2,3,...×1000]} 能把单次请求放大成千轮同步计算，顶住事件循环。
// 504 = 两年交易日，超出已无回看意义。
export const MAX_HORIZON_DAYS = 504;
export const MAX_HORIZONS = 8;
/** horizons 缺省档位：组合/截面/表达式各路由的历史默认值一致 */
export const DEFAULT_HORIZONS: readonly number[] = [21, 63];
/** 持有期参数非法（路由据此回 400 而不是 500）；message 为可直接展示的中文说明 */
export class HorizonParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HorizonParamError';
  }
}
/**
 * horizons 的统一解析（五处路由共用，含 composite / composite-batch / cross-section /
 * expression / expression-batch）。
 *
 * 不合法即**明确拒绝**（抛 HorizonParamError → 路由回 400 + 中文说明），**不静默回落默认值**：
 * 此前四处口径各不相同（单只 composite 连上界都没有，`h=1e9` 能过；batch 先 floor
 * 再没复检下界，`h=0.5` 会变成 0 → 后续 `Math.ceil(m/0)` 得 Infinity → tStat 变 NaN
 * → 响应里字段成 null，静默产出错误的显著性数据；截面/表达式只有单元素值域、无个数上限，
 * 16000 个整数约 64KB body 就能通过，每档一轮全截面测算）。
 *
 * 统一的说法是「传了就必须合法」，只有字段缺失才用默认值：
 *   - 非数组（含 undefined/null）→ DEFAULT_HORIZONS；
 *   - 空数组 / 含非整数 / 含 <1 / 含 >MAX_HORIZON_DAYS → 拒绝；
 *   - 个数超过 MAX_HORIZONS → 拒绝（不静默截断，避免"点了 20 档只算了 8 档"的错觉）；
 *   - 重复档位去重（同档重复计算没有意义，只浪费 CPU）。
 */
export function parseHorizons(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [...DEFAULT_HORIZONS];
  if (!Array.isArray(raw)) {
    throw new HorizonParamError('horizons 需为整数数组（如 [21, 63]）');
  }
  if (raw.length === 0) {
    throw new HorizonParamError('horizons 不能为空数组：请给出至少一个持有期（如 21）');
  }
  if (raw.length > MAX_HORIZONS) {
    throw new HorizonParamError(`horizons 档位过多（${raw.length} > ${MAX_HORIZONS}）`);
  }
  const out: number[] = [];
  for (const value of raw) {
    const h = Math.trunc(Number(value));
    if (!Number.isInteger(h) || h < 1 || h > MAX_HORIZON_DAYS) {
      throw new HorizonParamError(
        `horizons 每档需为 1-${MAX_HORIZON_DAYS} 的整数（当前：${String(value)}）`,
      );
    }
    if (!out.includes(h)) out.push(h);
  }
  return out;
}
/** horizons 解析失败 → 400 + 中文说明（五处路由共用同一响应口径） */
export function horizonsOrReject(
  raw: unknown,
  res: { status: (n: number) => { json: (b: unknown) => void } },
) {
  try {
    return { ok: true as const, horizons: parseHorizons(raw) };
  } catch (error) {
    if (error instanceof HorizonParamError) {
      res.status(400).json({ error: error.message });
      return { ok: false as const };
    }
    throw error;
  }
}
/**
 * 取数区间统一解析（composite / composite-batch / expression / expression-batch 四处共用）。
 *
 * 此前这四处只对 startDate/endDate 做 `String()` 强转（expression 两条甚至完全忽略入参、
 * 固定 730 天窗口）：非法日期 / 倒置区间 / 十年以上的超长跨度会原样落到「每只股票按同一
 * 区间拉一遍 K 线」上，截面宽度 × 区间长度直接乘出上游成本。现在与全市场初筛共用
 * utils/dateRange 的同一套规则（真实日历日 / 顺序 / 跨度上限），非法即 400 + 中文原因，
 * **不静默回落默认值**（回落会让调用方以为跑的是自己给的区间）。
 *
 * 未传时沿用各路由既有默认区间（defaultSpanDays），正常路径行为不变。
 */
export function datesOrReject(
  startDate: unknown,
  endDate: unknown,
  res: { status: (n: number) => { json: (b: unknown) => void } },
  spec: ResolveDateRangeSpec = { defaultSpanDays: DEFAULT_FACTOR_WINDOW_DAYS },
) {
  try {
    return {
      ok: true as const,
      ...resolveDateRange(
        startDate === undefined || startDate === null ? undefined : String(startDate),
        endDate === undefined || endDate === null ? undefined : String(endDate),
        spec,
      ),
    };
  } catch (error) {
    if (error instanceof DateRangeParamError) {
      res.status(400).json({ error: error.message });
      return { ok: false as const };
    }
    throw error;
  }
}
// === 模拟数据（合成 K 线）不得流入结论 ===
// dataProvider 在行情源不可达时会返回按代码播种的确定性合成 K 线（isSimulated=true，
// 见 dataProvider.ts 的「真失败且无历史 → 降级模拟数据」分支）。它只适合演示，
// 一旦流入 IC/t/p、compositeAlpha、totalReturn/sharpe 这类**看起来像真实结论**的字段，
// 用户拿到的是 HTTP 200 且无从分辨的伪结果——比报错危险得多。
//
// 与既有单只路径的披露口径保持一致（/api/quant/analyze 的 limitations
// 「当前使用模拟数据，回测结果仅供参考」、fetchBenchmarkReturns 遇模拟指数直接返回
// null）：回测/组合 alpha 这类**产出可交易结论**的路径必须拒绝，而不是「披露后继续算」；
// 单只 analyze 的披露逻辑保持原样不动。
//
// 统一响应：422 + { error: '行情源不可用，本次未使用模拟数据', degraded: true }
export const SIMULATED_DATA_ERROR = '行情源不可用，本次未使用模拟数据';
/** 单只/单序列取数后的模拟数据检查 */
export function hasSimulatedBars(bars: { isSimulated?: boolean }[] | null | undefined): boolean {
  return Array.isArray(bars) && bars.some((b) => b?.isSimulated === true);
}
/** 命中模拟数据 → 422（degraded 标记调用方据此展示降级原因），返回 true 表示响应已写出 */
export function rejectIfSimulated(
  bars: { isSimulated?: boolean }[] | null | undefined,
  res: { status: (n: number) => { json: (b: unknown) => void } },
): boolean {
  if (!hasSimulatedBars(bars)) return false;
  res.status(422).json({ error: SIMULATED_DATA_ERROR, degraded: true });
  return true;
}
/** 批量路径命中模拟数据 → 422 并列出命中的代码（degraded 标记降级原因） */
export function rejectIfAnySimulated(
  codes: string[],
  res: { status: (n: number) => { json: (b: unknown) => void } },
): boolean {
  if (codes.length === 0) return false;
  res.status(422).json({
    error: SIMULATED_DATA_ERROR,
    degraded: true,
    simulatedCodes: codes.slice(0, 10),
  });
  return true;
}
// === 截面 universe 宽度与并发上限（2026-09-05 放开） ===
// 截面框架的统计功效随横截面宽度增长：板块内 30 只原本够用，但要上全市场多行业
// 大面板（几百只）必须放宽。宽度与并发都走 env，便于按部署的算力与上游限流配额调整；
// 另设硬上限兜底，防止误配极大值把服务拖死。
// 注意：放宽上限只是「允许」，默认 topN 仍为 10，行为只在显式请求更宽时改变。
export const CROSS_SECTION_MAX_CODES_HARD_CAP = 2000;
export const CROSS_SECTION_CONCURRENCY_HARD_CAP = 16;
export function crossSectionMaxCodes(): number {
  const raw = Number(process.env.QUANT_CROSS_SECTION_MAX_CODES);
  if (!Number.isFinite(raw) || raw <= 0) return 300;
  return Math.min(Math.floor(raw), CROSS_SECTION_MAX_CODES_HARD_CAP);
}
export function crossSectionConcurrency(): number {
  const raw = Number(process.env.QUANT_CROSS_SECTION_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) return 8;
  return Math.min(Math.max(Math.floor(raw), 1), CROSS_SECTION_CONCURRENCY_HARD_CAP);
}
/** universe 解析的统一返回：ok=false 时 status/payload 由调用方直接回写 */
export type UniverseResolution =
  | { ok: true; codes: string[]; universe: Record<string, unknown> }
  | { ok: false; status: number; payload: Record<string, unknown> };
/**
 * universe 解析（cross-section / expression / batch 三路由共用）：
 * indexUniverse（指数历史成分，Baostock sidecar）→ board（板块成分股，截面
 * 拉宽主路径）→ 显式 codes；board 路径的门槛是板块列表源（push2 clist，
 * 与 K 线源不同域名）。
 */
export async function resolveUniverse(
  body: { board?: unknown; codes?: unknown; topN?: unknown; indexUniverse?: unknown },
  preflight: PreflightResult,
): Promise<UniverseResolution> {
  const upstreamListOk = preflight.checks.find((c) => c.key === 'upstream_list')?.ok ?? false;
  const MAX_CODES = crossSectionMaxCodes();
  // 指数历史成分宇宙（Baostock sidecar，可选源）：hs300/zz500/sz50 在指定日期的
  // 成分快照，**含其后退市的证券**——幸存者偏差的正面修复。成分不可变 → 30 天
  // 缓存；Python/baostock 缺失或上游失败时 502 给可执行指引。
  if (
    body.indexUniverse !== undefined &&
    body.indexUniverse !== null &&
    typeof body.indexUniverse === 'object'
  ) {
    const iu = body.indexUniverse as { index?: unknown; date?: unknown };
    const index = String(iu.index ?? '')
      .trim()
      .toLowerCase();
    if (!(BAOSTOCK_INDEXES as readonly string[]).includes(index)) {
      return {
        ok: false,
        status: 400,
        payload: {
          error: `indexUniverse.index 需为 ${BAOSTOCK_INDEXES.join(' / ')} 之一（当前：${index || '空'}）`,
        },
      };
    }
    let date: string | null = null;
    if (iu.date !== undefined && iu.date !== null && String(iu.date).trim() !== '') {
      const raw = String(iu.date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return {
          ok: false,
          status: 400,
          payload: { error: `indexUniverse.date 需为 YYYY-MM-DD 格式（当前：${raw}）` },
        };
      }
      date = raw;
    }
    try {
      const r = await fetchIndexConstituentsCached(index as BaostockIndex, date);
      if (r.constituents.length < 2) {
        return {
          ok: false,
          status: 422,
          payload: {
            error: `指数 ${index} 在 ${r.updateDate ?? date ?? '最新'} 的有效成分仅 ${r.constituents.length} 只，无法构成截面`,
          },
        };
      }
      return {
        ok: true,
        codes: r.constituents.map((c) => c.code),
        universe: {
          source: 'index',
          index,
          requestedDate: date,
          updateDate: r.updateDate,
          requested: r.constituents.length,
          constituents: r.constituents,
        },
      };
    } catch (error) {
      logger.warn('指数历史成分获取失败', { index, date, err: error });
      return {
        ok: false,
        status: 502,
        payload: {
          error: `指数 ${index} 历史成分获取失败`,
          // 非生产环境回原始报错（可能是 Python/baostock 的解释器路径），生产环境不回
          detail: errorDetail(error),
          hint: '本机需要 Python + baostock（pip install baostock，或 PYTHON_BIN 指定解释器）；或改用 board / codes 源',
        },
      };
    }
  }
  if (body.board !== undefined && body.board !== null && String(body.board).trim() !== '') {
    const board = String(body.board).trim().toUpperCase();
    if (!isValidBoardCode(board)) {
      return { ok: false, status: 400, payload: { error: `无效的板块代码：${body.board}` } };
    }
    const topNRaw = body.topN === undefined || body.topN === null ? 10 : Number(body.topN);
    if (!Number.isInteger(topNRaw) || topNRaw < 3 || topNRaw > MAX_CODES) {
      return {
        ok: false,
        status: 400,
        payload: { error: `topN 需为 3-${MAX_CODES} 的整数（当前：${body.topN}）` },
      };
    }
    // 精准预检：板块列表源不可达且该板块成分股无本地缓存 → 直接 503 给可行指引，
    // 而不是陪跑一轮注定失败的网络尝试（有缓存时仍走陈旧兜底，不拦）
    if (!upstreamListOk && !hasCachedConstituents(board, topNRaw)) {
      return {
        ok: false,
        status: 503,
        payload: {
          error: `板块列表源不可用，且板块 ${board} 无本地缓存成分股`,
          detail: preflight.checks.find((c) => c.key === 'upstream_list')?.detail,
          hint: '稍后重试；或改用 codes 指定此前评估过的股票（均有本地缓存）',
          preflight,
        },
      };
    }
    try {
      const cons = await fetchBoardConstituentsWithMeta(board, topNRaw);
      if (cons.value.length < 2) {
        return {
          ok: false,
          status: 422,
          payload: { error: `板块 ${board} 有效成分股仅 ${cons.value.length} 只，无法构成截面` },
        };
      }
      return {
        ok: true,
        codes: cons.value.map((c) => c.code),
        universe: {
          source: 'board',
          board,
          requested: cons.value.length,
          constituents: cons.value.map(({ code, name }) => ({ code, name })),
          // 上游抖动但有历史快照时，披露「本次用的是陈旧成分股列表」
          ...(cons.stale ? { stale: true, staleAgeMs: cons.staleAgeMs } : {}),
        },
      };
    } catch (error) {
      logger.warn('板块成分股获取失败', { board, err: error });
      return {
        ok: false,
        status: 502,
        payload: {
          error: `板块 ${board} 成分股获取失败`,
          detail: errorDetail(error),
          ...(!upstreamListOk && !hasCachedConstituents(board, topNRaw)
            ? { hint: '板块列表源当前不可用，可稍后重试，或改用 codes 指定已缓存过的股票' }
            : {}),
        },
      };
    }
  }
  const rawCodes = Array.isArray(body.codes) ? body.codes.map(String) : [];
  if (rawCodes.length < 2 || rawCodes.length > MAX_CODES) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: `请提供 2-${MAX_CODES} 只股票代码（codes），或传 board 指定行业板块`,
      },
    };
  }
  for (const c of rawCodes) {
    if (!/^\d{6}$/.test(c)) {
      return { ok: false, status: 400, payload: { error: `无效的股票代码：${c}` } };
    }
  }
  return { ok: true, codes: rawCodes, universe: { source: 'codes', requested: rawCodes.length } };
}
/** 面板取数（三路由共用）：行情 + 季度财报（PIT 基本面/PEAD 源）+ 可选年报快照与事件 */
export async function fetchPanelInputs(
  codes: string[],
  opts: {
    start: string;
    end: string;
    signal: AbortSignal;
    withFinancial?: boolean;
    withQuarterly?: boolean;
    withEvents?: boolean;
    withMargin?: boolean;
  },
): Promise<{ inputs: StockPanelInput[]; simulatedCodes: string[] }> {
  const inputs = await mapWithConcurrency(
    codes,
    crossSectionConcurrency(),
    async (code: string) => {
      const bars = await fetchOHLCVData(code, opts.start, opts.end, opts.signal).catch(() => []);
      // 模拟数据闸门（截面路径）：此前只 `.catch(() => [])`，从不检查 isSimulated，
      // 于是合成曲线会一路流入逐日截面 IC / t / p（见调用方的 rejectIfAnySimulated）。
      // 这里只标记，不在此处抛错——由调用方决定整批拒绝的响应形态。
      const financial = opts.withFinancial
        ? await fetchFinancialDataCached(code, opts.signal).catch(() => null)
        : null;
      const quarterly = opts.withQuarterly
        ? await fetchQuarterlyFinancialsCached(code, 16, opts.signal).catch(() => null)
        : null;
      const events = opts.withEvents ? await fetchStockEvents(code, opts.signal) : null;
      // 两融序列（PIT 源，T+1 披露）：失败降级为空数组——缺两融只是少两个因子，
      // 不拖垮其余因子（与事件同模式）
      const margin = opts.withMargin
        ? await fetchMarginSeries(code, opts.signal).catch(() => [])
        : null;
      return { code, bars, financial, quarterly, events, margin };
    },
    { signal: opts.signal },
  );
  // 按输入顺序给出命中代码（mapWithConcurrency 的 results 是按序的，push 顺序受并发影响）
  return {
    inputs,
    simulatedCodes: inputs.filter((i) => hasSimulatedBars(i.bars)).map((i) => i.code),
  };
}
/** 组合回测参数解析：范围外的值回落默认（一行内错误笔误的容错口径） */
export function parsePortfolioOpts(raw: unknown): PortfolioBacktestOptions | null {
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const p = raw as { holdDays?: unknown; topN?: unknown; costBps?: unknown };
  const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  return {
    holdDays: num(p.holdDays, 1, 250, 21),
    topN: num(p.topN, 1, 50, 5),
    costBps: num(p.costBps, 0, 500, 30),
  };
}

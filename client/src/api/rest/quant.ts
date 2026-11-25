/**
 * 量化研究域：量化分析 / 批量组合 alpha / 截面因子 / 因子表达式 / 实验台账 / 上游预检。
 */
import type {
  CompositeAlphaBatchResult,
  CrossSectionResult,
  QuantResearchReport,
} from '../../pages/quant/types';
import { isCancelled } from '../http';
import { api, AnalysisCancelledError, normalizeApiError } from './base';

export async function runQuantAnalysis(
  payload: {
    strategy: unknown;
    useNews?: boolean;
    newsItems?: {
      id: string;
      title: string;
      summary?: string;
      publishedAt: string;
      polarity?: number;
    }[];
  },
  signal?: AbortSignal,
): Promise<QuantResearchReport> {
  try {
    // 泛型指向页面自己的报告类型（pages/quant/types.ts），而不是在此复制一份：
    // 两处定义一旦分叉，泛型会立刻在调用点报错，这正是我们想要的检查。
    const response = await api.post<QuantResearchReport>('/quant/analyze', payload, { signal });
    return response.data;
  } catch (error: unknown) {
    // 用户主动取消：以专用类型上抛，调用方据此静默收尾而非当失败渲染
    if (isCancelled(error)) throw new AnalysisCancelledError('研究已取消');
    throw normalizeApiError(error, '量化分析失败');
  }
}

export async function runBatchCompositeAlpha(
  payload: {
    stockCodes: string[];
    startDate?: string;
    endDate?: string;
    horizons?: number[];
  },
  signal?: AbortSignal,
): Promise<CompositeAlphaBatchResult> {
  try {
    // 服务端在 result 之外还附带 run / preflight 两个复现快照字段，
    // 页面当前不消费，故泛型只声明被消费的子集（多余字段运行时仍在，不影响渲染）。
    const response = await api.post<CompositeAlphaBatchResult>(
      '/quant/factor/composite/batch',
      payload,
      {
        // 批量测算：每只都要拉 K 线 + 基准，放宽超时（上限 20 只）
        timeout: 180000,
        signal,
      },
    );
    return response.data;
  } catch (error: unknown) {
    // 用户主动取消：以专用类型上抛，调用方据此静默收尾而非当失败渲染
    if (isCancelled(error)) throw new AnalysisCancelledError('批量测算已取消');
    throw normalizeApiError(error, '批量组合 alpha 测算失败');
  }
}

/**
 * 行业板块列表（截面因子 universe 下拉用）。
 * 页面挂载时截面面板与因子实验室会各请求一次，而该端点有 30 req/min 限流；
 * 这里做 in-flight 去重 + 5 分钟结果缓存，避免同一份低频数据被重复请求。
 * 失败不缓存（否则一次上游抖动会让下拉在整个会话内永久不可用）。
 */
const BOARDS_TTL_MS = 5 * 60_000;
type UniverseBoards = { boards: { code: string; name: string }[] };
let boardsCache: { at: number; promise: Promise<UniverseBoards> } | null = null;

export function getUniverseBoards(): Promise<UniverseBoards> {
  const now = Date.now();
  if (!boardsCache || now - boardsCache.at > BOARDS_TTL_MS) {
    boardsCache = {
      at: now,
      promise: api
        .get<UniverseBoards>('/quant/universe/boards', { timeout: 20000 })
        .then((response) => response.data)
        .catch((error: unknown) => {
          boardsCache = null;
          throw normalizeApiError(error, '行业板块列表获取失败');
        }),
    };
  }
  return boardsCache.promise;
}

/** 截面因子评估：显式 codes 或行业板块（board+topN）自动拉宽截面 */
export async function runCrossSectionEvaluation(
  payload: {
    codes?: string[];
    board?: string;
    /** 指数历史成分宇宙（Baostock sidecar；含其后退市证券） */
    indexUniverse?: { index: 'hs300' | 'zz500' | 'sz50'; date?: string };
    topN?: number;
    horizons?: number[];
    includeFundamental?: boolean;
    /** 事件族（分红/回购/解禁 + PEAD），默认 true */
    includeEvents?: boolean;
    /** 两融因子族（融资余额变化率/拥挤度，PIT + T+1 披露），默认 true */
    includeMargin?: boolean;
    /** 可选：为全部因子附带组合回测（top-N 等权周期调仓，宇宙等权基准） */
    portfolio?: { holdDays?: number; topN?: number; costBps?: number };
  },
  signal?: AbortSignal,
): Promise<CrossSectionResult> {
  try {
    // 与批量测算同理：服务端额外回 run / preflight / ledger，此处只声明被消费的子集
    const response = await api.post<CrossSectionResult>('/quant/factor/cross-section', payload, {
      // 每只都要拉行情 + 财务 + 季度财报。基本面已走缓存、K 线为增量补尾，
      // 但数百只的全市场大面板冷启动仍可能耗时数分钟，故放宽到 10 分钟。
      timeout: 600000,
      signal,
    });
    return response.data;
  } catch (error: unknown) {
    // 用户主动取消：以专用类型上抛，调用方据此静默收尾而非当失败渲染
    if (isCancelled(error)) throw new AnalysisCancelledError('截面评估已取消');
    throw normalizeApiError(error, '截面因子评估失败');
  }
}

// === 因子研究：自定义表达式 / 实验台账 / 上游预检 ===

/** 因子实验台账条目（因子 × 持有期） */
export interface FactorExperiment {
  id: string;
  createdAt: string;
  source: 'cross-section' | 'expression' | 'hypothesis';
  name: string;
  expression?: string;
  universe: { board?: string; codes?: string[]; requested: number; included: number };
  horizon: number;
  sampleSize: number;
  icMean: number;
  pValue: number;
  oosStable: boolean;
  kept: boolean;
  notes?: string;
}

export interface FactorExperimentSummary {
  total: number;
  kept: number;
  bySource: Record<string, number>;
  lastAt: string | null;
  /** 期望假阳性上界 = 采信数 × 5%（最坏情形：采信集全部为真原假设） */
  keptExpectedFalse?: number;
  /** 采信集中 OOS 稳定的占比（0-1） */
  keptOosShare?: number;
}

/** 查询实验台账 */
export async function getFactorExperiments(params?: {
  source?: string;
  kept?: boolean;
  limit?: number;
}): Promise<{ items: FactorExperiment[]; summary: FactorExperimentSummary }> {
  try {
    const response = await api.get<{ items: FactorExperiment[]; summary: FactorExperimentSummary }>(
      '/quant/factor/experiments',
      {
        params: params ?? {},
        timeout: 15000,
      },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '实验台账读取失败');
  }
}

/** 评估一条受限 DSL 因子表达式（不执行任意代码，越界由服务端拒绝） */
/** 因子组合回测结果（top-N 等权、周期调仓、A 股成本） */
export interface FactorPortfolioBacktest {
  equityCurve: { date: string; value: number }[];
  benchmarkCurve: { date: string; value: number }[];
  rebalances: {
    date: string;
    endDate: string;
    holdings: string[];
    turnover: number;
    grossReturn: number;
    costDrag: number;
    benchmarkReturn: number;
  }[];
  totalReturn: number;
  annualizedReturn: number;
  sharpe: number;
  maxDrawdown: number;
  winRate: number;
  avgTurnover: number;
  periods: number;
}

/** 单条受限 DSL 表达式的评估结果（从原内联返回类型提取，便于在泛型处引用） */
export interface FactorExpressionResult {
  stocksIncluded: string[];
  stocksSkipped: { code: string; reason: string }[];
  factor: {
    name: string;
    report: {
      sampleSize: number;
      byPeriod: {
        period: number;
        ic: { mean: number; pValue: number; n: number };
        oos: { stable: boolean };
        verdict: { effective: boolean; reasons: string[] };
      }[];
    };
  };
  portfolio?: FactorPortfolioBacktest | null;
  ledger: { recorded: number; total: number };
}

export async function runFactorExpression(
  payload: {
    expression: string;
    board?: string;
    codes?: string[];
    topN?: number;
    horizons?: number[];
    name?: string;
    source?: 'expression' | 'hypothesis';
    portfolio?: { holdDays?: number; topN?: number; costBps?: number };
  },
  signal?: AbortSignal,
): Promise<FactorExpressionResult> {
  try {
    // 服务端另回 run / preflight 等复现字段，此处只声明被消费的子集
    const response = await api.post<FactorExpressionResult>('/quant/factor/expression', payload, {
      // 数百只大面板冷启动可能数分钟，与截面评估同量级
      timeout: 600000,
      signal,
    });
    return response.data;
  } catch (error: unknown) {
    // 用户主动取消：与截面评估同语义上抛专用类型，调用方据此静默收尾而非当失败渲染
    if (isCancelled(error)) throw new AnalysisCancelledError('因子评估已取消');
    throw normalizeApiError(error, '因子表达式评估失败');
  }
}

/** 上游预检结果（从原内联返回类型提取，便于在泛型处引用） */
export interface QuantHealthResult {
  ok: boolean;
  checks: { key: string; ok: boolean; detail: string }[];
  degraded: string[];
  checkedAt: string;
}

/** 上游预检：行情源 / LLM / 本地缓存 */
export async function getQuantHealth(): Promise<QuantHealthResult> {
  try {
    // 服务端在 preflight 之外还并入 tushare / baostock 两个通道块，
    // 前端只读 preflight 本体，故泛型只声明这一层（多余字段运行时仍在）
    const response = await api.get<QuantHealthResult>('/quant/health', { timeout: 20000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '上游预检失败');
  }
}

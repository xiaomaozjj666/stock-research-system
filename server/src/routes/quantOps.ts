import { Router } from 'express';

import { isAShareCode } from '../utils/stockCode.js';
import {
  quantLimiter,
  watchlistLimiter,
  circuitBreakerGuard,
  respondIfQueueTimeout,
} from '../middleware.js';
import { parseStrategyInput } from '../quant/agents/orchestrator.js';
import type { StrategyConfig } from '../quant/types.js';
import { extractNewsSignal, earliestNewsDate } from '../quant/newsSignal.js';
import { evaluateFactor, type FactorObservation } from '../quant/factorEvaluation.js';
import { type StockPanelInput } from '../quant/crossSectionBuilder.js';
import { runPreflight } from '../quant/preflight.js';
import { isTushareConfigured, fetchStockBasicCached } from '../quant/tushareAdapter.js';
import { baostockHealth } from '../quant/baostockBridge.js';
import { runMarketScreener, readLatestScreenerRun, ScreenerParamError } from '../quant/screener.js';
import { buildResearchMemory } from '../llm/researchMemory.js';
import {
  recordFactorExperiments,
  listFactorExperiments,
  summarizeFactorExperiments,
  type FactorExperimentInput,
  type FactorExperimentSource,
} from '../quant/factorLedger.js';
import {
  parseFactorExpression,
  buildExpressionContext,
  evaluateFactorSeries,
  type ExprNode,
} from '../quant/factorExpression.js';
import {
  runPortfolioBacktest,
  type PortfolioBacktestOptions,
  type PortfolioBacktestResult,
} from '../quant/portfolioBacktest.js';
import { analyzeTimeseries } from '../quant/timeseries/analyze.js';
import { listResearchDigests, runResearchDigest } from '../quant/researchDigest.js';
import { fetchAnnouncementList, fetchAnnouncementContent } from '../quant/announcementProvider.js';
import { runValuationModel } from '../quant/valuationModel.js';
import { getData } from '../services/dataService.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import { runBacktest } from '../quant/backtestEngine.js';
import { withAbortableTimeout } from '../utils/timeout.js';
import { abortOnClientClose } from '../utils/clientAbort.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';
import {
  datesOrReject,
  fetchPanelInputs,
  horizonsOrReject,
  judgeWithActivePolicy,
  ledgerEntriesFromReport,
  parsePortfolioOpts,
  rejectIfAnySimulated,
  rejectIfSimulated,
  resolveUniverse,
  runSnapshot,
} from '../services/quant/panelService.js';

/**
 * 量化运营端点（初筛 / 时序 / 记忆 / 简报 / 公告 / 估值 / 健康 / 台账 / 受控评估）
 *
 * 本文件由原 routes/quant.ts 按领域机械拆分而来（2026-09-28）：
 * 路由路径、限流与熔断参数逐字未变，对外 HTTP 契约零变化。
 */

const router = Router();

/** 组合回测执行（表达式评估通过后调用）：inputs 的 bars 就是逐股收盘价来源 */
function runPortfolioOnInputs(
  obs: FactorObservation[],
  inputs: StockPanelInput[],
  opts: PortfolioBacktestOptions | null,
): PortfolioBacktestResult | undefined {
  if (!opts) return undefined;
  const barsBySymbol = new Map(inputs.map((i) => [i.code, i.bars ?? []]));
  const result = runPortfolioBacktest(obs, barsBySymbol, opts);
  return result ?? undefined;
}

/** 表达式截面观测装配（single / batch 表达式路由共用）：逐股求值 + t→t+h 远期收益 */
function assembleExpressionObservations(
  ast: ExprNode,
  inputs: StockPanelInput[],
  horizons: number[],
): { obs: FactorObservation[]; included: string[]; skipped: { code: string; reason: string }[] } {
  const obs: FactorObservation[] = [];
  const included: string[] = [];
  const skipped: { code: string; reason: string }[] = [];
  for (const input of inputs) {
    const { code, bars, financial, quarterly } = input;
    if (!bars || bars.length < Math.max(...horizons) + 5) {
      skipped.push({ code, reason: `K线不足（${bars?.length ?? 0} 根）` });
      continue;
    }
    const values = evaluateFactorSeries(ast, buildExpressionContext(bars, financial, quarterly));
    let used = 0;
    for (let i = 0; i < bars.length; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) continue;
      const returns: Record<number, number> = {};
      let complete = true;
      for (const h of horizons) {
        if (i + h >= bars.length) {
          complete = false;
          break;
        }
        const base = bars[i].close;
        const ahead = bars[i + h].close;
        if (!(base > 0) || !(ahead > 0)) {
          complete = false;
          break;
        }
        returns[h] = ahead / base - 1;
      }
      if (!complete || Object.keys(returns).length === 0) continue;
      obs.push({ date: bars[i].date, symbol: code, value, returns });
      used += 1;
    }
    if (used > 0) included.push(code);
    else skipped.push({ code, reason: '表达式有效取值不足（窗口过界/除零导致全 NaN）' });
  }
  return { obs, included, skipped };
}

/**
 * Tushare 增强通道状态块（健康检查用）。只走 fetchStockBasicCached 的 24h 缓存
 * （免费积分 stock_basic 实测 1 次/小时）；失败降级为 degraded + 原始报错，
 * 绝不让增强通道的状态影响 preflight.ok。
 */
async function tushareHealthBlock(): Promise<Record<string, unknown>> {
  if (!isTushareConfigured()) return { configured: false };
  try {
    const rows = await fetchStockBasicCached();
    const count = (s: string) => rows.filter((r) => r.listStatus === s).length;
    return {
      configured: true,
      total: rows.length,
      listed: count('L'),
      delisted: count('D'),
      suspended: count('P'),
    };
  } catch (error) {
    // 失败原因只在服务端留档：生产环境 detail 不回传（见 utils/errorDetail.ts），
    // 若这里不 warn，生产环境就只剩 degraded: true 而无从定位
    logger.warn('[quant-health] tushare 通道不可用，如实降级披露', { err: error });
    return { configured: true, degraded: true, detail: errorDetail(error) };
  }
}

// === 全市场初筛（借鉴 Sequoia-X「收盘后扫全市场」）===
// 形态触发 + RPS 分位初筛全市场（可设上限），结果落盘；
// 命中标的天然适合接入截面二次验证（IC/分层/OOS）与研究队列。
router.post('/api/quant/screener/run', quantLimiter, circuitBreakerGuard, async (req, res) => {
  // 全市场扫描是长任务：客户端提前断开 → 级联中止在途取数，不写死响应
  const abort = abortOnClientClose(res);
  try {
    const body = (req.body ?? {}) as {
      maxStocks?: unknown;
      startDate?: unknown;
      endDate?: unknown;
    };
    const result = await runMarketScreener({
      ...(body.maxStocks !== undefined && body.maxStocks !== null
        ? { maxStocks: Number(body.maxStocks) }
        : {}),
      ...(typeof body.startDate === 'string' ? { startDate: body.startDate } : {}),
      ...(typeof body.endDate === 'string' ? { endDate: body.endDate } : {}),
      signal: abort.signal,
    });
    // 客户端已不在：socket 已关，不写响应；结果落盘由 screener 内部的 aborted 守卫跳过
    if (abort.signal.aborted) return;
    res.json(result);
  } catch (error) {
    if (abort.signal.aborted) return;
    // 区间/上限入参非法属调用方问题 → 400 + 中文说明，不是 500
    if (error instanceof ScreenerParamError) {
      return res.status(400).json({ error: error.message });
    }
    // 闸门排队超时 → 429 + Retry-After（此前落到 500，客户端无法据此退避重试）
    if (respondIfQueueTimeout(res, error, '/api/quant/screener/run')) return;
    logger.error('Market screener error', { route: '/api/quant/screener/run', err: error });
    res.status(500).json({ error: '全市场初筛失败' });
  }
});

/** 最近一次初筛结果（无人值守运行后回看） */
router.get('/api/quant/screener/latest', quantLimiter, (_req, res) => {
  const result = readLatestScreenerRun();
  if (!result) return res.status(404).json({ error: '还没有初筛记录：先 POST /run 跑一次' });
  res.json(result);
});

// ============================================================
// 时间序列计量分析：ADF 单位根 / GARCH 族波动率 / Engle-Granger 协整 /
// ARIMA / Kalman 时变对冲比率。统一入口，按 test 分派。
// ============================================================

router.post(
  '/api/quant/timeseries/analyze',
  quantLimiter,
  circuitBreakerGuard,
  async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await analyzeTimeseries({
        test: typeof body.test === 'string' ? body.test : '',
        code: typeof body.code === 'string' ? body.code : '',
        ...(typeof body.code2 === 'string' ? { code2: body.code2 } : {}),
        ...(typeof body.startDate === 'string' ? { startDate: body.startDate } : {}),
        ...(typeof body.endDate === 'string' ? { endDate: body.endDate } : {}),
        ...(body.options && typeof body.options === 'object'
          ? { options: body.options as Record<string, unknown> }
          : {}),
      });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 闸门排队超时 → 429 + Retry-After（此前落到 500，客户端无法据此退避重试）。
      // 放在下面两条中文正则**之前**：排队超时也是「可重试」语义，若将来错误文案
      // 演变到含「需/不足/失败」等字样，会被 400/502 分支先一步吃掉，退化成参数错误。
      if (respondIfQueueTimeout(res, error, '/api/quant/timeseries/analyze')) return;
      // 取数不足属上游/窗口问题（502），其余中文校验信息为参数问题（400）
      if (/(数据不足|观测不足|对齐后仅)/.test(msg)) {
        return res.status(502).json({ error: msg });
      }
      if (/(需|不足|至少|一致|失败|必填)/.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      logger.error('Timeseries analyze error', {
        route: '/api/quant/timeseries/analyze',
        err: error,
      });
      return res.status(500).json({ error: '时间序列分析失败' });
    }
  },
);

/** 研究记忆：同股票的历史结论 + 已验证因子，作为本次研究的先验 */
router.get('/api/quant/research-memory/:code', quantLimiter, (req, res) => {
  try {
    const code = String(req.params.code ?? '').trim();
    if (!isAShareCode(code)) {
      return res.status(400).json({ error: '请提供 6 位股票代码' });
    }
    res.json(buildResearchMemory(code));
  } catch (error) {
    logger.error('Research memory error', {
      route: '/api/quant/research-memory',
      err: error,
    });
    res.status(500).json({ error: '研究记忆读取失败' });
  }
});

/** 研究简报列表（定时任务与手动触发共用同一落盘，读的是同一份历史） */
router.get('/api/quant/digests', quantLimiter, (req, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
    res.json({ items: listResearchDigests(limit) });
  } catch (error) {
    logger.error('Digest list error', { route: '/api/quant/digests', err: error });
    res.status(500).json({ error: '研究简报读取失败' });
  }
});

/** 手动触发一份研究简报（定时任务由 QUANT_DIGEST_INTERVAL_HOURS 控制，默认关闭） */
router.post('/api/quant/digests/run', quantLimiter, (req, res) => {
  try {
    res.json(runResearchDigest());
  } catch (error) {
    // 闸门排队超时 → 429 + Retry-After（此前落到 500，客户端无法据此退避重试）
    if (respondIfQueueTimeout(res, error, '/api/quant/digests/run')) return;
    logger.error('Digest run error', { route: '/api/quant/digests/run', err: error });
    res.status(500).json({ error: '研究简报生成失败' });
  }
});

/** 公告列表（默认最近 10 条）；带 artCode 参数时返回该篇全文 */
router.get('/api/quant/announcements', quantLimiter, async (req, res) => {
  try {
    const code = String(req.query.code ?? '').trim();
    const artCode = String(req.query.artCode ?? '').trim();
    if (artCode) {
      const content = await fetchAnnouncementContent(artCode);
      return res.json({ artCode, content });
    }
    if (!isAShareCode(code)) {
      return res.status(400).json({ error: '公告查询需 6 位 A 股代码' });
    }
    const limitRaw = Number(req.query.pageSize);
    const pageSize = Number.isFinite(limitRaw) ? limitRaw : 10;
    res.json(await fetchAnnouncementList(code, pageSize));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/(需|必填)/.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    logger.error('Announcements error', { route: '/api/quant/announcements', err: error });
    res.status(502).json({ error: '公告获取失败（上游不可达时如实重试）' });
  }
});

/**
 * 估值建模：两阶段 EPS 贴现 + 可比公司表。假设可整体缺省（自动推导：基期 EPS 取
 * 最新年报，显性期增速取 EPS 3 年 CAGR 钳制 [-20%,30%]，r=9%、g2=3%、5 年显性期）。
 * 模型口径与局限随结果 limitations 返回，前端照实展示。
 */
router.post('/api/quant/valuation/model', quantLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!isAShareCode(code)) {
      return res.status(400).json({ error: '请提供 6 位股票代码' });
    }
    const { financial, valuation } = await getData(code);
    const opts = (body.assumptions ?? {}) as Record<string, unknown>;
    const num = (k: string): number | undefined =>
      typeof opts[k] === 'number' && Number.isFinite(opts[k]) ? (opts[k] as number) : undefined;
    const result = runValuationModel(code, financial, valuation, {
      ...(num('growthRate1') !== undefined ? { growthRate1: num('growthRate1') } : {}),
      ...(num('growthRate2') !== undefined ? { growthRate2: num('growthRate2') } : {}),
      ...(num('discountRate') !== undefined ? { discountRate: num('discountRate') } : {}),
      ...(num('explicitYears') !== undefined ? { explicitYears: num('explicitYears') } : {}),
      ...(num('baseEps') !== undefined ? { baseEps: num('baseEps') } : {}),
    });
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/(需|必填|严格小于|正数|整数)/.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    logger.error('Valuation model error', { route: '/api/quant/valuation/model', err: error });
    res.status(502).json({ error: '估值建模失败（数据获取或计算异常）' });
  }
});

// 上游预检：动手前先判「行情源通不通 / LLM 配没配 / 缓存有没有」，
// 避免用户干等超时后只拿到一句没有行动指引的 502
router.get('/api/quant/health', quantLimiter, async (_req, res) => {
  try {
    const preflight = await runPreflight();
    // 增强通道状态（可选）：Tushare（退市股名单/主表）与 Baostock（指数历史成分，
    // Python sidecar）。都只走长缓存包装——频控/子进程开销绝不进请求热路径。
    // 未配置 / 失败都如实降级披露，不影响 preflight.ok
    const [tushare, baostock] = await Promise.all([tushareHealthBlock(), baostockHealth()]);
    res.json({ ...preflight, tushare, baostock });
  } catch (error) {
    logger.error('Quant health error', { route: '/api/quant/health', err: error });
    res.status(500).json({ error: '上游预检失败' });
  }
});

// 因子实验台账：列出/汇总（source、kept、limit 过滤）
router.get('/api/quant/factor/experiments', quantLimiter, (req, res) => {
  try {
    const q = req.query ?? {};
    const source = typeof q.source === 'string' ? q.source : undefined;
    const kept = q.kept === undefined ? undefined : q.kept === 'true';
    const limit = Number(q.limit ?? 100);
    const items = listFactorExperiments({
      ...(source ? { source: source as FactorExperimentSource } : {}),
      ...(kept === undefined ? {} : { kept }),
      limit,
    });
    res.json({ items, summary: summarizeFactorExperiments() });
  } catch (error) {
    logger.error('Factor experiments list error', {
      route: '/api/quant/factor/experiments',
      err: error,
    });
    res.status(500).json({ error: '实验台账读取失败' });
  }
});

// 手动补录实验（外部脚本/离线评估的结论也能进台账）
router.post('/api/quant/factor/experiments', quantLimiter, (req, res) => {
  try {
    const body = req.body ?? {};
    const raw = (body as { entries?: unknown }).entries;
    const entries = Array.isArray(raw) ? (raw as FactorExperimentInput[]) : null;
    if (!entries || entries.length === 0 || entries.length > 200) {
      return res.status(400).json({ error: '请提供 entries 数组（1-200 条）' });
    }
    res.json({ recorded: recordFactorExperiments(entries).length });
  } catch (error) {
    logger.error('Factor experiments record error', {
      route: '/api/quant/factor/experiments',
      err: error,
    });
    res.status(500).json({ error: '实验台账写入失败' });
  }
});

// 自定义因子表达式评估：LLM 提假设 → 受限 DSL 求值 → 既有截面评估器验证 → 台账留痕。
// 关键点：**不执行模型生成的代码**（无沙箱逃逸面），只解析白名单语法的表达式。
router.post('/api/quant/factor/expression', quantLimiter, circuitBreakerGuard, async (req, res) => {
  let abort: AbortController | null = null;
  try {
    const body = (req.body ?? {}) as {
      expression?: unknown;
      name?: unknown;
      board?: unknown;
      codes?: unknown;
      topN?: unknown;
      horizons?: unknown;
      /** hypothesis = LLM 生成的假设；expression = 手输表达式 */
      source?: unknown;
      /** 可选：因子组合回测（top-N 等权、周期调仓、A 股成本）——从 IC 到 PnL 的最后一问 */
      portfolio?: unknown;
      /** 取数区间（#2）：未传时沿用 730 天默认窗口；传了必须为真实日历日且跨度受限 */
      startDate?: unknown;
      endDate?: unknown;
    };
    const expression = String(body.expression ?? '').trim();
    if (!expression) return res.status(400).json({ error: '请提供因子表达式 expression' });
    let ast;
    try {
      ast = parseFactorExpression(expression);
    } catch (error) {
      // 刻意不走 errorDetail：这是**用户自己**的表达式解析报错（400 校验提示，
      // 不含上游 URL / 文件路径），生产环境也必须原样回传，否则前端无法提示改哪里
      return res.status(400).json({
        error: '因子表达式非法',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    // horizons 统一解析（五处共用）：此前只有「单元素值域」校验且无个数上限
    const parsedHorizons = horizonsOrReject(body.horizons, res);
    if (!parsedHorizons.ok) return;
    const horizons = parsedHorizons.horizons;
    const portfolioOpts = parsePortfolioOpts(body.portfolio);
    // 区间校验（#2）：这两条路由此前**完全忽略** startDate/endDate、固定 730 天窗口，
    // 传了非法/超长区间既不生效也不报错。现在入参被真正采用，且非法即 400 且零取数；
    // 未传时默认窗口（730 天 → 今天）与旧行为逐日一致。
    const parsedDates = datesOrReject(body.startDate, body.endDate, res);
    if (!parsedDates.ok) return;

    // 预检 + universe 解析（三路由共用助手；board 门槛 = 板块列表源）
    const preflight = await runPreflight();
    const resolved = await resolveUniverse(body, preflight);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.payload);
    const codes = resolved.codes;
    const universe = resolved.universe;

    const { start, end } = parsedDates;
    abort = abortOnClientClose(res);
    const { inputs, simulatedCodes } = await fetchPanelInputs(codes, {
      start,
      end,
      signal: abort.signal,
      // 表达式标量：PIT 优先（季度公告日门控），无季度数据回落年报快照常数
      withFinancial: true,
      withQuarterly: true,
    });
    if (abort.signal.aborted) return;
    // 模拟数据闸门：表达式评估同样基于逐日取值 + 远期收益，合成曲线不得流入
    if (rejectIfAnySimulated(simulatedCodes, res)) return;

    // 装配观测：表达式逐日取值 + t→t+h 远期收益（single/batch 共用助手）
    const { obs, included, skipped } = assembleExpressionObservations(ast, inputs, horizons);
    if (obs.length < 30) {
      return res.status(422).json({
        error: `有效观测仅 ${obs.length} 个（需 ≥30），无法评估`,
        stocksSkipped: skipped,
      });
    }

    const report = evaluateFactor(obs);
    const factor = {
      name: String(body.name ?? 'custom_expression'),
      type: 'expression',
      report: {
        ...report,
        byPeriod: report.byPeriod.map((p) => ({ ...p, verdict: judgeWithActivePolicy(p) })),
      },
    };
    const source: FactorExperimentSource =
      body.source === 'hypothesis' ? 'hypothesis' : 'expression';
    const recorded = recordFactorExperiments(
      ledgerEntriesFromReport([factor], {
        source,
        name: factor.name,
        expression,
        universe: {
          requested: typeof universe.requested === 'number' ? universe.requested : codes.length,
          included: included.length,
          ...(typeof universe.board === 'string' ? { board: universe.board } : { codes }),
        },
      }),
    );
    res.json({
      universe,
      stocksIncluded: included,
      stocksSkipped: skipped,
      horizons,
      factor,
      portfolio: runPortfolioOnInputs(obs, inputs, portfolioOpts),
      run: runSnapshot({ kind: 'factor-expression', expression, start, end, horizons }),
      preflight,
      ledger: { recorded: recorded.length, total: summarizeFactorExperiments().total },
    });
  } catch (error) {
    if (abort?.signal.aborted) return;
    // 闸门排队超时 → 429 + Retry-After（此前落到 500，客户端无法据此退避重试）
    if (respondIfQueueTimeout(res, error, '/api/quant/factor/expression')) return;
    logger.error('Factor expression error', {
      route: '/api/quant/factor/expression',
      err: error,
    });
    res.status(500).json({ error: '自定义因子评估失败' });
  }
});

// 批量因子假设验证（RD-Agent(Q) 式研究流水线的规模化出口）：
// 一次请求验证一组受限 DSL 表达式假设——universe 解析与取数只做一次（面板共享），
// 逐表达式求值 → 截面评估 → 台账留痕。单条非法/样本不足只标记该项，不拖垮整批。
// 这是「LLM 提假设 → 自动验证 → 复利台账」从单发走向批量的关键一步。
router.post(
  '/api/quant/factor/expression/batch',
  quantLimiter,
  circuitBreakerGuard,
  async (req, res) => {
    let abort: AbortController | null = null;
    try {
      const body = (req.body ?? {}) as {
        expressions?: unknown;
        name?: unknown;
        board?: unknown;
        codes?: unknown;
        topN?: unknown;
        horizons?: unknown;
        /** hypothesis = LLM 生成的假设；expression = 手输表达式 */
        source?: unknown;
        /** 可选：逐条做因子组合回测（共享同一取数面板） */
        portfolio?: unknown;
        /** 取数区间（#2）：未传时沿用 730 天默认窗口；传了必须为真实日历日且跨度受限 */
        startDate?: unknown;
        endDate?: unknown;
      };
      const raw = Array.isArray(body.expressions) ? body.expressions : [];
      const expressions = raw
        .map((e: unknown) => String(e ?? '').trim())
        .filter((e: string) => e !== '');
      if (expressions.length === 0) {
        return res.status(400).json({ error: '请提供 expressions 数组（1-50 条表达式）' });
      }
      if (expressions.length > 50) {
        return res.status(413).json({ error: `expressions 过多（${expressions.length} > 50）` });
      }
      // horizons 统一解析（五处共用）：此前只有「单元素值域」校验且无个数上限
      const parsedHorizons = horizonsOrReject(body.horizons, res);
      if (!parsedHorizons.ok) return;
      const horizons = parsedHorizons.horizons;
      const portfolioOpts = parsePortfolioOpts(body.portfolio);

      // 全部表达式先解析（纯 CPU，毫秒级）：非法项提前标记，不进入取数
      const parsed = expressions.map((src) => {
        try {
          return { expression: src, ast: parseFactorExpression(src), error: null as string | null };
        } catch (error) {
          return {
            expression: src,
            ast: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
      const validCount = parsed.filter((p) => p.ast !== null).length;
      if (validCount === 0) {
        return res.status(400).json({
          error: '全部表达式非法',
          details: parsed.map((p) => ({ expression: p.expression, error: p.error })),
        });
      }
      // 区间校验（#2，同 single）：此前完全忽略 startDate/endDate、固定 730 天窗口
      const parsedDates = datesOrReject(body.startDate, body.endDate, res);
      if (!parsedDates.ok) return;

      // 预检 + universe 解析（与 single/cross-section 共用助手）
      const preflight = await runPreflight();
      const resolved = await resolveUniverse(body, preflight);
      if (!resolved.ok) return res.status(resolved.status).json(resolved.payload);
      const codes = resolved.codes;
      const universe = resolved.universe;

      const { start, end } = parsedDates;
      abort = abortOnClientClose(res);
      const { inputs, simulatedCodes } = await fetchPanelInputs(codes, {
        start,
        end,
        signal: abort.signal,
        withFinancial: true,
        withQuarterly: true,
      });
      if (abort.signal.aborted) return;
      // 模拟数据闸门：批量假设验证的面板共享，任一只合成即整批拒绝
      if (rejectIfAnySimulated(simulatedCodes, res)) return;

      // 逐表达式评估：面板（inputs）只取一次，这里是纯 CPU 循环
      const source: FactorExperimentSource =
        body.source === 'hypothesis' ? 'hypothesis' : 'expression';
      const results: Record<string, unknown>[] = [];
      for (const item of parsed) {
        if (item.ast === null) {
          results.push({ expression: item.expression, ok: false, error: item.error });
          continue;
        }
        const { obs, included, skipped } = assembleExpressionObservations(
          item.ast as ExprNode,
          inputs,
          horizons,
        );
        if (obs.length < 30) {
          results.push({
            expression: item.expression,
            ok: false,
            error: `有效观测仅 ${obs.length} 个（需 ≥30），无法评估`,
            stocksSkipped: skipped,
          });
          continue;
        }
        const report = evaluateFactor(obs);
        const factor = {
          name: String(body.name ?? 'custom_expression'),
          type: 'expression',
          report: {
            ...report,
            byPeriod: report.byPeriod.map((p) => ({ ...p, verdict: judgeWithActivePolicy(p) })),
          },
        };
        const recorded = recordFactorExperiments(
          ledgerEntriesFromReport([factor], {
            source,
            name: factor.name,
            expression: item.expression,
            universe: {
              requested: typeof universe.requested === 'number' ? universe.requested : codes.length,
              included: included.length,
              ...(typeof universe.board === 'string' ? { board: universe.board } : { codes }),
            },
          }),
        );
        results.push({
          expression: item.expression,
          ok: true,
          stocksIncluded: included,
          stocksSkipped: skipped,
          horizons,
          factor,
          portfolio: runPortfolioOnInputs(obs, inputs, portfolioOpts),
          ledger: { recorded: recorded.length },
        });
      }

      const okCount = results.filter((r) => r.ok === true).length;
      res.json({
        universe,
        horizons,
        requested: expressions.length,
        evaluated: okCount,
        results,
        run: runSnapshot({ kind: 'factor-expression-batch', start, end, horizons }),
        preflight,
        ledger: { total: summarizeFactorExperiments().total },
      });
    } catch (error) {
      if (abort?.signal.aborted) return;
      // 闸门排队超时 → 429 + Retry-After（此前落到 500，客户端无法据此退避重试）
      if (respondIfQueueTimeout(res, error, '/api/quant/factor/expression/batch')) return;
      logger.error('Factor expression batch error', {
        route: '/api/quant/factor/expression/batch',
        err: error,
      });
      res.status(500).json({ error: '批量因子假设验证失败' });
    }
  },
);

// 受控回测评估：基线(无新闻叠加) vs 实验(带新闻情绪叠加)，量化 LLM 信号是否真增 alpha
router.post('/api/backtest/evaluate', watchlistLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const body = req.body ?? {};
    const stockCode = String(body.stockCode ?? '').trim();
    if (!isAShareCode(stockCode)) {
      return res.status(400).json({ error: '请提供有效的6位股票代码' });
    }
    const strategyName = String(body.strategy ?? 'ma_cross').trim();
    const startDate = String(
      body.startDate ??
        new Date(Date.now() - 365 * 2 * 24 * 3600 * 1000).toISOString().split('T')[0],
    );
    const endDate = String(body.endDate ?? new Date().toISOString().split('T')[0]);

    const parsed = parseStrategyInput(strategyName) as unknown as StrategyConfig;
    const baseCfg: StrategyConfig = { ...parsed, stockCode, startDate, endDate };
    const ohlcv = await fetchOHLCVData(stockCode, startDate, endDate);
    if (!ohlcv || ohlcv.length === 0) {
      return res.status(500).json({ error: `无法获取 ${stockCode} 的 K 线数据` });
    }
    // 模拟数据闸门：否则 totalReturn / sharpe 会基于合成曲线算出并 200 返回
    if (rejectIfSimulated(ohlcv, res)) return;

    // 基线：无新闻叠加
    const baseline = runBacktest(ohlcv, baseCfg);
    // 实验组：叠加新闻情绪信号
    let expCfg: StrategyConfig = { ...baseCfg };
    try {
      // 与 /api/quant/analyze 一致：限时 5s，防止新闻抓取（逐端点 8s + LLM 评分 30s）挂住限流窗口；
      // 超时经 withAbortableTimeout 真正取消在途抓取，而不是让它在后台跑满
      const ns = await withAbortableTimeout(
        (signal) => extractNewsSignal(stockCode, { signal }),
        5000,
      );
      if (ns.signal.hasNews) {
        expCfg = {
          ...expCfg,
          newsOverlay: {
            polarity: ns.signal.polarity,
            since: earliestNewsDate(ns.signal.items),
            items: ns.signal.timeline,
          },
        };
      }
    } catch {
      // 新闻抓取失败/超时：实验组退化为基线，评估器会判 inconclusive/tie
    }
    const experiment = runBacktest(ohlcv, expCfg);

    const { compareBacktests } = await import('../quant/backtestEvaluator.js');
    const comparison = compareBacktests(baseline, experiment);
    res.json({
      baseline,
      experiment,
      comparison,
      newsSource: expCfg.newsOverlay ? 'live' : 'none',
    });
  } catch (error) {
    // 闸门排队超时 → 429 + Retry-After（此前落到 500，客户端无法据此退避重试）
    if (respondIfQueueTimeout(res, error, '/api/backtest/evaluate')) return;
    logger.error('Backtest evaluate error', {
      route: '/api/backtest/evaluate',
      stockCode: (req.body as { stockCode?: unknown } | undefined)?.stockCode,
      err: error,
    });
    res.status(500).json({ error: '受控回测评估失败', detail: errorDetail(error) });
  }
});

export default router;

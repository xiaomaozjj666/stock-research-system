import { Router, type Request } from 'express';

import { quantLimiter, metaLimiter, circuitBreakerGuard } from '../middleware.js';
import { normalizeAShareCode } from '../utils/stockCode.js';
import { parseStrategyInput, orchestrate, generateSummary } from '../quant/agents/orchestrator.js';
import type { StrategyConfig, FactorOverlay } from '../quant/types.js';
import {
  extractNewsSignal,
  aggregateNewsSentiment,
  earliestNewsDate,
  type NewsItem,
  type NewsSignal,
} from '../quant/newsSignal.js';
import { computePriceVolumeFactors, type PriceVolumeFactor } from '../quant/priceVolumeFactors.js';
import {
  evaluatePriceVolumeFactorPredictability,
  IC_DECAY_HORIZONS,
  type FactorPredictability,
} from '../quant/factorPredictability.js';
import {
  computeCompositeAlpha,
  factorOverlayFromCompositeAlpha,
  type CompositeAlpha,
} from '../quant/compositeAlpha.js';
import {
  computeCompositeAlphaForStrategy,
  computeCompositeAlphaBatch,
} from '../quant/compositeService.js';
import { evaluateFactor, type FactorObservation } from '../quant/factorEvaluation.js';
import {
  fetchIndustryBoardsWithMeta,
  type WithStaleness,
  type IndustryBoard,
} from '../quant/universeProvider.js';
import { runPreflight } from '../quant/preflight.js';
import {
  fetchOHLCVData,
  fetchBenchmarkReturns,
  marketOf,
  benchmarkSecidForMarket,
} from '../quant/dataProvider.js';
import { runBacktest } from '../quant/backtestEngine.js';
import { withAbortableTimeout } from '../utils/timeout.js';
import { auditToolCall } from '../services/auditLog.js';
import { getReqTraceContext } from '../services/telemetry.js';
import { abortOnClientClose } from '../utils/clientAbort.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';
import {
  datesOrReject,
  horizonsOrReject,
  judgeWithActivePolicy,
  rejectIfAnySimulated,
  rejectIfSimulated,
  runSnapshot,
} from '../services/quant/panelService.js';

/**
 * 量化研究核心端点（分析 / 因子评估 / 复合因子 / 板块宇宙）
 *
 * 本文件由原 routes/quant.ts 按领域机械拆分而来（2026-09-28）：
 * 路由路径、限流与熔断参数逐字未变，对外 HTTP 契约零变化。
 */

const router = Router();

/**
 * 批量路径的模拟数据命中代码（**跑完后**判定，不再预先探测）。
 *
 * 历史：compositeService 的批量结果原先不携带 isSimulated 标记，只能靠
 * findSimulatedCodes() 在批量之前按同一取数口径把每只再拉一遍——冷缓存时整批
 * 多一轮上游拉取（成本翻倍），热缓存时也白跑一遍。现在逐股结果透出 isSimulated，
 * 这里直接从结果里取命中代码：取数次数减半，闸门语义（422 + degraded + 代码列表）
 * 与判定口径（合成曲线不得流入 IC/t/p）完全不变。
 *
 * 失败项（ok:false）不计入：它压根没产出任何指标，与预检版「取数抛错不改变语义」一致。
 */
function simulatedCodesFromBatch(result: {
  items?: { stockCode?: unknown; ok?: unknown; result?: { isSimulated?: unknown } }[];
}): string[] {
  if (!Array.isArray(result?.items)) return [];
  const hits: string[] = [];
  for (const item of result.items) {
    if (item?.ok !== true) continue;
    if (item.result?.isSimulated !== true) continue;
    if (typeof item.stockCode === 'string') hits.push(item.stockCode);
  }
  return hits;
}

// === Quant Research Endpoint ===
router.post('/api/quant/analyze', quantLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const { strategy, useNews, newsItems, useFactor } = req.body as {
      strategy: StrategyConfig | string;
      useNews?: boolean;
      newsItems?: NewsItem[];
      /** 是否把量价因子组合 alpha 作为信号叠加层自动注入回测；默认 true，false 关闭 */
      useFactor?: boolean;
    };
    if (!strategy) {
      return res.status(400).json({ error: '请提供策略配置（strategy）' });
    }

    // 1. 解析策略配置
    const strategyConfig = parseStrategyInput(strategy);

    // 确保日期范围有默认值
    if (!strategyConfig.startDate) {
      strategyConfig.startDate = new Date(Date.now() - 365 * 2 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];
    }
    if (!strategyConfig.endDate) {
      strategyConfig.endDate = new Date().toISOString().split('T')[0];
    }

    // 2. 获取K线数据
    const ohlcvData = await fetchOHLCVData(
      strategyConfig.stockCode,
      strategyConfig.startDate,
      strategyConfig.endDate,
    );
    if (!ohlcvData || ohlcvData.length === 0) {
      return res.status(422).json({ error: `无法获取股票 ${strategyConfig.stockCode} 的K线数据` });
    }

    // 2.5 解析最新消息情绪（用户粘贴 newsItems 优先；否则 useNews 时实时抓取；均失败则中性）
    let newsSignal: NewsSignal | null = null;
    try {
      if (newsItems && newsItems.length > 0) {
        newsSignal = aggregateNewsSentiment(newsItems);
      } else if (useNews) {
        // 限时 5s，且超时真正取消新闻抓取：逐端点 8s + LLM 打分 30s，
        // 只 race 不取消的话这趟请求会继续跑满，占着限流窗口与上游配额。
        const fetched = await withAbortableTimeout(
          (signal) => extractNewsSignal(strategyConfig.stockCode, { signal }),
          5000,
        );
        newsSignal = fetched.signal;
      }
    } catch {
      newsSignal = null;
    }

    // 3.5 量价因子：A 股方向已按本土实证校正（短期反转而非动量），随报告透出。
    //     数据不足的因子 value 序列化为 null（available=false），调用方据此剔除，
    //     而不是当成 0 参与加权——那等价于给「无法计算」的标的安一个居中值。
    //     同时计算每只因子对「这只股票自身」远期收益的时间序列预测力（IC / t / p /
    //     是否显著）：截面 IC 需多股票横截面，单股场景下时间序列 IC 才是可证伪口径。
    // 3.6 市场基准收益：Beta / 特异波动率 / 残差动量需要「市场收益」才能计算；个股自身
    //     买入持有曲线不是市场代理（会令 Beta 恒为 1）。按市场选宽基基准（A 股沪深300 /
    //     美股标普500 / 港股恒生），指数拉取失败（网络/跨市场）时降级为无市场收益，Beta
    //     类因子仍按 NaN 处理，不拖垮报告。
    let marketReturns: number[] | undefined;
    try {
      marketReturns =
        (await fetchBenchmarkReturns(
          ohlcvData.map((b) => b.date),
          strategyConfig.startDate,
          strategyConfig.endDate,
          benchmarkSecidForMarket(marketOf(strategyConfig.stockCode)),
        )) ?? undefined;
    } catch (e) {
      logger.warn('市场基准收益获取失败，Beta 类因子降级为无预测力', { err: e });
    }
    const priceVolumeFactorsSnapshot = computePriceVolumeFactors({
      bars: ohlcvData,
      marketReturns,
    });
    let factorPredictability: FactorPredictability[] = [];
    try {
      // IC 衰减网格 [1,5,10,21,63]：21/63 供组合 alpha 结算，1/5/10 供前端绘制
      // 「信号随持有期衰减」曲线（自然调仓频率诊断）。计算成本同量级（逐持有期
      // Spearman），样本不足的持有期由评估器返回 null，前端如实显示。
      factorPredictability = evaluatePriceVolumeFactorPredictability(
        {
          bars: ohlcvData,
          marketReturns,
        },
        [...IC_DECAY_HORIZONS],
      );
    } catch (e) {
      // 预测力计算失败不应拖垮整份报告；降级为「无预测力数据」
      logger.warn('因子时间序列预测力计算跳过', { err: e });
    }
    const predictabilityByName = new Map(factorPredictability.map((p) => [p.name, p]));
    const priceVolumeFactors: (PriceVolumeFactor & {
      available: boolean;
      predictability?: FactorPredictability;
    })[] = priceVolumeFactorsSnapshot.map((f) => ({
      ...f,
      value: f.value,
      available: Number.isFinite(f.value),
      predictability: predictabilityByName.get(f.name),
    }));

    // 3.7 多因子加权组合 alpha：把上述单因子时间序列预测力（仅显著因子、按 |t| 置信度
    //     加权方向校正 IC）合成一个方向性信号。计算失败降级为空（不拖垮报告）。
    let compositeAlpha: CompositeAlpha | undefined;
    if (factorPredictability.length > 0) {
      try {
        // 组合 alpha 语义不变：只在 21/63 结算（衰减网格仅服务展示与诊断）
        compositeAlpha = computeCompositeAlpha(factorPredictability, [21, 63]);
      } catch (e) {
        logger.warn('组合 alpha 计算跳过', { err: e });
      }
    }

    // 3. 运行回测：baseline（不含叠加层）+ 含信号叠加层（news-aware / factor-aware）。
    //     因子叠加层自动注入条件：组合 alpha 确有显著信号、综合方向非 neutral、且用户未
    //     显式关闭（useFactor!==false）；用户显式传入 strategy.factorOverlay 时优先采用其配置。
    const backtestBaseline = runBacktest(ohlcvData, strategyConfig);
    let backtestResult = backtestBaseline;
    // 记录实际应用的叠加层：limitations 文案需区分严格时序（items）与旧口径（聚合常数）
    let newsOverlayUsed: {
      polarity: number;
      since?: string;
      items?: { publishedAt: string; polarity: number }[];
    } | null = null;
    let factorOverlayUsed: FactorOverlay | null = null;
    if (newsSignal?.hasNews) {
      newsOverlayUsed = {
        polarity: newsSignal.polarity,
        since: earliestNewsDate(newsSignal.items),
        items: newsSignal.timeline,
      };
    }
    if (
      !strategyConfig.factorOverlay &&
      useFactor !== false &&
      compositeAlpha?.hasSignal &&
      compositeAlpha.overallDirection !== 'neutral'
    ) {
      factorOverlayUsed = factorOverlayFromCompositeAlpha(compositeAlpha);
    }
    if (newsOverlayUsed || factorOverlayUsed || strategyConfig.factorOverlay) {
      backtestResult = runBacktest(ohlcvData, {
        ...strategyConfig,
        // since=新闻最早发布日；items=分段情绪时间线（引擎按各 bar 已知新闻严格时序叠加）
        ...(newsOverlayUsed ? { newsOverlay: newsOverlayUsed } : {}),
        // 因子叠加层：组合 alpha 翻成建仓姿态；与新闻姿态取 min（AND 语义），不叠加放大
        ...(factorOverlayUsed || strategyConfig.factorOverlay
          ? { factorOverlay: (factorOverlayUsed ?? strategyConfig.factorOverlay) as FactorOverlay }
          : {}),
      });
    }

    // （因子与组合 alpha 已在上方 step 3.5–3.7 提前计算，供回测叠加层使用）

    // 4. 编排子Agent：数据质量、审计、优化
    const { dataQuality, audit, optimization } = await orchestrate(
      strategyConfig,
      ohlcvData,
      backtestResult,
    );

    // 5. 生成摘要
    const summary = generateSummary(
      strategyConfig,
      dataQuality,
      backtestResult,
      audit,
      optimization,
    );

    // 6. 置信度与局限性
    const confidence =
      dataQuality.overallScore >= 80 && audit.riskScore >= 70
        ? '高'
        : dataQuality.overallScore >= 60 && audit.riskScore >= 50
          ? '中'
          : '低';

    const limitations: string[] = [];
    if (ohlcvData.some((d) => d.isSimulated)) {
      limitations.push('当前使用模拟数据，回测结果仅供参考');
    }
    if (backtestResult.tradeCount < 5) {
      limitations.push('交易次数过少，统计意义有限');
    }
    if (audit.overfittingRisk === 'high') {
      limitations.push('存在过拟合风险，策略可能在未来表现不佳');
    }
    if (backtestResult.newsAware) {
      limitations.push(
        newsOverlayUsed?.items?.length
          ? '新闻情绪按发布时间分段加权（各时点仅使用已知新闻，时效半衰期 5.8 天），严格时序无前视偏差'
          : `新闻情绪为聚合常数叠加${backtestResult.newsSince ? `（自 ${backtestResult.newsSince} 起）` : ''}，属情景假设`,
      );
    }
    if (backtestResult.factorAware) {
      limitations.push(
        `组合 alpha 信号叠加已生效（综合方向 ${backtestResult.factorDirection}，姿态 ${((backtestResult.factorPosture ?? 0) * 100).toFixed(0)}%），与新闻姿态取较小值缩放仓位，long-only 下看空不建仓`,
      );
    }
    limitations.push('历史回测不代表未来收益');

    // 7. 返回完整报告
    const report = {
      strategy: strategyConfig,
      dataQuality,
      backtest: backtestResult,
      backtestBaseline: newsSignal?.hasNews ? backtestBaseline : undefined,
      newsSentiment: newsSignal?.hasNews ? newsSignal : undefined,
      priceVolumeFactors,
      compositeAlpha,
      audit,
      optimization,
      summary,
      confidence,
      limitations: limitations.join('；'),
    };

    // 审计留痕并带上链路 ID：量化分析会产出可交易的策略结论，属审计范围内的高价值操作；
    // traceId 取 telemetry 注入的 res.locals（index.ts 的 expressTracerMiddleware），
    // 退化取请求 ID 中间件挂在 req 上的 reqId；都取不到就透传 undefined（不写脏字段）。
    const traceId = getReqTraceContext(res)?.traceId ?? (req as Request & { reqId?: string }).reqId;
    auditToolCall(
      'quant',
      'quant.analyze',
      {
        stockCode: strategyConfig.stockCode,
        startDate: strategyConfig.startDate,
        endDate: strategyConfig.endDate,
        useNews: Boolean(useNews),
      },
      { confidence, tradeCount: backtestResult.tradeCount },
      'low',
      traceId,
    );

    res.json(report);
  } catch (error) {
    logger.error('Quant analysis error', { route: '/api/quant/analyze', err: error });
    // detail 只在非生产环境回传（路由内 catch 不经过 index.ts 通用错误中间件）
    res.status(500).json({ error: '量化分析失败', detail: errorDetail(error) });
  }
});

// 单因子评估 tear sheet：IC 显著性 + 分层回测 + 换手率 + alpha/beta。
// 输入为截面面板（多标的 × 多交易日），方法学对齐 alphalens / qlib。
router.post('/api/quant/factor/evaluate', quantLimiter, circuitBreakerGuard, (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      observations?: unknown;
      options?: Record<string, unknown>;
    };
    const raw = body.observations;
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ error: '请提供因子观测数组（observations）' });
    }
    // 上限保护：纯 CPU 计算，防超大面板拖垮事件循环（限流器之外的第二道闸）
    if (raw.length > 200_000) {
      return res.status(413).json({ error: `observations 过多（${raw.length} > 200000）` });
    }

    const observations: FactorObservation[] = [];
    for (let i = 0; i < raw.length; i++) {
      const o = raw[i] as Record<string, unknown>;
      const date = typeof o.date === 'string' ? o.date.trim() : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: `observations[${i}].date 需为 YYYY-MM-DD` });
      }
      const returnsRaw = (o.returns ?? {}) as Record<string, unknown>;
      const returns: Record<number, number> = {};
      for (const [k, v] of Object.entries(returnsRaw)) {
        // JSON 无法表达 NaN：null/undefined 视为「该持有期缺失」并剔除该键，
        // 绝不能经 Number(null)=0 洗成真实收益
        if (v === null || v === undefined) continue;
        const period = Number(k);
        const r = Number(v);
        if (Number.isFinite(period) && Number.isFinite(r)) returns[period] = r;
      }
      if (Object.keys(returns).length === 0) {
        return res.status(400).json({ error: `observations[${i}].returns 至少需要一个持有期` });
      }
      observations.push({
        date,
        symbol: typeof o.symbol === 'string' && o.symbol.trim() ? o.symbol.trim() : undefined,
        // 同上：null（JSON 化的 NaN）必须落成 NaN 走「缺失剔除」路径，而非 0
        value: o.value === undefined || o.value === null ? Number.NaN : Number(o.value),
        returns,
        marketCap:
          o.marketCap === undefined || o.marketCap === null ? undefined : Number(o.marketCap),
        group: typeof o.group === 'string' && o.group.trim() ? o.group.trim() : undefined,
        weight: o.weight === undefined || o.weight === null ? undefined : Number(o.weight),
      });
    }

    const opt = body.options ?? {};
    const num = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const report = evaluateFactor(observations, {
      quantiles: num(opt.quantiles),
      maxLoss: num(opt.maxLoss),
      neutralize: opt.neutralize === true,
      winsorize: opt.winsorize === true,
      periods: Array.isArray(opt.periods)
        ? opt.periods.map(num).filter((v): v is number => v !== undefined)
        : undefined,
      lag: num(opt.lag),
      demeaned: opt.demeaned === true,
      groupAdjust: opt.groupAdjust === true,
    });

    // 逐持有期附上「是否采信」判定：IC 显著 + 分层单调 + 多空价差为正
    const byPeriod = report.byPeriod.map((p) => ({ ...p, verdict: judgeWithActivePolicy(p) }));
    res.json({ ...report, byPeriod });
  } catch (error) {
    // maxLoss 超限属数据问题（调用方可放宽阈值重试），返回 422 而非 500
    logger.warn('Factor evaluate error', { route: '/api/quant/factor/evaluate', err: error });
    res.status(422).json({ error: '因子评估失败', detail: errorDetail(error) });
  }
});

// 多因子加权组合 alpha（单只股票，时间序列 IC 口径）：只算因子预测力与方向性组合信号，
// 不跑回测/数据质量/审计/优化，适合批量测算单标的的方向性 alpha。
router.post('/api/quant/factor/composite', quantLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const body = req.body ?? {};
    const stockCode = String(body.stockCode ?? '').trim();
    if (!stockCode) {
      return res.status(400).json({ error: '请提供股票代码 stockCode' });
    }
    // 出站 URL 前校验形态：stockCode 最终会经 resolveSecid 拼进上游查询串，
    // 此前只判非空，`1&lmt=99999` 这类入参可改写上游参数
    const normalizedCode = normalizeAShareCode(stockCode);
    if (!normalizedCode) {
      return res.status(400).json({ error: '股票代码格式无效（应为 6 位数字）' });
    }
    // 区间校验（#2）：非法日期 / 倒置 / 超长跨度 → 400 + 中文原因，且一次 K 线都不取。
    // 未传时沿用既有默认区间（约 2 年 → 今天），正常路径行为不变。
    const parsedDates = datesOrReject(body.startDate, body.endDate, res);
    if (!parsedDates.ok) return;
    const { start: startDate, end: endDate } = parsedDates;
    // horizons 统一解析：非法（非整数 / <1 / >504 / 档位过多）→ 400，不静默回落默认值
    const parsedHorizons = horizonsOrReject(body.horizons, res);
    if (!parsedHorizons.ok) return;
    const horizons = parsedHorizons.horizons;

    // 模拟数据闸门：行情源不可达时 dataProvider 会返回确定性合成 K 线，
    // 组合 alpha（IC/t/p + compositeAlpha）绝不能基于合成曲线产出 200
    if (rejectIfSimulated(await fetchOHLCVData(normalizedCode, startDate, endDate), res)) return;

    const result = await computeCompositeAlphaForStrategy(
      normalizedCode,
      startDate,
      endDate,
      horizons,
    );
    res.json(result);
  } catch (error) {
    logger.error('Composite alpha error', { route: '/api/quant/factor/composite', err: error });
    // 「无法获取 K 线」属数据问题 → 422；其余（意外异常）→ 500
    const status = error instanceof Error && /无法获取/.test(error.message) ? 422 : 500;
    res.status(status).json({ error: '组合 alpha 计算失败', detail: errorDetail(error) });
  }
});

// 批量组合 alpha：一次请求测算多只股票的方向性组合信号，供前端批量测算页使用。
// 单只失败只标记该项 ok:false（如无 K 线/网络异常），不拖垮整批；结果按输入顺序返回。
router.post(
  '/api/quant/factor/composite/batch',
  quantLimiter,
  circuitBreakerGuard,
  async (req, res) => {
    try {
      const body = req.body ?? {};
      const raw = (body as { stockCodes?: unknown }).stockCodes;
      if (!Array.isArray(raw) || raw.length === 0) {
        return res.status(400).json({ error: '请提供股票代码数组 stockCodes' });
      }
      // 上限保护：每只都要拉 K 线 + 基准，防止超大批量拖垮事件循环/上游
      if (raw.length > 20) {
        return res.status(413).json({ error: `stockCodes 过多（${raw.length} > 20）` });
      }
      const codes = raw.map((c: unknown) => String(c ?? '').trim()).filter(Boolean);
      if (codes.length === 0) {
        return res.status(400).json({ error: 'stockCodes 至少需要一个非空股票代码' });
      }
      // 逐个校验形态后再入库（这些代码会经 resolveSecid 拼进上游查询串）
      const invalid = codes.filter((c: string) => normalizeAShareCode(c) === null);
      if (invalid.length > 0) {
        return res.status(400).json({
          error: `股票代码格式无效（应为 6 位数字）：${invalid.slice(0, 5).join('、')}`,
        });
      }
      // 区间校验（#2，同 /composite）：非法日期/倒置/超长跨度 → 400，且整批一次都不取数
      const parsedDates = datesOrReject(body.startDate, body.endDate, res);
      if (!parsedDates.ok) return;
      const { start: startDate, end: endDate } = parsedDates;
      // horizons 统一解析（同 /composite）：非法即 400，不再「先 floor 再用」——
      // h=0.5 曾静默变 0 → Math.ceil(m/0)=Infinity → tStat=NaN → 响应字段成 null
      const parsedHorizons = horizonsOrReject(body.horizons, res);
      if (!parsedHorizons.ok) return;
      const horizons = parsedHorizons.horizons;

      // 预检：源不可达且无缓存兜底 → 立刻 503，不逐个股票等超时
      const preflight = await runPreflight();
      const upstreamOk = preflight.checks.find((c) => c.key === 'upstream')?.ok ?? false;
      const cacheOk = preflight.checks.find((c) => c.key === 'cache')?.ok ?? false;
      if (!upstreamOk && !cacheOk) {
        return res.status(503).json({
          error: '行情源不可用且本地缓存为空，无法批量测算',
          detail: preflight.checks.find((c) => c.key === 'upstream')?.detail,
          preflight,
        });
      }
      // 客户端提前断开（取消/关页）→ 级联中止在途取数
      const abort = abortOnClientClose(res);
      const result = await computeCompositeAlphaBatch(
        codes,
        startDate,
        endDate,
        horizons,
        undefined,
        abort.signal,
      );
      if (abort.signal.aborted) return; // 客户端已不在：静默终止，不写响应
      // 模拟数据闸门（批量）：改用**跑完后**的逐股结果判定（compositeService 现已透出
      // isSimulated），不再先按同一取数口径预检一遍——冷缓存时那等于整批多一轮上游拉取。
      // 响应语义与预检版完全一致：422 + degraded + 命中代码，且不返回任何指标。
      const simulatedCodes = simulatedCodesFromBatch(result);
      if (rejectIfAnySimulated(simulatedCodes, res)) return;
      res.json({
        ...result,
        run: runSnapshot({
          kind: 'composite-batch',
          startDate,
          endDate,
          horizons,
          requested: codes.length,
        }),
        preflight,
      });
    } catch (error) {
      logger.error('Batch composite alpha error', {
        route: '/api/quant/factor/composite/batch',
        err: error,
      });
      res.status(500).json({ error: '批量组合 alpha 计算失败', detail: errorDetail(error) });
    }
  },
);

// 行业板块列表（东方财富 clist，m:90+t:2）：供前端下拉选择截面 universe。
// 板块与成分股为低频数据（provider 内有 TTL 缓存），失败转 502 不编造列表。
// 限流用 metaLimiter（30/min）而非 quantLimiter（5/min）：该请求由页面挂载触发、
// 多个面板共享，属廉价只读元数据，与分钟级重计算共用配额会让正常浏览就吃 429。
router.get('/api/quant/universe/boards', metaLimiter, async (req, res) => {
  try {
    const meta: WithStaleness<IndustryBoard[]> = await fetchIndustryBoardsWithMeta();
    // 东财新旧两套行业体系并存（银行 / 银行Ⅱ / 国有大型银行Ⅲ）：名称后缀 Ⅱ/Ⅲ
    // 是旧体系子级，下拉只保留现行一级板块（约 60 个）。纯降噪：板块代码本身
    // 仍全部合法、可直接请求，只是不再在下拉里铺开旧体系层级。
    const boards = meta.value.filter((b) => !/[ⅡⅢ]$/.test(b.name));
    res.json({
      boards,
      // 上游失败但磁盘有历史快照时，如实披露「本次返回的是陈旧快照」
      ...(meta.stale ? { stale: true, staleAgeMs: meta.staleAgeMs } : {}),
    });
  } catch (error) {
    logger.error('Universe boards error', { route: '/api/quant/universe/boards', err: error });
    res.status(502).json({ error: '行业板块列表获取失败', detail: errorDetail(error) });
  }
});

export default router;

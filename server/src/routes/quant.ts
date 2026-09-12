/**
 * 量化研究：回测 + 数据质量 + 审计 + 优化 + 摘要；受控回测评估（基线 vs 新闻叠加）；
 * 量价因子（A 股方向校正）与单因子评估 tear sheet。
 */
import { Router, type Response } from 'express';
import { quantLimiter, watchlistLimiter, circuitBreakerGuard } from '../middleware.js';
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
import { evaluateFactor, judgeFactor, type FactorObservation } from '../quant/factorEvaluation.js';
import {
  buildCrossSectionPanel,
  type FundamentalFactorName,
  type StockPanelInput,
} from '../quant/crossSectionBuilder.js';
import {
  fetchIndustryBoardsWithMeta,
  fetchBoardConstituentsWithMeta,
  hasCachedConstituents,
  type WithStaleness,
  type IndustryBoard,
  isValidBoardCode,
} from '../quant/universeProvider.js';
// 基本面数据走量化侧缓存（财报按季度更新，无需每次运行重拉）：
// 把每只股票 3 次网络调用降到 1 次（仅剩 K 线的尾部增量补拉）。
// 底层仍调用 services 的 fetchFinancialData / fetchQuarterlyFinancials，
// 故既有的模块级 mock（按 services 路径）依旧生效。
import {
  fetchFinancialDataCached,
  fetchQuarterlyFinancialsCached,
} from '../quant/fundamentalCache.js';
import { runPreflight, type PreflightResult } from '../quant/preflight.js';
import { isTushareConfigured, fetchStockBasicCached } from '../quant/tushareAdapter.js';
import {
  fetchIndexConstituentsCached,
  baostockHealth,
  BAOSTOCK_INDEXES,
  type BaostockIndex,
} from '../quant/baostockBridge.js';
import { runMarketScreener, readLatestScreenerRun } from '../quant/screener.js';
import { runEnsemble, recordModelOutcome, getModelWeights } from '../llm/ensemble.js';
import { routeSkill } from '../llm/skillRouter.js';
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
import { buildEarningsSurpriseObservations } from '../quant/fundamentalDepth.js';
import {
  runPortfolioBacktest,
  type PortfolioBacktestOptions,
  type PortfolioBacktestResult,
} from '../quant/portfolioBacktest.js';
import { fetchStockEvents } from '../quant/eventProvider.js';
import { fetchMarginSeries, type MarginFactorName } from '../quant/marginProvider.js';
import {
  buildEventObservations,
  buybackSignalEvents,
  dividendSignalEvents,
  dragonTigerSignalEvents,
  unlockSignalEvents,
  UNLOCK_START_OFFSET_DAYS,
  UNLOCK_WINDOW_DAYS,
} from '../quant/eventPanels.js';
import { detectPatternEvents, PATTERN_NAMES } from '../quant/patternEvents.js';
import { analyzeTimeseries } from '../quant/timeseries/analyze.js';
import { listResearchDigests, runResearchDigest } from '../quant/researchDigest.js';
import { fetchAnnouncementList, fetchAnnouncementContent } from '../quant/announcementProvider.js';
import { runValuationModel } from '../quant/valuationModel.js';
import { getData } from '../services/dataService.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import {
  fetchOHLCVData,
  fetchBenchmarkReturns,
  marketOf,
  benchmarkSecidForMarket,
} from '../quant/dataProvider.js';
import { runBacktest } from '../quant/backtestEngine.js';
import { withTimeout } from '../utils/timeout.js';
import logger from '../utils/logger.js';

const router = Router();

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
        const fetched = await withTimeout(extractNewsSignal(strategyConfig.stockCode), 5000);
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

    res.json(report);
  } catch (error) {
    logger.error('Quant analysis error', { route: '/api/quant/analyze', err: error });
    const message = error instanceof Error ? error.message : '量化分析过程出错';
    res.status(500).json({ error: '量化分析失败', detail: message });
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
    const byPeriod = report.byPeriod.map((p) => ({ ...p, verdict: judgeFactor(p) }));
    res.json({ ...report, byPeriod });
  } catch (error) {
    // maxLoss 超限属数据问题（调用方可放宽阈值重试），返回 422 而非 500
    logger.warn('Factor evaluate error', { route: '/api/quant/factor/evaluate', err: error });
    const message = error instanceof Error ? error.message : '因子评估失败';
    res.status(422).json({ error: '因子评估失败', detail: message });
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
    const startDate = String(
      body.startDate ??
        new Date(Date.now() - 365 * 2 * 24 * 3600 * 1000).toISOString().split('T')[0],
    );
    const endDate = String(body.endDate ?? new Date().toISOString().split('T')[0]);
    const horizons = Array.isArray(body.horizons)
      ? body.horizons
          .map((h: unknown) => Number(h))
          .filter((h: number) => Number.isFinite(h) && h > 0)
      : [21, 63];

    const result = await computeCompositeAlphaForStrategy(stockCode, startDate, endDate, horizons);
    res.json(result);
  } catch (error) {
    logger.error('Composite alpha error', { route: '/api/quant/factor/composite', err: error });
    const message = error instanceof Error ? error.message : '组合 alpha 计算失败';
    // 「无法获取 K 线」属数据问题 → 422；其余（意外异常）→ 500
    const status = error instanceof Error && /无法获取/.test(error.message) ? 422 : 500;
    res.status(status).json({ error: '组合 alpha 计算失败', detail: message });
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
      const startDate = String(
        body.startDate ??
          new Date(Date.now() - 365 * 2 * 24 * 3600 * 1000).toISOString().split('T')[0],
      );
      const endDate = String(body.endDate ?? new Date().toISOString().split('T')[0]);
      const horizons = Array.isArray(body.horizons)
        ? body.horizons
            .map((h: unknown) => Number(h))
            .filter((h: number) => Number.isFinite(h) && h > 0)
        : [21, 63];

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
      const message = error instanceof Error ? error.message : '批量组合 alpha 计算失败';
      res.status(500).json({ error: '批量组合 alpha 计算失败', detail: message });
    }
  },
);

// 行业板块列表（东方财富 clist，m:90+t:2）：供前端下拉选择截面 universe。
// 板块与成分股为低频数据（provider 内有 TTL 缓存），失败转 502 不编造列表。
router.get('/api/quant/universe/boards', quantLimiter, circuitBreakerGuard, async (req, res) => {
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
    const message = error instanceof Error ? error.message : '行业板块列表获取失败';
    res.status(502).json({ error: '行业板块列表获取失败', detail: message });
  }
});

/**
 * 客户端提前断开时中止在途取数。
 * 监听 res close（连接断开）且响应尚未写完 → abort。返回的 signal 由调用方
 * 传入 mapWithConcurrency / 各取数函数，取消沿调用链级联到 socket 级。
 */
function abortOnClientClose(res: Response): AbortController {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}

/**
 * 量化运行快照（可复现留痕）：把「这次是用什么参数 / 数据区间 / 运行时跑出来的」
 * 随结果返回并留档——研究报告事后要能复盘，光有结论没有参数是没法复现的。
 */
function runSnapshot(fields: Record<string, unknown>): Record<string, unknown> {
  return { at: new Date().toISOString(), node: process.version, ...fields };
}

/** 评估结果的因子形态（台账只关心这几个字段，避免与评估器类型硬耦合） */
interface LedgerFactorInput {
  name: string;
  report: {
    sampleSize?: number;
    byPeriod?: {
      period: number;
      ic?: { mean?: number; pValue?: number };
      oos?: { stable?: boolean };
      verdict?: { effective?: boolean };
    }[];
  };
}

/** 把评估结果摊平成台账条目：因子 × 持有期各一条 */
function ledgerEntriesFromReport(
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
      });
    }
  }
  return out;
}

// === 截面 universe 宽度与并发上限（2026-09-05 放开） ===
// 截面框架的统计功效随横截面宽度增长：板块内 30 只原本够用，但要上全市场多行业
// 大面板（几百只）必须放宽。宽度与并发都走 env，便于按部署的算力与上游限流配额调整；
// 另设硬上限兜底，防止误配极大值把服务拖死。
// 注意：放宽上限只是「允许」，默认 topN 仍为 10，行为只在显式请求更宽时改变。
const CROSS_SECTION_MAX_CODES_HARD_CAP = 2000;
const CROSS_SECTION_CONCURRENCY_HARD_CAP = 16;

function crossSectionMaxCodes(): number {
  const raw = Number(process.env.QUANT_CROSS_SECTION_MAX_CODES);
  if (!Number.isFinite(raw) || raw <= 0) return 300;
  return Math.min(Math.floor(raw), CROSS_SECTION_MAX_CODES_HARD_CAP);
}

function crossSectionConcurrency(): number {
  const raw = Number(process.env.QUANT_CROSS_SECTION_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) return 8;
  return Math.min(Math.max(Math.floor(raw), 1), CROSS_SECTION_CONCURRENCY_HARD_CAP);
}

/** universe 解析的统一返回：ok=false 时 status/payload 由调用方直接回写 */
type UniverseResolution =
  | { ok: true; codes: string[]; universe: Record<string, unknown> }
  | { ok: false; status: number; payload: Record<string, unknown> };

/**
 * universe 解析（cross-section / expression / batch 三路由共用）：
 * indexUniverse（指数历史成分，Baostock sidecar）→ board（板块成分股，截面
 * 拉宽主路径）→ 显式 codes；board 路径的门槛是板块列表源（push2 clist，
 * 与 K 线源不同域名）。
 */
async function resolveUniverse(
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
          detail: (error as Error).message,
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
      const message = error instanceof Error ? error.message : '成分股获取失败';
      return {
        ok: false,
        status: 502,
        payload: {
          error: `板块 ${board} 成分股获取失败`,
          detail: message,
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
async function fetchPanelInputs(
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
): Promise<StockPanelInput[]> {
  return mapWithConcurrency(
    codes,
    crossSectionConcurrency(),
    async (code: string) => {
      const bars = await fetchOHLCVData(code, opts.start, opts.end, opts.signal).catch(() => []);
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
}

/** 组合回测参数解析：范围外的值回落默认（一行内错误笔误的容错口径） */
function parsePortfolioOpts(raw: unknown): PortfolioBacktestOptions | null {
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

// 截面因子评估：自动拉取行情/财务/季度财报装配截面观测面板，走既有截面评估器
// （按日跨股票 Spearman + Newey-West + OOS 稳定性）。
// universe 两种来源：
//   - codes：显式给出 2 到上限只股票（上限见 crossSectionMaxCodes，默认 300）；
//   - board：给行业板块代码（BKxxxx），按总市值取前 topN 只成分股——截面拉宽的
//     主路径，让逐日截面 IC 有足够样本量。
// 因子三族：量价（逐日变异）、基本面（年报快照 + 季度派生，每股常数）、
// 事件（PEAD 业绩超预期 + 分红股息率 + 回购力度 + 解禁压力，事件窗口内有效；
// includeEvents=false 可整体关闭事件族）。
// 统计功效取决于横截面宽度：stocksSkipped 与各因子 sampleSize 如实披露，不做掩饰。
router.post(
  '/api/quant/factor/cross-section',
  quantLimiter,
  circuitBreakerGuard,
  async (req, res) => {
    let abort: AbortController | null = null;
    try {
      const body = (req.body ?? {}) as {
        codes?: unknown;
        board?: unknown;
        /** 可选：指数历史成分宇宙（Baostock sidecar；{index, date?}） */
        indexUniverse?: unknown;
        topN?: unknown;
        horizons?: unknown;
        includeFundamental?: unknown;
        includeEvents?: unknown;
        /** 可选：两融因子族（融资余额变化率/拥挤度，PIT + T+1 披露延迟） */
        includeMargin?: unknown;
        /** 可选：为全部因子附带组合回测（top-N 等权周期调仓，宇宙等权基准） */
        portfolio?: unknown;
      };
      const horizons =
        Array.isArray(body.horizons) &&
        body.horizons.every(
          (h: unknown) => Number.isInteger(h) && (h as number) >= 1 && (h as number) <= 250,
        )
          ? (body.horizons as number[])
          : [21, 63];
      const includeFundamental = body.includeFundamental !== false;
      // 事件族开关（分红/回购/解禁 + PEAD）：默认开启；关闭可跳过事件源的网络调用
      const includeEvents = body.includeEvents !== false;
      // 两融族开关：默认开启；关闭可跳过两融源的网络调用（与事件同模式）
      const includeMargin = body.includeMargin !== false;
      const portfolioOpts = parsePortfolioOpts(body.portfolio);

      // 预检（在 universe 解析前）：源不可达 + 无任何本地缓存 → 直接 503；
      // 源不可达但有缓存 → 继续走陈旧兜底（板块级精准拦截在 resolveUniverse 内）
      const preflight = await runPreflight();
      const upstreamOk = preflight.checks.find((c) => c.key === 'upstream')?.ok ?? false;
      const cacheOk = preflight.checks.find((c) => c.key === 'cache')?.ok ?? false;
      if (!upstreamOk && !cacheOk) {
        return res.status(503).json({
          error: '行情源不可用且本地缓存为空，无法装配截面',
          detail: preflight.checks.find((c) => c.key === 'upstream')?.detail,
          preflight,
        });
      }

      // universe 解析：指数历史成分 / 板块成分股（拉宽）优先于显式 codes（三路由共用助手）
      const resolved = await resolveUniverse(body, preflight);
      if (!resolved.ok) return res.status(resolved.status).json(resolved.payload);
      const codes = resolved.codes;
      // 幸存者偏差如实声明，按宇宙来源区分口径：
      //  - index 源：成分是历史快照，**本身含其后退市证券**（Baostock 的价值所在），
      //    但行情主表可能已无这些退市股的 K 线——缺 K 线者会被面板如实跳过；
      //  - board/codes 源：主表是当前上市证券，退市股不在场。Tushare 配置时附
      //    退市股名单规模（走 24h 缓存，不碰上游频控；名单仅作核对披露）。
      let survivorshipNote: string;
      if (resolved.universe.source === 'index') {
        survivorshipNote = `成分为指数历史快照（${String(
          resolved.universe.updateDate ?? '最新',
        )}），含其后退市证券；缺 K 线的退市股会被面板如实跳过`;
      } else {
        survivorshipNote = '主表为当前上市证券，历史截面不含已退市股票（幸存者偏差）';
        if (isTushareConfigured()) {
          try {
            const delisted = (await fetchStockBasicCached()).filter(
              (r) => r.listStatus === 'D',
            ).length;
            survivorshipNote += `；已接入 Tushare 退市股名单（${delisted} 只，仅供核对）`;
          } catch {
            /* 名单不可用时保持基础声明 */
          }
        }
      }
      const universe: Record<string, unknown> = {
        ...resolved.universe,
        survivorshipNote,
      };

      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      // 客户端提前断开（取消/关页）→ 级联中止在途取数
      abort = abortOnClientClose(res);
      const { signal } = abort;
      const inputs: StockPanelInput[] = await fetchPanelInputs(codes, {
        start,
        end,
        signal,
        withQuarterly: includeFundamental,
        withEvents: includeEvents,
        withMargin: includeMargin,
      });
      // 客户端已不在：跳过整段 CPU 评估，静默终止（socket 已关闭，无需写响应）
      if (abort.signal.aborted) return;

      const panel = buildCrossSectionPanel(inputs, horizons);
      // 逐持有期附「是否采信」判定（IC 显著 + 分层单调 + 多空价差为正），与
      // /factor/evaluate 路由同口径——前端截面表直接消费
      const evaluateWithVerdict = (obs: FactorObservation[]) => {
        const report = evaluateFactor(obs);
        return {
          ...report,
          byPeriod: report.byPeriod.map((p) => ({ ...p, verdict: judgeFactor(p) })),
        };
      };
      // 组合回测（可选）需要各因子的原始观测面板：push 时同步登记
      const factors: { name: string; type: string; report: unknown }[] = [];
      const factorObs = new Map<string, FactorObservation[]>();
      for (const [name, obs] of Object.entries(panel.priceVolume)) {
        if (obs.length < 30) continue; // 样本不足的因子如实跳过（评估器也会拒收）
        factors.push({ name, type: 'price_volume', report: evaluateWithVerdict(obs) });
        factorObs.set(name, obs);
      }
      if (includeFundamental) {
        for (const [name, obs] of Object.entries(panel.fundamental) as [
          FundamentalFactorName,
          FactorObservation[],
        ][]) {
          if (obs.length < 30) continue;
          factors.push({ name, type: 'fundamental', report: evaluateWithVerdict(obs) });
        }
      }

      // 两融族（includeMargin 门控）：PIT + T+1 披露延迟口径；无两融数据的股票
      // 不参与，样本不足的因子如实缺席。单股取数失败已在 fetchPanelInputs 内
      // 降级为空数组——缺一类只是少一个因子，不拖垮其余。
      if (includeMargin) {
        for (const [name, obs] of Object.entries(panel.margin) as [
          MarginFactorName,
          FactorObservation[],
        ][]) {
          if (obs.length < 30) continue;
          factors.push({ name, type: 'margin', report: evaluateWithVerdict(obs) });
        }
      }

      // 事件族（includeEvents 门控）：PEAD 依赖季度财报（includeFundamental 关闭时
      // 自然缺席）；分红/回购/解禁走独立事件数据源。窗口外无观测，样本不足的
      // 因子如实缺席，不强行出报告。
      if (includeEvents) {
        // 业绩超预期（PEAD）：公告窗口内信号有效
        const peadObs: FactorObservation[] = [];
        for (const input of inputs) {
          if (!input.quarterly || input.quarterly.reports.length === 0) continue;
          if (!input.bars || input.bars.length === 0) continue;
          peadObs.push(
            ...buildEarningsSurpriseObservations({
              code: input.code,
              reports: input.quarterly.reports,
              bars: input.bars,
              horizons,
            }),
          );
        }
        if (peadObs.length >= 30) {
          factors.push({
            name: 'ev_earnings_surprise',
            type: 'event',
            report: evaluateWithVerdict(peadObs),
          });
          factorObs.set('ev_earnings_surprise', peadObs);
        }

        // 分红（股息率，公告日后窗口）/ 回购（占总股本比例上限）/ 解禁（负的
        // 占流通市值比，含事件前 20 日的抢跑窗口）。单类失败已在 fetchStockEvents
        // 内降级为空列表——缺一类只是少一个因子，不拖垮其余。
        const dividendObs: FactorObservation[] = [];
        const buybackObs: FactorObservation[] = [];
        const unlockObs: FactorObservation[] = [];
        const dragonObs: FactorObservation[] = [];
        for (const input of inputs) {
          if (!input.bars || input.bars.length === 0 || !input.events) continue;
          const { code, bars, events } = input;
          if (events.dragonTiger) {
            dragonObs.push(
              ...buildEventObservations({
                code,
                events: dragonTigerSignalEvents(events.dragonTiger),
                bars,
                horizons,
              }),
            );
          }
          dividendObs.push(
            ...buildEventObservations({
              code,
              events: dividendSignalEvents(events.dividend, bars),
              bars,
              horizons,
            }),
          );
          buybackObs.push(
            ...buildEventObservations({
              code,
              events: buybackSignalEvents(events.buyback),
              bars,
              horizons,
            }),
          );
          unlockObs.push(
            ...buildEventObservations({
              code,
              events: unlockSignalEvents(events.unlock),
              bars,
              horizons,
              startOffsetDays: UNLOCK_START_OFFSET_DAYS,
              windowDays: UNLOCK_WINDOW_DAYS,
            }),
          );
        }
        const eventFactors: { name: string; obs: FactorObservation[] }[] = [
          { name: 'ev_dividend_yield', obs: dividendObs },
          { name: 'ev_buyback_ratio', obs: buybackObs },
          { name: 'ev_unlock_overhang', obs: unlockObs },
          { name: 'ev_dragon_tiger', obs: dragonObs },
        ];
        for (const { name, obs } of eventFactors) {
          if (obs.length >= 30) {
            factors.push({ name, type: 'event', report: evaluateWithVerdict(obs) });
            factorObs.set(name, obs);
          }
        }

        // 技术形态事件族（借鉴 Sequoia-X）：形态触发日=事件，零额外网络调用。
        // 民间「胜率约 50%」的说法在此变成可测量的 IC / 分层 / OOS。
        for (const pattern of PATTERN_NAMES) {
          const obs: FactorObservation[] = [];
          for (const input of inputs) {
            if (!input.bars || input.bars.length === 0) continue;
            obs.push(
              ...buildEventObservations({
                code: input.code,
                events: detectPatternEvents(pattern, input.bars),
                bars: input.bars,
                horizons,
              }),
            );
          }
          if (obs.length >= 30) {
            factors.push({ name: pattern, type: 'pattern', report: evaluateWithVerdict(obs) });
            factorObs.set(pattern, obs);
          }
        }
      }

      // 因子组合回测（可选）：每个因子「按它交易」的 PnL 视角（宇宙等权基准，
      // top-N 等权周期调仓、A 股成本）。观测面板已就位，这里是纯 CPU。
      if (portfolioOpts) {
        const barsBySymbol = new Map(inputs.map((i) => [i.code, i.bars ?? []]));
        for (const f of factors) {
          const obs = factorObs.get(f.name);
          if (!obs) continue;
          const pf = runPortfolioBacktest(obs, barsBySymbol, portfolioOpts);
          if (pf) (f as { portfolio?: unknown }).portfolio = pf;
        }
      }

      // 实验台账留痕（因子 × 持有期）：写盘失败静默，台账是研究资产不是数据源
      const ledgerInputs = ledgerEntriesFromReport(factors as LedgerFactorInput[], {
        source: 'cross-section',
        universe: {
          requested: typeof universe.requested === 'number' ? universe.requested : codes.length,
          included: panel.stocksIncluded.length,
          ...(typeof universe.board === 'string' ? { board: universe.board } : {}),
          ...(universe.source === 'codes' ? { codes } : {}),
        },
      });
      const ledgerRecorded = recordFactorExperiments(ledgerInputs).length;

      res.json({
        universe,
        stocksIncluded: panel.stocksIncluded,
        stocksSkipped: panel.stocksSkipped,
        horizons,
        factors,
        // 可复现快照：这次是用什么参数/数据区间/版本跑出来的
        run: runSnapshot({
          kind: 'cross-section',
          start,
          end,
          horizons,
          includeFundamental,
          includeEvents,
          concurrency: crossSectionConcurrency(),
          maxCodes: crossSectionMaxCodes(),
        }),
        preflight,
        ledger: { recorded: ledgerRecorded, total: summarizeFactorExperiments().total },
      });
    } catch (error) {
      // 客户端断开引发的 AbortError：socket 已关，写响应无意义，静默终止
      if (abort?.signal.aborted) return;
      logger.error('Cross-section factor error', {
        route: '/api/quant/factor/cross-section',
        err: error,
      });
      res.status(500).json({ error: '截面因子评估失败' });
    }
  },
);

// === 多模型集成投票与置信度校准 ===
// 默认 candidateModels 只取 1 个模型（等价关闭），须显式传 models 或设
// LLM_ENSEMBLE_SIZE>1 才走投票——既有单模型链路零变更。
router.post('/api/llm/ensemble', quantLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      messages?: unknown;
      models?: unknown;
      task?: unknown;
      temperature?: unknown;
      maxTokens?: unknown;
    };
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: '请提供 messages 对话数组' });
    }
    const models = Array.isArray(body.models) ? (body.models as string[]) : undefined;
    if (models && models.length > 5) {
      return res.status(400).json({ error: 'models 最多 5 个' });
    }
    const result = await runEnsemble(messages as never, {
      ...(models ? { models } : {}),
      ...(typeof body.task === 'string' ? { task: body.task as never } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(typeof body.maxTokens === 'number' ? { maxTokens: body.maxTokens } : {}),
    });
    res.json(result);
  } catch (error) {
    logger.error('LLM ensemble error', { route: '/api/llm/ensemble', err: error });
    const message = error instanceof Error ? error.message : '集成调用失败';
    res.status(502).json({ error: '多模型集成调用失败', detail: message });
  }
});

/** 模型权重（校准结果） */
router.get('/api/llm/calibration', quantLimiter, (_req, res) => {
  res.json({ weights: getModelWeights() });
});

/** 记录一次模型判断的验证结果（correct = 事后被验证正确） */
router.post('/api/llm/calibration', quantLimiter, (req, res) => {
  try {
    const body = (req.body ?? {}) as { model?: unknown; correct?: unknown };
    const model = String(body.model ?? '').trim();
    if (!model) return res.status(400).json({ error: '请提供 model' });
    recordModelOutcome(model, body.correct === true);
    res.json({ ok: true, weights: getModelWeights() });
  } catch (error) {
    logger.error('Calibration record error', { route: '/api/llm/calibration', err: error });
    res.status(500).json({ error: '校准记录失败' });
  }
});

/** 技能路由：给定一句话，判定该走哪个专用技能（规则表，确定性） */
router.get('/api/llm/skills', quantLimiter, (req, res) => {
  const message = String((req.query ?? {}).message ?? '');
  res.json(routeSkill(message));
});

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
    if (!/^\d{6}$/.test(code)) {
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
    if (!/^\d{6}$/.test(code)) {
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
    if (!/^\d{6}$/.test(code)) {
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
    return { configured: true, degraded: true, detail: (error as Error).message };
  }
}

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
    };
    const expression = String(body.expression ?? '').trim();
    if (!expression) return res.status(400).json({ error: '请提供因子表达式 expression' });
    let ast;
    try {
      ast = parseFactorExpression(expression);
    } catch (error) {
      return res.status(400).json({
        error: '因子表达式非法',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const horizons =
      Array.isArray(body.horizons) &&
      body.horizons.every(
        (h: unknown) => Number.isInteger(h) && (h as number) >= 1 && (h as number) <= 250,
      )
        ? (body.horizons as number[])
        : [21, 63];
    const portfolioOpts = parsePortfolioOpts(body.portfolio);

    // 预检 + universe 解析（三路由共用助手；board 门槛 = 板块列表源）
    const preflight = await runPreflight();
    const resolved = await resolveUniverse(body, preflight);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.payload);
    const codes = resolved.codes;
    const universe = resolved.universe;

    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    abort = abortOnClientClose(res);
    const inputs = await fetchPanelInputs(codes, {
      start,
      end,
      signal: abort.signal,
      // 表达式标量：PIT 优先（季度公告日门控），无季度数据回落年报快照常数
      withFinancial: true,
      withQuarterly: true,
    });
    if (abort.signal.aborted) return;

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
        byPeriod: report.byPeriod.map((p) => ({ ...p, verdict: judgeFactor(p) })),
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
      const horizons =
        Array.isArray(body.horizons) &&
        body.horizons.every(
          (h: unknown) => Number.isInteger(h) && (h as number) >= 1 && (h as number) <= 250,
        )
          ? (body.horizons as number[])
          : [21, 63];
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

      // 预检 + universe 解析（与 single/cross-section 共用助手）
      const preflight = await runPreflight();
      const resolved = await resolveUniverse(body, preflight);
      if (!resolved.ok) return res.status(resolved.status).json(resolved.payload);
      const codes = resolved.codes;
      const universe = resolved.universe;

      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      abort = abortOnClientClose(res);
      const inputs = await fetchPanelInputs(codes, {
        start,
        end,
        signal: abort.signal,
        withFinancial: true,
        withQuarterly: true,
      });
      if (abort.signal.aborted) return;

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
            byPeriod: report.byPeriod.map((p) => ({ ...p, verdict: judgeFactor(p) })),
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
    if (!/^\d{6}$/.test(stockCode)) {
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

    // 基线：无新闻叠加
    const baseline = runBacktest(ohlcv, baseCfg);
    // 实验组：叠加新闻情绪信号
    let expCfg: StrategyConfig = { ...baseCfg };
    try {
      // 与 /api/quant/analyze 一致：限时 5s，防止新闻抓取（逐端点 8s + LLM 评分 30s）挂住限流窗口
      const ns = await withTimeout(extractNewsSignal(stockCode), 5000);
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
    logger.error('Backtest evaluate error', {
      route: '/api/backtest/evaluate',
      stockCode: (req.body as { stockCode?: unknown } | undefined)?.stockCode,
      err: error,
    });
    const message = error instanceof Error ? error.message : '受控回测评估失败';
    res.status(500).json({ error: '受控回测评估失败', detail: message });
  }
});

export default router;

/**
 * 量化研究：回测 + 数据质量 + 审计 + 优化 + 摘要；受控回测评估（基线 vs 新闻叠加）；
 * 量价因子（A 股方向校正）与单因子评估 tear sheet。
 */
import { Router } from 'express';
import { quantLimiter, watchlistLimiter, circuitBreakerGuard } from '../middleware.js';
import { parseStrategyInput, orchestrate, generateSummary } from '../quant/agents/orchestrator.js';
import type { StrategyConfig } from '../quant/types.js';
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
  type FactorPredictability,
} from '../quant/factorPredictability.js';
import { evaluateFactor, judgeFactor, type FactorObservation } from '../quant/factorEvaluation.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import { runBacktest } from '../quant/backtestEngine.js';
import { withTimeout } from '../utils/timeout.js';
import logger from '../utils/logger.js';

const router = Router();

// === Quant Research Endpoint ===
router.post('/api/quant/analyze', quantLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const { strategy, useNews, newsItems } = req.body as {
      strategy: StrategyConfig | string;
      useNews?: boolean;
      newsItems?: NewsItem[];
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

    // 3. 运行回测：baseline（不含新闻）+ 含最新消息情绪叠加层（news-aware）
    const backtestBaseline = runBacktest(ohlcvData, strategyConfig);
    let backtestResult = backtestBaseline;
    // 记录实际应用的叠加层：limitations 文案需区分严格时序（items）与旧口径（聚合常数）
    let newsOverlayUsed: {
      polarity: number;
      since?: string;
      items?: { publishedAt: string; polarity: number }[];
    } | null = null;
    if (newsSignal?.hasNews) {
      newsOverlayUsed = {
        polarity: newsSignal.polarity,
        since: earliestNewsDate(newsSignal.items),
        items: newsSignal.timeline,
      };
      backtestResult = runBacktest(ohlcvData, {
        ...strategyConfig,
        // since=新闻最早发布日；items=分段情绪时间线（引擎按各 bar 已知新闻严格时序叠加）
        newsOverlay: newsOverlayUsed,
      });
    }

    // 3.5 量价因子：A 股方向已按本土实证校正（短期反转而非动量），随报告透出。
    //     数据不足的因子 value 序列化为 null（available=false），调用方据此剔除，
    //     而不是当成 0 参与加权——那等价于给「无法计算」的标的安一个居中值。
    //     同时计算每只因子对「这只股票自身」远期收益的时间序列预测力（IC / t / p /
    //     是否显著）：截面 IC 需多股票横截面，单股场景下时间序列 IC 才是可证伪口径。
    const priceVolumeFactorsSnapshot = computePriceVolumeFactors({ bars: ohlcvData });
    let factorPredictability: FactorPredictability[] = [];
    try {
      factorPredictability = evaluatePriceVolumeFactorPredictability({ bars: ohlcvData });
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
    limitations.push('历史回测不代表未来收益');

    // 7. 返回完整报告
    const report = {
      strategy: strategyConfig,
      dataQuality,
      backtest: backtestResult,
      backtestBaseline: newsSignal?.hasNews ? backtestBaseline : undefined,
      newsSentiment: newsSignal?.hasNews ? newsSignal : undefined,
      priceVolumeFactors,
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

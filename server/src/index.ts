import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import * as fs from 'fs';
import * as path from 'path';
import { runAnalysis } from './services/analysisPipeline.js';
import { getSupportedStocks, searchStocks } from './services/dataService.js';
import { loadStockMaster } from './services/stockMaster.js';
import { getWatchlist, addToWatchlist, removeFromWatchlist } from './services/watchlistService.js';
import { runWatchlistNewsBacktest } from './services/watchlistBacktest.js';
import { fetchOHLCVData } from './quant/dataProvider.js';
import { runBacktest } from './quant/backtestEngine.js';
import { orchestrate, generateSummary, parseStrategyInput } from './quant/agents/orchestrator.js';
import type { StrategyConfig } from './quant/types.js';
import { extractNewsSignal, aggregateNewsSentiment, type NewsItem, type NewsSignal } from './quant/newsSignal.js';
import { withTimeout } from './utils/timeout.js';
import logger from './utils/logger.js';
import { chatAgent } from './services/chatAgent.js';
import { detectAlerts, type WatchlistAlert } from './services/alerts.js';
import { ingestDocument, getIngestedDocs } from './llm/rag.js';
import { extractDocumentInsights } from './services/documentInsights.js';
import { extractTextFromPdf } from './quant/pdfExtract.js';
import { startAutonomousLoop, type AutonomousController } from './services/scheduler.js';
import { getModelRegistry, selectModel, getCostReport, resetCostTracker, isLLMAvailable, isEmbeddingConfigured } from './llm/index.js';
import { clearHistory } from './services/chatMemory.js';
import { configureTracer, expressTracerMiddleware } from './services/telemetry.js';
import { PaperAccount } from './quant/paperTrading.js';
import { auditLogger } from './services/auditLog.js';
import { fetchIntlFundamentals, detectMarket, type IntlMarket } from './quant/intlDataProvider.js';

export const app = express();

// === CORS 配置：生产环境限制来源，开发环境允许所有 ===
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

app.use(
  cors({
    origin: (origin, callback) => {
      // 开发环境或无 origin（如 curl/测试）时允许
      if (process.env.NODE_ENV !== 'production' || !origin) {
        callback(null, true);
        return;
      }
      // 生产环境：白名单校验
      if (allowedOrigins && allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    maxAge: 86400, // 预检请求缓存 24 小时
  }),
);

// === 安全响应头（OWASP 最佳实践） ===
app.use((_req: Request, res: Response, next: NextFunction) => {
  // 基础安全头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // 现代浏览器建议禁用旧 XSS Auditor，改用 CSP
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // 下载安全：防止 IE 执行下载的文件
  res.setHeader('X-Download-Options', 'noopen');

  // DNS 预取控制
  res.setHeader('X-DNS-Prefetch-Control', 'off');

  // HSTS：仅在生产环境且通过 HTTPS 访问时启用
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_HSTS === 'true') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload', // 2 年
    );
  }

  // CSP：内容安全策略（适度严格，允许内联样式以兼容 ECharts 等库）
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));

  next();
});

// === 请求体大小限制：防止 DoS ===
app.use(express.json({ limit: '100kb' }));

// === 请求 ID 中间件：便于日志追踪 ===
app.use((req: Request, res: Response, next: NextFunction) => {
  const reqId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  res.setHeader('X-Request-ID', reqId);
  (req as Request & { reqId: string }).reqId = reqId;
  next();
});

// === 请求日志中间件 ===
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const reqId = (req as Request & { reqId?: string }).reqId || '-';
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP request', {
      reqId,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: duration,
    });
  });
  next();
});

// === 全链路追踪：为每个 HTTP 请求注入 X-Trace-Id 并采集 span ===
// span 完成时输出到结构化日志（debug 级，需 LOG_LEVEL=debug 才可见，避免默认噪声）
configureTracer({
  exportHook: (span) => {
    logger.debug('trace.span.completed', {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      durationMs: span.durationMs,
      status: span.status,
      attributes: span.attributes,
    });
  },
});
app.use(expressTracerMiddleware());

// === Rate Limiting ===
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;

const analyzeLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_ANALYZE) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试', retryAfter: Math.ceil(windowMs / 1000) }
});

const searchLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_SEARCH) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '搜索请求过于频繁，请稍后再试', retryAfter: Math.ceil(windowMs / 1000) }
});

// === Enhanced Health Check ===
app.get('/api/health', async (req, res) => {
  const health: Record<string, unknown> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  };

  // Check external API reachability
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://www.eastmoney.com/', {
      method: 'HEAD',
      signal: controller.signal
    });
    clearTimeout(timeout);
    health.externalApi = { status: 'reachable', httpStatus: response.status };
  } catch (err) {
    health.externalApi = { status: 'unreachable', error: (err as Error).message };
  }

  // Check cache directory
  const cacheDir = path.join(import.meta.dirname, '..', 'data', 'cache');
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.accessSync(cacheDir, fs.constants.R_OK | fs.constants.W_OK);
    health.cacheDir = { status: 'ok', path: cacheDir };
  } catch (err) {
    health.cacheDir = { status: 'error', path: cacheDir, error: (err as Error).message };
  }

  const externalApiUnreachable = typeof health.externalApi === 'object' && health.externalApi !== null && (health.externalApi as Record<string, unknown>).status === 'unreachable';
  const cacheDirError = typeof health.cacheDir === 'object' && health.cacheDir !== null && (health.cacheDir as Record<string, unknown>).status === 'error';
  const hasErrors = externalApiUnreachable || cacheDirError;
  res.status(hasErrors ? 503 : 200).json(health);
});

// 核心分析接口
app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const { stockCode } = req.body;
    if (!stockCode || !/^\d{6}$/.test(stockCode)) {
      return res.status(400).json({ error: '请提供有效的6位股票代码' });
    }
    const result = await runAnalysis(stockCode);
    res.json(result);
  } catch (error) {
    logger.error('Analysis error', { route: '/api/analyze', stockCode: req.body?.stockCode, err: error });
    res.status(500).json({ error: '分析过程出错', detail: (error as Error).message });
  }
});

// === 流式分析接口（SSE，逐步推送分析进度）===
app.get('/api/analyze/stream', analyzeLimiter, async (req: Request, res: Response) => {
  const stockCode = String(req.query.stockCode || '');
  if (!/^\d{6}$/.test(stockCode)) {
    return res.status(400).json({ error: '请提供有效的6位股票代码' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (data: unknown) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端已断开 */ }
  };

  try {
    const result = await runAnalysis(stockCode, (stage) => send(stage));
    send({ phase: 'done', message: '分析完成', result });
  } catch (error) {
    send({ phase: 'error', message: (error as Error).message || '分析过程出错' });
  } finally {
    res.end();
  }
});

// === Compare Rate Limiter (3 req/min) ===
const compareLimiter = rateLimit({
  windowMs: 60000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '对比请求过于频繁（限制：每分钟3次），请稍后再试', retryAfter: 60 }
});

// 股票对比接口
app.post('/api/compare', compareLimiter, async (req, res) => {
  try {
    const { stockCodes } = req.body;
    if (!Array.isArray(stockCodes) || stockCodes.length < 2 || stockCodes.length > 3) {
      return res.status(400).json({ error: '请选择2-3只股票进行对比' });
    }
    for (const code of stockCodes) {
      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: `无效的股票代码：${code}` });
      }
    }
    // Run analysis for each stock in parallel
    const results = await Promise.all(stockCodes.map((code: string) => runAnalysis(code)));
    res.json({ stocks: results.map(r => r.stock_pool[0]) });
  } catch (error: unknown) {
    logger.error('Compare error', { route: '/api/compare', stockCodes: req.body?.stockCodes, err: error });
    const detail = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: '对比分析失败', detail });
  }
});

// 获取支持的股票列表
app.get('/api/stocks', async (req, res) => {
  try {
    const stocks = await getSupportedStocks();
    res.json(stocks);
  } catch (error) {
    res.json([{ code: '600519', name: '贵州茅台', industry: '白酒' }]);
  }
});

// === Quant Rate Limiter (5 req/min) ===
const quantLimiter = rateLimit({
  windowMs: 60000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '量化分析请求过于频繁（限制：每分钟5次），请稍后再试', retryAfter: 60 }
});

// === Watchlist Batch News-Backtest Limiter (3 req/min) ===
const watchlistLimiter = rateLimit({
  windowMs: 60000,
  max: Number(process.env.RATE_LIMIT_MAX_WATCHLIST) || 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '自选股批量回测过于频繁（限制：每分钟3次），请稍后再试', retryAfter: 60 }
});

// === Quant Research Endpoint ===
app.post('/api/quant/analyze', quantLimiter, async (req, res) => {
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
      strategyConfig.startDate = new Date(Date.now() - 365 * 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    }
    if (!strategyConfig.endDate) {
      strategyConfig.endDate = new Date().toISOString().split('T')[0];
    }

    // 2. 获取K线数据
    const ohlcvData = await fetchOHLCVData(strategyConfig.stockCode, strategyConfig.startDate, strategyConfig.endDate);
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
    if (newsSignal?.hasNews) {
      backtestResult = runBacktest(ohlcvData, {
        ...strategyConfig,
        newsOverlay: { polarity: newsSignal.polarity },
      });
    }

    // 4. 编排子Agent：数据质量、审计、优化
    const { dataQuality, audit, optimization } = await orchestrate(strategyConfig, ohlcvData, backtestResult);

    // 5. 生成摘要
    const summary = generateSummary(strategyConfig, dataQuality, backtestResult, audit, optimization);

    // 6. 置信度与局限性
    const confidence = dataQuality.overallScore >= 80 && audit.riskScore >= 70
      ? '高'
      : dataQuality.overallScore >= 60 && audit.riskScore >= 50
        ? '中'
        : '低';

    const limitations: string[] = [];
    if (ohlcvData.some(d => d.isSimulated)) {
      limitations.push('当前使用模拟数据，回测结果仅供参考');
    }
    if (backtestResult.tradeCount < 5) {
      limitations.push('交易次数过少，统计意义有限');
    }
    if (audit.overfittingRisk === 'high') {
      limitations.push('存在过拟合风险，策略可能在未来表现不佳');
    }
    limitations.push('历史回测不代表未来收益');

    // 7. 返回完整报告
    const report = {
      strategy: strategyConfig,
      dataQuality,
      backtest: backtestResult,
      backtestBaseline: newsSignal?.hasNews ? backtestBaseline : undefined,
      newsSentiment: newsSignal?.hasNews ? newsSignal : undefined,
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

// 搜索股票
app.get('/api/stocks/search', searchLimiter, async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword || typeof keyword !== 'string') {
      return res.status(400).json({ error: '请提供搜索关键词' });
    }
    const results = await searchStocks(keyword);
    res.json(results);
  } catch (error) {
    res.json([]);
  }
});

// === 自选股/持仓监控：清单管理 ===
app.get('/api/watchlist', (_req, res) => {
  res.json({ codes: getWatchlist() });
});

app.post('/api/watchlist', (req, res) => {
  const code = String(req.body?.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '请提供有效的6位股票代码' });
  }
  const codes = addToWatchlist(code);
  res.json({ codes });
});

app.delete('/api/watchlist/:code', (req, res) => {
  const code = String(req.params.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '无效的股票代码' });
  }
  const codes = removeFromWatchlist(code);
  res.json({ codes });
});

// 批量"含最新消息回测"：对每只自选股跑新闻叠加回测
app.post('/api/watchlist/news-backtest', watchlistLimiter, async (req, res) => {
  try {
    const body = req.body ?? {};
    let codes: string[] = Array.isArray(body.codes) ? body.codes : [];
    if (codes.length === 0) codes = getWatchlist();
    if (codes.length === 0) {
      return res.status(400).json({ error: '自选股清单为空，请先添加股票' });
    }
    if (codes.length > 20) {
      return res.status(400).json({ error: '单次批量回测上限 20 只' });
    }
    const report = await runWatchlistNewsBacktest(codes);
    res.json(report);
  } catch (error) {
    logger.error('Watchlist news-backtest error', { route: '/api/watchlist/news-backtest', err: error });
    const message = error instanceof Error ? error.message : '批量回测失败';
    res.status(500).json({ error: '自选股批量回测失败', detail: message });
  }
});

// 受控回测评估：基线(无新闻叠加) vs 实验(带新闻情绪叠加)，量化 LLM 信号是否真增 alpha
// 复用 /api/analyze 的限流器（analysisLimiter），同属重计算端点
app.post('/api/backtest/evaluate', watchlistLimiter, async (req, res) => {
  try {
    const body = req.body ?? {};
    const stockCode = String(body.stockCode ?? '').trim();
    if (!/^\d{6}$/.test(stockCode)) {
      return res.status(400).json({ error: '请提供有效的6位股票代码' });
    }
    const strategyName = String(body.strategy ?? 'ma_cross').trim();
    const startDate = String(body.startDate ?? new Date(Date.now() - 365 * 2 * 24 * 3600 * 1000).toISOString().split('T')[0]);
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
      const ns = await extractNewsSignal(stockCode);
      if (ns.signal.hasNews) {
        expCfg = { ...expCfg, newsOverlay: { polarity: ns.signal.polarity } };
      }
    } catch {
      // 新闻抓取失败：实验组退化为基线，评估器会判 inconclusive/tie
    }
    const experiment = runBacktest(ohlcv, expCfg);

    const { compareBacktests } = await import('./quant/backtestEvaluator.js');
    const comparison = compareBacktests(baseline, experiment);
    res.json({ baseline, experiment, comparison, newsSource: expCfg.newsOverlay ? 'live' : 'none' });
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

// === Chat Agent Rate Limiter (10 req/min) ===
const chatLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_CHAT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '对话请求过于频繁（限制：每分钟10次），请稍后再试', retryAfter: 60 }
});

// === 对话式智能体接口（自然语言入口） ===
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const body = req.body ?? {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ error: '请提供对话内容' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: '对话内容过长（上限 2000 字）' });
    }
    const result = await chatAgent.run({
      message,
      history: Array.isArray(body.history) ? body.history : undefined,
      stockCode: typeof body.stockCode === 'string' ? body.stockCode : undefined,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    });
    res.json(result);
  } catch (error) {
    logger.error('Chat error', { route: '/api/chat', err: error });
    res.status(500).json({ error: '对话处理失败', detail: (error as Error).message });
  }
});

// === 流式对话接口（SSE，真流式：逐阶段推送执行进度） ===
app.get('/api/chat/stream', chatLimiter, async (req: Request, res: Response) => {
  const message = String(req.query.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: '请提供对话内容' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (data: unknown) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 已断开 */ }
  };

  try {
    await chatAgent.runStream(
      {
        message,
        sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
      },
      (event) => send(event),
    );
  } catch (error) {
    send({ phase: 'error', message: (error as Error).message || '对话处理失败' });
  } finally {
    res.end();
  }
});

// 自选股主动监控：重跑批量新闻回测并检出异动预警
app.post('/api/watchlist/monitor', watchlistLimiter, async (req, res) => {
  try {
    const codes = getWatchlist();
    if (codes.length === 0) {
      return res.status(400).json({ error: '自选股清单为空，请先添加股票' });
    }
    const report = await runWatchlistNewsBacktest(codes);
    const alerts = detectAlerts(report.results);
    res.json({ generatedAt: report.generatedAt, monitored: report.count, alerts });
  } catch (error) {
    logger.error('Watchlist monitor error', { route: '/api/watchlist/monitor', err: error });
    res.status(500).json({ error: '自选股监控失败', detail: (error as Error).message });
  }
});

// === 模拟盘（paper trading）研究闭环：无实盘资金，日 K 收盘撮合 + A 股规则（T+1/涨跌停/整手/费用） ===
const PAPER_INITIAL_CAPITAL = Number(process.env.PAPER_INITIAL_CAPITAL) || 100_000;
let _paperAccount: PaperAccount | null = null;
// 持久化路径可被 PAPER_TRADING_FILE 重定向（与 watchlist 的 WATCHLIST_FILE 同模式），测试据此隔离临时文件
function paperStoreFile(): string {
  return (
    process.env.PAPER_TRADING_FILE && process.env.PAPER_TRADING_FILE.length > 0
      ? process.env.PAPER_TRADING_FILE
      : path.join(import.meta.dirname, 'data', 'paperTrading.json')
  );
}
function getPaperAccount(): PaperAccount {
  if (!_paperAccount) {
    const file = paperStoreFile();
    // 文件缺失（首次运行/测试临时路径）时回退新建账户，避免 load 抛 ENOENT 导致 500
    _paperAccount =
      (fs.existsSync(file) ? PaperAccount.load(file) : null) ??
      new PaperAccount(PAPER_INITIAL_CAPITAL, { autoSave: true });
  }
  return _paperAccount;
}

app.get('/api/paper/portfolio', (req, res) => {
  try {
    const acct = getPaperAccount();
    res.json({
      initialCapital: acct.initialCapital,
      cash: acct.cash,
      currentDate: acct.currentTradingDate,
      positions: [...acct.positions.entries()].map(([, p]) => ({ ...p })),
      orders: acct.orders.slice(-50),
      equity: acct.getDailyEquity(),
    });
  } catch (error) {
    logger.error('Paper portfolio error', { route: '/api/paper/portfolio', err: error });
    res.status(500).json({ error: '模拟盘账户读取失败', detail: (error as Error).message });
  }
});

app.post('/api/paper/order', (req, res) => {
  try {
    const body = req.body ?? {};
    const acct = getPaperAccount();
    if (typeof body.date === 'string') acct.setCurrentDate(body.date);
    const order = acct.placeOrder({
      code: String(body.code ?? ''),
      side: body.side as 'buy' | 'sell',
      type: body.type as 'market' | 'limit',
      price: typeof body.price === 'number' ? body.price : undefined,
      quantity: Number(body.quantity),
    });
    // 校验失败（非法代码/数量/限价等）placeOrder 返回 rejected 订单而非抛错 → 按 400 拒绝
    if (order.status === 'rejected') {
      return res.status(400).json({ error: '下单失败', detail: order.rejectReason ?? '无效订单' });
    }
    acct.save();
    res.json({ order });
  } catch (error) {
    logger.warn('Paper order rejected', { route: '/api/paper/order', err: error });
    res.status(400).json({ error: '下单失败', detail: (error as Error).message });
  }
});

app.post('/api/paper/settle', (req, res) => {
  try {
    const body = req.body ?? {};
    if (typeof body.date !== 'string') {
      return res.status(400).json({ error: '缺少结算日期 date（YYYY-MM-DD）' });
    }
    const acct = getPaperAccount();
    acct.setCurrentDate(body.date);
    const closes = new Map<string, number>(Object.entries(body.closePrices ?? {}));
    const prev = body.prevClosePrices ? new Map<string, number>(Object.entries(body.prevClosePrices)) : undefined;
    acct.settleDay(closes, prev);
    acct.save();
    const equity = acct.getDailyEquity();
    res.json({ date: body.date, cash: acct.cash, latestEquity: equity.at(-1), history: equity });
  } catch (error) {
    logger.error('Paper settle error', { route: '/api/paper/settle', err: error });
    res.status(500).json({ error: '日终结算失败', detail: (error as Error).message });
  }
});

app.get('/api/paper/stats', (req, res) => {
  try {
    res.json(getPaperAccount().computeStats());
  } catch (error) {
    logger.error('Paper stats error', { route: '/api/paper/stats', err: error });
    res.status(500).json({ error: '统计失败', detail: (error as Error).message });
  }
});

// === 合规审计查询（金融监管 8 号文）：可按类别/风险等级/时间/会话过滤 ===
app.get('/api/audit', (req, res) => {
  try {
    const q = req.query;
    const filter: Parameters<typeof auditLogger.query>[0] = {
      ...(q.category ? { category: String(q.category) as never } : {}),
      ...(q.riskLevel ? { riskLevel: String(q.riskLevel) as never } : {}),
      ...(q.startTime ? { startTime: Number(q.startTime) } : {}),
      ...(q.endTime ? { endTime: Number(q.endTime) } : {}),
      ...(q.sessionId ? { sessionId: String(q.sessionId) } : {}),
    };
    const entries = auditLogger.query(filter);
    res.json({ count: entries.length, entries });
  } catch (error) {
    logger.error('Audit query error', { route: '/api/audit', err: error });
    res.status(500).json({ error: '审计查询失败', detail: (error as Error).message });
  }
});

// === 港美股财务估值（东财 datacenter RPT 网关，替代 push2） ===
app.get('/api/intl/fundamentals', async (req, res) => {
  try {
    const code = String(req.query.code ?? '').trim();
    if (!code) return res.status(400).json({ error: '请提供代码 code' });
    const rawMarket = req.query.market ? String(req.query.market).toUpperCase() : detectMarket(code);
    if (rawMarket === 'A') {
      return res.status(400).json({ error: 'A 股代码请走 /api/analyze 分析接口，本接口仅港美股财务估值' });
    }
    const market = rawMarket as IntlMarket;
    const result = await fetchIntlFundamentals(code, market);
    res.json(result);
  } catch (error) {
    logger.error('Intl fundamentals error', { route: '/api/intl/fundamentals', err: error });
    res.status(500).json({ error: '港美股数据获取失败', detail: (error as Error).message });
  }
});

// === 文档入库（研报/财报/公告）：PDF 或纯文本 → 洞察抽取 → 注入 RAG ===
app.post('/api/ingest', chatLimiter, async (req, res) => {
  try {
    const body = req.body ?? {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return res.status(400).json({ error: '请提供文档标题 title' });
    let text = typeof body.text === 'string' ? body.text : '';
    if (!text && typeof body.pdfBase64 === 'string' && body.pdfBase64) {
      text = await extractTextFromPdf(Buffer.from(body.pdfBase64, 'base64'));
    }
    if (!text.trim()) return res.status(400).json({ error: '请提供 text 或 pdfBase64' });

    const insight = await extractDocumentInsights(text);
    const docText = [
      `【${title}】${insight.summary}`,
      `利好:${insight.positives.join(';')}`,
      `风险:${insight.risks.join(';')}`,
      `催化剂:${insight.catalysts.join(';')}`,
      text.slice(0, 1500),
    ].join('\n');
    const id = `ingested:${Date.now()}`;
    ingestDocument({ id, source: `doc:${title}`, text: docText });
    res.json({ id, title, insight, ingested: true });
  } catch (error) {
    logger.error('Ingest error', { route: '/api/ingest', title: req.body?.title, err: error });
    res.status(500).json({ error: '文档入库失败', detail: (error as Error).message });
  }
});

app.get('/api/documents', (_req, res) => {
  const docs = getIngestedDocs();
  res.json({
    count: docs.length,
    docs: docs.map((d) => ({ id: d.id, source: d.source, preview: d.text.slice(0, 200) })),
  });
});

// === 多模型路由 / 成本治理 ===
app.get('/api/models', (_req, res) => {
  const tasks = ['chat', 'analysis', 'debate', 'extract', 'reasoning', 'embedding'] as const;
  res.json({
    available: isLLMAvailable(),
    embeddingEnabled: isEmbeddingConfigured(),
    registry: getModelRegistry(),
    routing: Object.fromEntries(tasks.map((t) => [t, selectModel(t)])),
  });
});

app.get('/api/cost', (_req, res) => {
  res.json(getCostReport());
});

app.post('/api/cost/reset', (_req, res) => {
  resetCostTracker();
  res.json({ ok: true });
});

// === 对话历史清空（持久记忆管理） ===
app.post('/api/chat/history/clear', (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  if (!sessionId) return res.status(400).json({ error: '请提供 sessionId' });
  clearHistory(sessionId);
  res.json({ ok: true });
});

// === 主动监控自治循环（autonomous loop） ===
let autonomousController: AutonomousController | null = null;
let lastAutonomousAlerts: WatchlistAlert[] = [];

app.post('/api/autonomous/start', watchlistLimiter, async (req, res) => {
  try {
    if (autonomousController) autonomousController.stop();
    const intervalMs = Number(req.body?.intervalMs) || 5 * 60 * 1000;
    autonomousController = startAutonomousLoop({
      intervalMs,
      monitor: async () => runWatchlistNewsBacktest(getWatchlist()),
      onAlert: (alerts) => {
        lastAutonomousAlerts = alerts;
        logger.info('[autonomous] 检出异动预警', { count: alerts.length });
      },
    });
    res.json({ started: true, ...autonomousController.getState() });
  } catch (error) {
    logger.error('Autonomous start error', { route: '/api/autonomous/start', err: error });
    res.status(500).json({ error: '启动自治循环失败', detail: (error as Error).message });
  }
});

app.post('/api/autonomous/stop', (_req, res) => {
  if (autonomousController) {
    autonomousController.stop();
    autonomousController = null;
  }
  res.json({ stopped: true, lastAlerts: lastAutonomousAlerts });
});

app.get('/api/autonomous/status', (_req, res) => {
  res.json(autonomousController ? autonomousController.getState() : { running: false });
});

// === 404 兜底 ===
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: '接口不存在', path: req.path });
});

// === 统一错误处理中间件（须放在所有路由之后，4 个参数触发错误处理） ===
app.use((err: Error & { statusCode?: number; type?: string }, req: Request, res: Response, _next: NextFunction) => {
  const reqId = (req as Request & { reqId?: string }).reqId || '-';

  // CORS 错误
  if (err.message === 'Not allowed by CORS') {
    logger.warn('CORS blocked', { reqId, origin: req.headers.origin });
    res.status(403).json({ error: 'CORS 拒绝：来源不在白名单中' });
    return;
  }

  // 速率限制错误（express-rate-limit 会设置 statusCode）
  if (err.statusCode === 429) {
    res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    return;
  }

  // payload 过大
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: '请求体过大' });
    return;
  }

  // 通用 500
  logger.error('Unhandled error', { reqId, err });
  res.status(500).json({
    error: '服务器内部错误',
    detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    requestId: reqId,
  });
});

// === Start Server（仅作为进程入口直接运行时监听端口；测试通过 supertest 引用导出的 app，不监听） ===
if (process.env.NODE_ENV !== 'test') {
  const PORT = Number(process.env.PORT) || 3001;
  const server = app.listen(PORT, () => {
    logger.info('Server running', { url: `http://localhost:${PORT}` });
    // 预热证券全表，使首次兜底模糊搜索即时响应
    loadStockMaster().catch((err) =>
      logger.warn('[stockMaster] 预热失败，首次搜索将按需加载', { err: err as Error }),
    );
  });

  // === Graceful Shutdown ===
  let isShuttingDown = false;

  function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info('收到关闭信号，开始优雅关闭', { signal });
    logger.info('[Shutdown] 等待进行中的请求完成');

    // 30 秒后强制退出，避免长连接阻塞关闭
    const forceExit = setTimeout(() => {
      logger.error('[Shutdown] 30秒超时，强制关闭');
      process.exit(1);
    }, 30000);

    // server.close 的回调在所有现有连接关闭后触发
    server.close((err) => {
      clearTimeout(forceExit);
      if (err) {
        logger.error('[Shutdown] 关闭出错', { err });
        process.exit(1);
      }
      logger.info('[Shutdown] 所有连接已关闭，优雅关闭完成');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // 兜底：未处理的 Promise 拒绝与未捕获异常，避免进程静默崩溃
  process.on('unhandledRejection', (reason) => {
    logger.error('[UnhandledRejection]', { reason });
  });
  process.on('uncaughtException', (err) => {
    logger.error('[UncaughtException]', { err });
    // 进入不稳定状态，优雅退出
    gracefulShutdown('uncaughtException');
  });
}

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
import { chatAgent } from './services/chatAgent.js';

export const app = express();
app.use(cors());

// === 安全响应头（OWASP 最佳实践，等效 helmet 核心） ===
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // 现代浏览器建议禁用旧 XSS Auditor
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json());

// === 请求日志中间件 ===
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

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
    console.error('Analysis error:', error);
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
    console.error('Compare error:', error);
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
    console.error('Quant analysis error:', error);
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
    console.error('Watchlist news-backtest error:', error);
    const message = error instanceof Error ? error.message : '批量回测失败';
    res.status(500).json({ error: '自选股批量回测失败', detail: message });
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
    });
    res.json(result);
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: '对话处理失败', detail: (error as Error).message });
  }
});

// === 流式对话接口（SSE） ===
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
    const result = await chatAgent.run({ message });
    send({ phase: 'done', ...result });
  } catch (error) {
    send({ phase: 'error', message: (error as Error).message || '对话处理失败' });
  } finally {
    res.end();
  }
});

// === 404 兜底 ===
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: '接口不存在', path: req.path });
});

// === 统一错误处理中间件（须放在所有路由之后，4 个参数触发错误处理） ===
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: '服务器内部错误', detail: err.message });
});

// === Start Server（仅作为进程入口直接运行时监听端口；测试通过 supertest 引用导出的 app，不监听） ===
if (process.env.NODE_ENV !== 'test') {
  const PORT = Number(process.env.PORT) || 3001;
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // 预热证券全表，使首次兜底模糊搜索即时响应
    loadStockMaster().catch((err) => console.warn('[stockMaster] 预热失败，首次搜索将按需加载:', (err as Error).message));
  });

  // === Graceful Shutdown ===
  let isShuttingDown = false;

  function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[${signal}] 收到关闭信号，开始优雅关闭...`);
    console.log('[Shutdown] 等待进行中的请求完成...');

    // 30 秒后强制退出，避免长连接阻塞关闭
    const forceExit = setTimeout(() => {
      console.error('[Shutdown] 30秒超时，强制关闭');
      process.exit(1);
    }, 30000);

    // server.close 的回调在所有现有连接关闭后触发
    server.close((err) => {
      clearTimeout(forceExit);
      if (err) {
        console.error('[Shutdown] 关闭出错:', err.message);
        process.exit(1);
      }
      console.log('[Shutdown] 所有连接已关闭，优雅关闭完成');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // 兜底：未处理的 Promise 拒绝与未捕获异常，避免进程静默崩溃
  process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err);
    // 进入不稳定状态，优雅退出
    gracefulShutdown('uncaughtException');
  });
}

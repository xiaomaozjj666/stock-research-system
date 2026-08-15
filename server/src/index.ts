/**
 * 服务入口（组合根）：装配 app 级中间件、挂载路由模块、静态托管与优雅关闭。
 * 业务路由已拆到 routes/ 各模块，本文件不再承载具体接口逻辑。
 */
import 'dotenv/config';
import { loadEnv } from './utils/env.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as fs from 'fs';
import * as path from 'path';
import { loadStockMaster } from './services/stockMaster.js';
import { configureTracer, expressTracerMiddleware } from './services/telemetry.js';
import { httpMetricsMiddleware } from './services/metrics.js';
import logger from './utils/logger.js';

// 路由模块
import healthRouter from './routes/health.js';
import analysisRouter from './routes/analysis.js';
import marketRouter from './routes/market.js';
import quantRouter from './routes/quant.js';
import watchlistRouter from './routes/watchlist.js';
import chatRouter from './routes/chat.js';
import paperRouter from './routes/paper.js';
import auditRouter from './routes/audit.js';
import intlRouter from './routes/intl.js';
import documentsRouter from './routes/documents.js';
import costRouter from './routes/cost.js';
import autonomousRouter from './routes/autonomous.js';

// 启动即校验环境变量（H-04）：非法 PORT / CACHE_TTL_HOURS 等直接快速失败，
// 避免以错误的默认值静默运行。生产环境关键配置缺失会打 warn 提示。
loadEnv();

export const app = express();

// === CORS 配置：生产环境限制来源，开发环境允许所有 ===
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

app.use(
  // 函数形式：cors 会把 req 传入，便于判断同源（SPA 由本服务托管时浏览器会带自己的 Origin）
  cors((req, callback) => {
    const baseOptions = { credentials: true, maxAge: 86400 }; // 预检请求缓存 24 小时
    const origin = req.headers.origin;
    // 开发环境或无 origin（如 curl/测试）时允许
    if (process.env.NODE_ENV !== 'production' || !origin) {
      callback(null, { ...baseOptions, origin: true });
      return;
    }
    // 同源放行：origin 的 host 与请求 host 一致（SPA 由本服务托管时的自身请求）
    try {
      const host = req.headers.host;
      if (host && new URL(origin).host === host) {
        callback(null, { ...baseOptions, origin: true });
        return;
      }
    } catch {
      // origin 非法，继续走白名单
    }
    // 生产环境：白名单校验
    if (allowedOrigins && allowedOrigins.includes(origin)) {
      callback(null, { ...baseOptions, origin: true });
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }),
);

// === 安全响应头（helmet 标准中间件，替代手写头：覆盖面由库维护，不靠人记忆） ===
// CSP 与权限策略按本项目定制（允许内联样式以兼容 ECharts）；HSTS 生产环境 + 显式开启才启用。
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'https:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'https:'],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts:
      process.env.NODE_ENV === 'production' && process.env.ENABLE_HSTS === 'true'
        ? { maxAge: 63072000, includeSubDomains: true, preload: true } // 2 年
        : false,
  }),
);

// helmet v8 已移除 Permissions-Policy 中间件，单独补（保持原行为）
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
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

// === Prometheus 指标中间件：记录请求计数与耗时直方图（经 /api/metrics 导出） ===
app.use(httpMetricsMiddleware());

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

// === 挂载路由模块 ===
app.use(healthRouter);
app.use(analysisRouter);
app.use(marketRouter);
app.use(quantRouter);
app.use(watchlistRouter);
app.use(chatRouter);
app.use(paperRouter);
app.use(auditRouter);
app.use(intlRouter);
app.use(documentsRouter);
app.use(costRouter);
app.use(autonomousRouter);

// === 生产环境 SPA 静态托管：让单容器同时服务前端页面与 API（同源，无 CORS 依赖） ===
// 仅当 ../client/dist 存在（即已执行 npm run build）且为生产环境时启用；
// 开发环境仍走 Vite dev server（5173）+ 本服务 API（3001）双进程模式。
const CLIENT_DIST = path.join(import.meta.dirname, '..', '..', 'client', 'dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(CLIENT_DIST)) {
  // 静态资源：html/js/css/图片等，带 ETag 与长缓存友好头
  app.use(
    express.static(CLIENT_DIST, {
      index: false, // SPA 回退交给下面的 fallback，避免 / 直接命中 index.html 丢失路由
    }),
  );
  // SPA 路由回退：非 /api 开头的 GET 一律返回 index.html（前端为客户端渲染）
  app.get(/^\/(?!api\/).*/, (_req: Request, res: Response, next: NextFunction) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
}

// === 404 兜底 ===
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: '接口不存在', path: req.path });
});

// === 统一错误处理中间件（须放在所有路由之后，4 个参数触发错误处理） ===
app.use(
  (
    err: Error & { statusCode?: number; type?: string },
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
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
  },
);

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

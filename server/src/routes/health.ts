/**
 * 系统健康 / 指标 / OpenAPI 契约。
 */
import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { renderPrometheus } from '../services/metrics.js';
import { buildOpenApiDocument } from '../services/openapi.js';

const router = Router();

// === Enhanced Health Check ===
router.get('/api/health', async (_req, res) => {
  const health: Record<string, unknown> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };

  // Check external API reachability
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://www.eastmoney.com/', {
      method: 'HEAD',
      signal: controller.signal,
    });
    health.externalApi = { status: 'reachable', httpStatus: response.status };
  } catch (err) {
    health.externalApi = { status: 'unreachable', error: (err as Error).message };
  } finally {
    // 无论成功失败都释放定时器，避免健康检查定时器悬挂 5s
    clearTimeout(timeout);
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

  const externalApiUnreachable =
    typeof health.externalApi === 'object' &&
    health.externalApi !== null &&
    (health.externalApi as Record<string, unknown>).status === 'unreachable';
  const cacheDirError =
    typeof health.cacheDir === 'object' &&
    health.cacheDir !== null &&
    (health.cacheDir as Record<string, unknown>).status === 'error';
  const hasErrors = externalApiUnreachable || cacheDirError;
  res.status(hasErrors ? 503 : 200).json(health);
});

// === Prometheus 指标导出（文本格式 0.0.4，零依赖） ===
router.get('/api/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderPrometheus());
});

// === OpenAPI 3.1 契约（机器可读 API 规范，见 services/openapi.ts） ===
router.get('/api/openapi.json', (_req, res) => {
  res.json(buildOpenApiDocument());
});

export default router;

/**
 * 系统健康 / 指标 / OpenAPI 契约。
 */
import { Router } from 'express';
import * as fs from 'fs';
import { renderPrometheus } from '../services/metrics.js';
import { buildOpenApiDocument } from '../services/openapi.js';
import { getDataCacheDir } from '../services/dataService.js';
import { getQuantCacheDir } from '../quant/quantCache.js';

const router = Router();

/**
 * 只读探测缓存目录状态（**不创建目录**）：
 * 健康检查是被监控系统高频拉取的只读探针，早期实现在 GET 里 mkdirSync——
 * 既产生了「读接口写盘」的副作用，又让「目录不存在」被掩盖成 ok。
 * 目录尚未创建（如全新部署、尚未发生任何分析）只如实报告 'missing'，不算故障。
 */
function describeCacheDir(dir: string): { status: string; path: string; error?: string } {
  try {
    if (!fs.existsSync(dir)) return { status: 'missing', path: dir };
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return { status: 'ok', path: dir };
  } catch (err) {
    return { status: 'error', path: dir, error: (err as Error).message };
  }
}

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

  // Check cache directories：复用各缓存模块自身的目录解析逻辑（支持 DATA_CACHE_DIR），
  // 避免此处硬编码路径与真实写入目录不一致（曾经：DATA_CACHE_DIR 生效时健康检查仍在看旧目录）。
  // 两套缓存（股票数据 / 量化）分别报告：共享目录时也能一眼看出解析结果是否如预期。
  health.cacheDir = describeCacheDir(getDataCacheDir());
  health.quantCacheDir = describeCacheDir(getQuantCacheDir());

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

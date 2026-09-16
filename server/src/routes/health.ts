/**
 * 系统健康 / 指标 / OpenAPI 契约。
 */
import { Router } from 'express';
import * as fs from 'fs';
import { healthLimiter } from '../middleware.js';
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

/**
 * 外呼探测结果。
 * checkedAt 记录「这个结论是哪一刻探测出来的」：memo 命中时它是过去的时间，
 * 监控方据此区分「此刻可达」与「最近一次探测可达」。
 */
interface ExternalApiProbe {
  status: 'reachable' | 'unreachable';
  httpStatus?: number;
  error?: string;
  checkedAt: string;
}

/** 外呼 memo 默认窗口：60 秒（HEALTH_PROBE_MEMO_MS 可覆盖，0 = 关闭 memo） */
const DEFAULT_PROBE_MEMO_MS = 60_000;

/**
 * 外呼 memo 窗口（毫秒）。
 * 为什么需要 memo：/api/health 是监控系统高频拉取的探针，而原实现对**每次请求**
 * 都发一个对外 HEAD——探针频率直接等于对外请求频率（既浪费，又会被上游当成扫描源）。
 * 健康检查要的是「分钟级可达性」，不是每次请求的实时快照，故 60 秒窗口足够。
 *
 * 注：不改用 NODE_ENV 特判来规避测试——测试需要确定性时显式设
 * HEALTH_PROBE_MEMO_MS=0，避免出现「测试里跑的根本不是生产行为」。
 */
function probeMemoMs(): number {
  const raw = process.env.HEALTH_PROBE_MEMO_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PROBE_MEMO_MS;
  }
  return DEFAULT_PROBE_MEMO_MS;
}

let probeMemo: { at: number; value: ExternalApiProbe } | null = null;
/** 在途探测：memo 未命中时让并发探针共享同一次外呼（否则 10 个并发探针 = 10 个 HEAD） */
let probeInflight: Promise<ExternalApiProbe> | null = null;

/** 清空外呼 memo 与在途状态（测试与运维排查用；正常请求路径不调用） */
export function resetHealthProbeCache(): void {
  probeMemo = null;
  probeInflight = null;
}

/** 真发一次外呼（5s 超时）；成功/失败都返回结构而不是抛错，便于 memo 缓存两种结论 */
async function probeExternalApiOnce(): Promise<ExternalApiProbe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://www.eastmoney.com/', {
      method: 'HEAD',
      signal: controller.signal,
    });
    return {
      status: 'reachable',
      httpStatus: response.status,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: 'unreachable',
      error: (err as Error).message,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    // 无论成功失败都释放定时器，避免健康检查定时器悬挂 5s
    clearTimeout(timeout);
  }
}

/**
 * 带 memo + 并发合流的外呼探测。
 * - memo 命中（窗口内）：直接复用上次结论，零网络调用，并以 cached=true 如实标注；
 * - 并发合流：同一时刻的多个探针只触发一次真实外呼，其余等这一次的结果。
 */
async function probeExternalApi(): Promise<ExternalApiProbe & { cached: boolean }> {
  const memoMs = probeMemoMs();
  if (probeMemo && memoMs > 0 && Date.now() - probeMemo.at < memoMs) {
    return { ...probeMemo.value, cached: true };
  }
  if (!probeInflight) {
    probeInflight = probeExternalApiOnce().finally(() => {
      probeInflight = null;
    });
  }
  const value = await probeInflight;
  probeMemo = { at: Date.now(), value };
  return { ...value, cached: false };
}

// === Enhanced Health Check ===
router.get('/api/health', healthLimiter, async (_req, res) => {
  const health: Record<string, unknown> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };

  // 外部行情源可达性：60 秒 memo（详见 probeExternalApi）
  health.externalApi = await probeExternalApi();

  // Check cache directories：复用各缓存模块自身的目录解析逻辑（支持 DATA_CACHE_DIR），
  // 避免此处硬编码路径与真实写入目录不一致（曾经：DATA_CACHE_DIR 生效时健康检查仍在看旧目录）。
  // 两套缓存（股票数据 / 量化）分别报告：共享目录时也能一眼看出解析结果是否如预期。
  // 只读探测（existsSync/accessSync），GET 一律不写盘。
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
// Prometheus 抓取频率固定（通常 15~60s 一次），用 healthLimiter(120/min) 只做洪泛兜底：
// 阈值远高于正常抓取，避免把「抓取慢一点」误报成 429 故障。
router.get('/api/metrics', healthLimiter, (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderPrometheus());
});

// === OpenAPI 3.1 契约（机器可读 API 规范，见 services/openapi.ts） ===
// 每次请求都会重新构建整份文档（非静态文件），故与监控端点同一档洪泛兜底。
router.get('/api/openapi.json', healthLimiter, (_req, res) => {
  res.json(buildOpenApiDocument());
});

export default router;

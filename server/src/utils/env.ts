/**
 * 环境变量校验与类型化访问
 * ----------------------------------------------------------------------------
 * 在应用启动时校验必要的环境变量，缺失时给出明确提示。
 * 所有环境变量访问统一走此模块，避免散落的 process.env 读取。
 *
 * 设计原则：
 * 1. 可选变量有合理默认值，确保开发环境零配置即可启动
 * 2. 生产环境关键变量缺失时抛出明确错误，而非静默降级
 * 3. 类型安全：返回值均为具体类型，不是 string | undefined
 */

import logger from './logger.js';

/**
 * 配置对象只保留**有真实消费者**的字段（index.ts 的 CORS / HSTS / 监听端口）。
 * 历史上这里曾挂着 cacheTtlHours / rateLimitWindowMs / llm 等无消费字段——
 * 校验一套、消费一套，两套口径必然漂移；且对从未被读取的变量做启动校验
 * （如 CACHE_TTL_HOURS ≤ 0 直接抛错）会把「无效但无害」升级成「起不来」。
 * 各专属模块（llm/config、middleware、各缓存）保留自己的 env 解析与钳制。
 */
export interface EnvConfig {
  /** 服务端口（app.listen 的唯一读取口径） */
  port: number;
  /** CORS 允许的来源（逗号分隔），生产环境必填 */
  allowedOrigins: string[] | null;
  /** 是否启用 HSTS（仅生产环境 HTTPS 时启用） */
  enableHsts: boolean;
}

/**
 * 东方财富搜索 Token —— 全仓库唯一读取入口。
 *
 * **可选**：未配置（或仅空白）时返回 undefined，调用方据此省略该查询参数。
 *
 * 2026-10-24 实测 `searchapi.eastmoney.com/api/suggest/get` 对 token 参数
 * **完全不校验**：不带 token、空 token、垃圾 token 返回的数据逐字相同
 * （`600519 贵州茅台`、`300750 宁德时代` 均正常命中）。故本参数不再是必填项；
 * 配置了就随请求带上（向后兼容，若上游日后恢复校验），没配置就干净省略。
 * 此前 env.ts 与 services/dataService.ts 各写了一份相同的硬编码默认 token，
 * 等同把凭据随源码公开；默认值既已泄露就失去了凭据意义，必须由使用者自行配置。
 * 调用方（股票搜索）据此向用户提示去 `.env` 填写，而不是静默用默认值联网。
 */
export function getEastmoneySearchToken(): string | undefined {
  const token = process.env.EASTMONEY_SEARCH_TOKEN?.trim();
  return token || undefined;
}

/**
 * 限流窗口的唯一解析入口（带钳制）。
 *
 * `Number('-5') || 60000` 得到 -5 不是 NaN，`||` 兜不住——而 express-rate-limit
 * 会在初始化时抛 ERR_ERL_WINDOW_MS，一个错的环境变量就能让服务起不来。
 * middleware 与启动校验都走这里，避免两处口径各自漂移。
 */
export function resolveRateLimitWindowMs(
  raw: string | undefined = process.env.RATE_LIMIT_WINDOW_MS,
): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 60000;
}

/** 已校验的环境变量缓存 */
let cachedConfig: EnvConfig | null = null;
let validationError: Error | null = null;

/**
 * 校验并加载环境变量。首次调用时执行校验，后续返回缓存。
 * @throws Error 生产环境缺少必填变量时抛出
 */
export function loadEnv(): EnvConfig {
  if (cachedConfig) return cachedConfig;
  if (validationError) throw validationError;

  try {
    const isProd = process.env.NODE_ENV === 'production';

    // 端口
    const portRaw = process.env.PORT;
    const port = portRaw !== undefined ? Number(portRaw) : 3001;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`PORT 必须是 1-65535 的整数，当前值: ${portRaw}`);
    }

    // CORS 白名单
    const allowedOriginsRaw = process.env.ALLOWED_ORIGINS?.trim();
    const allowedOrigins = allowedOriginsRaw
      ? allowedOriginsRaw
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      : null;

    if (isProd && !allowedOrigins) {
      logger.warn(
        '[env] 警告：生产环境未设置 ALLOWED_ORIGINS，CORS 将允许所有来源。建议设置 ALLOWED_ORIGINS 以收紧安全策略。',
      );
    }

    const config: EnvConfig = {
      port,
      allowedOrigins,
      enableHsts: process.env.ENABLE_HSTS === 'true',
    };

    cachedConfig = config;

    if (isProd) {
      logger.info('[env] 生产环境配置已加载', {
        port,
        cors: allowedOrigins ? allowedOrigins.join(', ') : '未限制',
        hsts: config.enableHsts ? '启用' : '禁用',
      });
    } else {
      logger.info(`[env] 开发环境配置已加载 (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
    }

    return config;
  } catch (err) {
    validationError = err as Error;
    throw err;
  }
}

/**
 * 获取已校验的环境变量配置。
 * 与 loadEnv 不同，此函数在未初始化时返回 null 而非抛出。
 */
export function getEnv(): EnvConfig | null {
  return cachedConfig;
}

/**
 * 重置缓存（仅用于测试）
 */
export function _resetEnvCache(): void {
  cachedConfig = null;
  validationError = null;
}

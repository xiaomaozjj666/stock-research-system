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

export interface EnvConfig {
  /** 运行环境 */
  nodeEnv: 'development' | 'production' | 'test';
  /** 服务端口 */
  port: number;
  /** CORS 允许的来源（逗号分隔），生产环境必填 */
  allowedOrigins: string[] | null;
  /** 是否启用 HSTS（仅生产环境 HTTPS 时启用） */
  enableHsts: boolean;
  /** 缓存 TTL（小时） */
  cacheTtlHours: number;
  /** 速率限制窗口（毫秒） */
  rateLimitWindowMs: number;
  /** LLM API 相关 */
  llm: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    embeddingModel?: string;
  };
}

/**
 * 东方财富搜索 Token —— 全仓库唯一读取入口。
 *
 * 未配置（或仅为空白）时抛出带配置指引的错误，**不内置任何默认值**。
 * 此前 env.ts 与 services/dataService.ts 各写了一份相同的硬编码默认 token，
 * 等同把凭据随源码公开；默认值既已泄露就失去了凭据意义，必须由使用者自行配置。
 * 调用方（股票搜索）据此向用户提示去 `.env` 填写，而不是静默用默认值联网。
 */
export function requireEastmoneySearchToken(): string {
  const token = process.env.EASTMONEY_SEARCH_TOKEN?.trim();
  if (!token) {
    throw new Error(
      '未配置 EASTMONEY_SEARCH_TOKEN：请在 .env 中填写东方财富搜索 token（变量说明见 .env.example「外部数据源」一节）。',
    );
  }
  return token;
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
    const nodeEnv = (process.env.NODE_ENV || 'development') as EnvConfig['nodeEnv'];
    const isProd = nodeEnv === 'production';

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

    // 缓存 TTL
    const cacheTtlHoursRaw = process.env.CACHE_TTL_HOURS;
    const cacheTtlHours = cacheTtlHoursRaw !== undefined ? Number(cacheTtlHoursRaw) : 24;
    if (!Number.isFinite(cacheTtlHours) || cacheTtlHours <= 0) {
      throw new Error(`CACHE_TTL_HOURS 必须大于 0，当前值: ${cacheTtlHoursRaw}`);
    }

    // 速率限制窗口
    const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;

    const config: EnvConfig = {
      nodeEnv,
      port,
      allowedOrigins,
      enableHsts: process.env.ENABLE_HSTS === 'true',
      cacheTtlHours,
      rateLimitWindowMs,
      llm: {
        apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || undefined,
        baseUrl: process.env.LLM_BASE_URL || undefined,
        model: process.env.LLM_MODEL || undefined,
        embeddingModel: process.env.EMBEDDING_MODEL || undefined,
      },
    };

    cachedConfig = config;

    if (isProd) {
      logger.info('[env] 生产环境配置已加载', {
        port,
        cors: allowedOrigins ? allowedOrigins.join(', ') : '未限制',
        hsts: config.enableHsts ? '启用' : '禁用',
        llm: config.llm.apiKey ? '已配置' : '未配置（规则降级模式）',
      });
    } else {
      logger.info(`[env] 开发环境配置已加载 (NODE_ENV=${nodeEnv})`);
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

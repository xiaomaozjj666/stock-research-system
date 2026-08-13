/**
 * 合规审计日志模块
 * ----------------------------------------------------------------------------
 * 响应 2026-06 国家金融监管总局 8 号文"运行时即时熔断"要求，为系统提供：
 *  - 全量审计条目记录（LLM 调用 / 工具调用 / 交易信号 / 数据访问 / 用户查询 / 系统）
 *  - 按时间范围、类别、风险等级、会话 ID 等维度查询与导出
 *  - 运行时即时熔断：检查时间窗口内高风险操作数，超阈值即熔断
 *  - 内存存储 + 可选持久化钩子（如落盘文件），不耦合具体 IO 实现
 *
 * 所有审计条目均带时间戳与全局唯一 ID；风险等级从 info 到 critical 五级，
 * critical 代表需要立即人工介入的合规风险事件。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 审计条目类别 */
export type AuditCategory =
  'llm_call' | 'tool_call' | 'trade_signal' | 'data_access' | 'user_query' | 'system';

/** 风险等级（从低到高） */
export type RiskLevel = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** 审计条目 */
export interface AuditEntry {
  /** 全局唯一 ID */
  id: string;
  /** 时间戳（epoch 毫秒） */
  timestamp: number;
  /** 会话 ID */
  sessionId: string;
  /** 用户 ID（可选） */
  userId?: string;
  /** 动作标识（简短，如 "llm.chat" / "tool.run_analysis"） */
  action: string;
  /** 审计类别 */
  category: AuditCategory;
  /** 人类可读的详细描述 */
  detail: string;
  /** 风险等级 */
  riskLevel: RiskLevel;
  /** 链路追踪 ID（可选，用于跨服务关联） */
  traceId?: string;
  /** 附加元数据（任意结构化数据，如模型名、参数、结果摘要等） */
  metadata?: Record<string, unknown>;
}

/** log() 方法输入：除 id/timestamp 外必填（自动生成），id/timestamp 可选覆盖 */
export type AuditLogInput = Omit<AuditEntry, 'id' | 'timestamp'> &
  Partial<Pick<AuditEntry, 'id' | 'timestamp'>>;

/** 查询过滤条件 */
export interface AuditQueryFilter {
  /** 起始时间（epoch 毫秒，含） */
  startTime?: number;
  /** 结束时间（epoch 毫秒，含） */
  endTime?: number;
  /** 按类别过滤（单个或多个） */
  category?: AuditCategory | AuditCategory[];
  /** 按风险等级过滤（单个或多个） */
  riskLevel?: RiskLevel | RiskLevel[];
  /** 按会话 ID 过滤 */
  sessionId?: string;
  /** 按用户 ID 过滤 */
  userId?: string;
  /** 按链路追踪 ID 过滤 */
  traceId?: string;
}

/** 熔断阈值配置 */
export interface CircuitBreakerThresholds {
  /** 检查时间窗口（毫秒），默认 5 分钟 */
  windowMs: number;
  /** 窗口内 critical 条目数上限，超过即熔断（默认 3） */
  criticalThreshold: number;
  /** 窗口内 high 条目数上限，超过即熔断（默认 10） */
  highThreshold: number;
}

/** 熔断检查结果 */
export interface CircuitBreakerResult {
  /** 是否熔断 */
  tripped: boolean;
  /** 熔断原因（tripped=true 时提供） */
  reason?: string;
  /** 检查时间窗口（毫秒） */
  windowMs: number;
  /** 窗口内 critical 条目数 */
  criticalCount: number;
  /** 窗口内 high 条目数 */
  highCount: number;
  /** 窗口内高风险条目总数（critical + high） */
  totalHighRiskCount: number;
  /** 检查时刻（epoch 毫秒） */
  checkedAt: number;
}

/** 持久化钩子：每条审计条目写入内存后调用（如落盘文件） */
export type PersistenceHook = (entry: AuditEntry) => void;

/** 默认熔断阈值：5 分钟内 >3 个 critical 或 >10 个 high 即熔断 */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLDS: CircuitBreakerThresholds = {
  windowMs: 5 * 60 * 1000,
  criticalThreshold: 3,
  highThreshold: 10,
};

/** 高风险等级集合（用于 getHighRiskEntries） */
const HIGH_RISK_LEVELS: ReadonlySet<RiskLevel> = new Set<RiskLevel>(['high', 'critical']);

/** 将单个值或数组归一化为数组（undefined 返回 undefined） */
function normalizeArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** AuditLogger 构造选项 */
export interface AuditLoggerOptions {
  /** 持久化钩子：每条审计条目写入内存后调用（如落盘文件） */
  persistenceHook?: PersistenceHook;
  /** 熔断阈值配置（部分覆盖默认值） */
  thresholds?: Partial<CircuitBreakerThresholds>;
  /** 时间来源（测试可注入），默认 Date.now */
  now?: () => number;
  /** ID 生成器（测试可注入），默认 crypto.randomUUID */
  generateId?: () => string;
  /** 内存存储上限（条），超过后自动丢弃最旧条目（默认 10000） */
  maxEntries?: number;
}

/**
 * 合规审计日志记录器
 * ----------------------------------------------------------------------------
 * 内存存储审计条目，支持查询、导出、高风险检索与运行时即时熔断检查。
 * 通过持久化钩子可扩展为落盘存储，IO 错误静默降级不阻断审计主流程。
 */
export class AuditLogger {
  private entries: AuditEntry[] = [];
  private readonly thresholds: CircuitBreakerThresholds;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly maxEntries: number;
  private readonly persistenceHook?: PersistenceHook;

  constructor(options: AuditLoggerOptions = {}) {
    this.thresholds = { ...DEFAULT_CIRCUIT_BREAKER_THRESHOLDS, ...options.thresholds };
    this.now = options.now ?? (() => Date.now());
    this.generateId = options.generateId ?? (() => randomUUID());
    this.maxEntries = options.maxEntries ?? 10000;
    this.persistenceHook = options.persistenceHook;
  }

  /**
   * 记录审计条目
   * @param entry 审计条目（id/timestamp 自动生成，可覆盖）
   * @returns 完整审计条目（含生成的 id 和 timestamp）
   */
  log(entry: AuditLogInput): AuditEntry {
    const full: AuditEntry = {
      id: entry.id ?? this.generateId(),
      timestamp: entry.timestamp ?? this.now(),
      sessionId: entry.sessionId,
      userId: entry.userId,
      action: entry.action,
      category: entry.category,
      detail: entry.detail,
      riskLevel: entry.riskLevel,
      traceId: entry.traceId,
      metadata: entry.metadata,
    };
    this.entries.push(full);
    // 超过上限：丢弃最旧条目（保持最近 maxEntries 条）
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    // 持久化钩子（如落盘）；钩子内部错误不阻断审计主流程
    if (this.persistenceHook) {
      try {
        this.persistenceHook(full);
      } catch {
        // 持久化失败：静默降级，审计日志仍保留在内存中
      }
    }
    return full;
  }

  /**
   * 按条件查询审计条目
   * @param filter 过滤条件（所有条件取交集）
   * @returns 匹配的审计条目数组
   */
  query(filter: AuditQueryFilter): AuditEntry[] {
    const categories = normalizeArray(filter.category);
    const riskLevels = normalizeArray(filter.riskLevel);
    return this.entries.filter((e) => {
      if (filter.startTime !== undefined && e.timestamp < filter.startTime) return false;
      if (filter.endTime !== undefined && e.timestamp > filter.endTime) return false;
      if (categories !== undefined && !categories.includes(e.category)) return false;
      if (riskLevels !== undefined && !riskLevels.includes(e.riskLevel)) return false;
      if (filter.sessionId !== undefined && e.sessionId !== filter.sessionId) return false;
      if (filter.userId !== undefined && e.userId !== filter.userId) return false;
      if (filter.traceId !== undefined && e.traceId !== filter.traceId) return false;
      return true;
    });
  }

  /**
   * 导出审计日志为 JSON 字符串
   * @param sessionId 指定会话 ID 时仅导出该会话条目，否则导出全部
   * @returns JSON 字符串（含 exportedAt、count、entries）
   */
  export(sessionId?: string): string {
    const entries =
      sessionId !== undefined
        ? this.entries.filter((e) => e.sessionId === sessionId)
        : this.entries;
    return JSON.stringify(
      {
        exportedAt: new Date(this.now()).toISOString(),
        count: entries.length,
        entries,
      },
      null,
      2,
    );
  }

  /**
   * 获取高风险条目（high + critical），用于熔断判断
   * @param since 起始时间（epoch 毫秒），仅返回此时间之后的条目
   * @returns 高风险审计条目数组
   */
  getHighRiskEntries(since?: number): AuditEntry[] {
    return this.entries.filter((e) => {
      if (!HIGH_RISK_LEVELS.has(e.riskLevel)) return false;
      if (since !== undefined && e.timestamp < since) return false;
      return true;
    });
  }

  /**
   * 运行时即时熔断检查
   * ----------------------------------------------------------------------------
   * 检查最近 windowMs 毫秒内的高风险操作数，超过阈值即返回 tripped=true。
   * 符合 2026-06 国家金融监管总局 8 号文"运行时即时熔断"要求。
   *
   * @param sessionId 指定会话 ID 时仅检查该会话，否则检查全部
   * @returns 熔断检查结果（含 tripped、reason、各等级计数）
   */
  checkCircuitBreaker(sessionId?: string): CircuitBreakerResult {
    const now = this.now();
    const windowStart = now - this.thresholds.windowMs;
    let criticalCount = 0;
    let highCount = 0;
    for (const e of this.entries) {
      // 窗口外的条目不计入
      if (e.timestamp < windowStart) continue;
      // 指定会话时不匹配的条目跳过
      if (sessionId !== undefined && e.sessionId !== sessionId) continue;
      if (e.riskLevel === 'critical') {
        criticalCount++;
      } else if (e.riskLevel === 'high') {
        highCount++;
      }
    }
    const totalHighRiskCount = criticalCount + highCount;
    let tripped = false;
    let reason: string | undefined;
    if (criticalCount > this.thresholds.criticalThreshold) {
      tripped = true;
      reason = `时间窗口(${this.thresholds.windowMs}ms)内 critical 级审计条目 ${criticalCount} 条，超过阈值 ${this.thresholds.criticalThreshold}`;
    } else if (highCount > this.thresholds.highThreshold) {
      tripped = true;
      reason = `时间窗口(${this.thresholds.windowMs}ms)内 high 级审计条目 ${highCount} 条，超过阈值 ${this.thresholds.highThreshold}`;
    }
    return {
      tripped,
      reason,
      windowMs: this.thresholds.windowMs,
      criticalCount,
      highCount,
      totalHighRiskCount,
      checkedAt: now,
    };
  }

  /** 清空所有审计条目（测试/管理用） */
  clear(): void {
    this.entries = [];
  }

  /** 当前审计条目总数 */
  size(): number {
    return this.entries.length;
  }

  /** 获取当前熔断阈值配置（只读副本） */
  getThresholds(): CircuitBreakerThresholds {
    return { ...this.thresholds };
  }
}

/** 审计日志默认落盘路径（JSON 行追加） */
const DEFAULT_AUDIT_LOG_FILE = path.join(import.meta.dirname, '..', 'data', 'audit.log');

/**
 * 运行时解析落盘路径：支持 AUDIT_LOG_FILE 环境变量重定向（与 watchlist/paper 同模式）。
 * 在「每次调用时」解析，测试可在 beforeAll 设置临时路径实现进程级隔离。
 */
function resolveAuditLogFile(): string {
  return process.env.AUDIT_LOG_FILE && process.env.AUDIT_LOG_FILE.length > 0
    ? process.env.AUDIT_LOG_FILE
    : DEFAULT_AUDIT_LOG_FILE;
}

/** 兼容导出：默认落盘路径（生产路径；测试应改用 resolveAuditLogFile 对应的 env 重定向） */
export const AUDIT_LOG_FILE = DEFAULT_AUDIT_LOG_FILE;

/**
 * 默认落盘持久化钩子：把每条审计条目追加为一行 JSON。
 * IO 失败静默降级（审计主流程不受影响，条目仍保留在内存中）。
 */
export function filePersistenceHook(entry: AuditEntry): void {
  try {
    const file = resolveAuditLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // 磁盘写入失败：静默降级，审计日志仍保留在内存中
  }
}

/** 全局审计日志单例（已配置落盘持久化钩子，满足合规留痕要求） */
export const auditLogger = new AuditLogger({ persistenceHook: filePersistenceHook });

// ============================================================================
// 辅助函数：为常见审计场景提供便捷入口，均写入全局 auditLogger 单例
// ============================================================================

/**
 * 审计 LLM 调用
 * @param sessionId 会话 ID
 * @param model 模型名称（如 "gpt-4" / "doubao-pro"）
 * @param prompt 输入提示词
 * @param response 模型响应
 * @param riskLevel 风险等级（默认 low）
 */
export function auditLLMCall(
  sessionId: string,
  model: string,
  prompt: string,
  response: string,
  riskLevel: RiskLevel = 'low',
): AuditEntry {
  return auditLogger.log({
    sessionId,
    action: 'llm.chat',
    category: 'llm_call',
    detail: `LLM 调用: model=${model}`,
    riskLevel,
    metadata: { model, prompt, response },
  });
}

/**
 * 审计工具调用
 * @param sessionId 会话 ID
 * @param toolName 工具名称（如 "run_analysis" / "run_backtest"）
 * @param args 调用参数
 * @param result 调用结果
 * @param riskLevel 风险等级（默认 low）
 */
export function auditToolCall(
  sessionId: string,
  toolName: string,
  args: unknown,
  result: unknown,
  riskLevel: RiskLevel = 'low',
): AuditEntry {
  return auditLogger.log({
    sessionId,
    action: `tool.${toolName}`,
    category: 'tool_call',
    detail: `工具调用: ${toolName}`,
    riskLevel,
    metadata: { toolName, args, result },
  });
}

/**
 * 审计交易信号
 * @param sessionId 会话 ID
 * @param stockCode 股票代码
 * @param signal 信号内容（如 "买入" / "强烈卖出"）
 * @param reasoning 决策依据
 */
export function auditTradeSignal(
  sessionId: string,
  stockCode: string,
  signal: string,
  reasoning: string,
): AuditEntry {
  // 交易信号涉及投资建议，默认中等风险
  // 强烈信号（强烈买入/卖出、重仓、清仓等）提升为高风险，符合合规审计审慎原则
  const isStrong = /强烈|重仓|全仓|清仓|紧急/i.test(signal);
  return auditLogger.log({
    sessionId,
    action: 'trade.signal',
    category: 'trade_signal',
    detail: `${stockCode} 交易信号: ${signal}`,
    riskLevel: isStrong ? 'high' : 'medium',
    metadata: { stockCode, signal, reasoning },
  });
}

/**
 * 审计数据访问
 * @param sessionId 会话 ID
 * @param resource 资源标识（如 "财务数据库" / "行情接口"）
 * @param action 操作类型（如 "read" / "write" / "export"）
 */
export function auditDataAccess(sessionId: string, resource: string, action: string): AuditEntry {
  return auditLogger.log({
    sessionId,
    action: `data.${action}`,
    category: 'data_access',
    detail: `数据访问: ${resource} (${action})`,
    riskLevel: 'info',
    metadata: { resource, action },
  });
}

/**
 * 轻量 OpenTelemetry-style 全链路追踪模块
 * ----------------------------------------------------------------------------
 * 提供 span / trace / context 的最小可用实现，满足以下诉求：
 *  - 跨函数、跨异步边界的调用链追踪（traceId 串联、parentSpanId 串联）；
 *  - HTTP 请求自动注入 root span 与 X-Trace-Id 响应头；
 *  - LLM 调用成本与 token 用量记录（与 ./llm/cost.ts 联动）；
 *  - 内存态存储 + 可插拔 exportHook（上报到 console / 文件 / Langfuse 等）。
 *
 * 设计取舍：纯 TypeScript、零外部依赖；不与 OpenTelemetry SDK 强绑定，
 * 但语义对齐 OTel（span / event / attribute / status），便于后续平滑迁移。
 */
import type { Request, Response, NextFunction } from 'express';
import { recordUsage, type CostEntry } from '../llm/cost.js';
import logger from '../utils/logger.js';

/** Span 状态：对齐 OTel SpanStatus 枚举子集 */
export type SpanStatus = 'unset' | 'ok' | 'error';

/** 单个事件：命名时间戳 + 可选属性 */
export interface TelemetryEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

/** 一个 span：追踪的最小单元 */
export interface TelemetrySpan {
  /** 所属 trace 的全局唯一 ID */
  traceId: string;
  /** 当前 span 的唯一 ID */
  spanId: string;
  /** 父 span ID；root span 为 null */
  parentSpanId: string | null;
  /** span 名称（建议用动词 + 资源，如 "llm.chat" / "http.request"） */
  name: string;
  /** 起始时间戳（ms） */
  startTime: number;
  /** 结束时间戳（ms）；未结束时为 null */
  endTime: number | null;
  /** 持续时长（ms）；未结束时为 null */
  durationMs: number | null;
  /** 终止状态 */
  status: SpanStatus;
  /** 业务属性（任意键值） */
  attributes: Record<string, unknown>;
  /** 关键事件流 */
  events: TelemetryEvent[];
}

/** 跨函数传递的最小上下文：traceId + spanId */
export interface TraceContext {
  traceId: string;
  spanId: string;
}

/** 导出 hook 入参：单个 span 完成时回调 */
export interface ExportHook {
  (span: TelemetrySpan): void;
}

/** Tracer 配置项 */
export interface TracerOptions {
  /** span 完成时触发的导出回调（可叠加多处上报） */
  exportHook?: ExportHook;
  /** 是否在导出时同时打印到 console；默认 false */
  logToConsole?: boolean;
}

/**
 * 生成 16 进制随机 ID（无 crypto 依赖；优先用 Web Crypto，回退 Math.random）
 * @param length 字节数（最终 hex 长度为 length*2）
 */
function randomHexId(length: number): string {
  const bytes = new Uint8Array(length);
  const cryptoObj = globalThis.crypto as
    { getRandomValues?: (arr: Uint8Array) => Uint8Array } | undefined;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 生成 traceId（32 hex / 16 字节，对齐 OTel） */
function newTraceId(): string {
  return randomHexId(16);
}

/** 生成 spanId（16 hex / 8 字节，对齐 OTel） */
function newSpanId(): string {
  return randomHexId(8);
}

/**
 * 全链路追踪器
 * ----------------------------------------------------------------------------
 * 单实例即可全局复用；通过 configureTracer / getTracer 控制单例。
 * 内存中以 Map<traceId, TelemetrySpan[]> 组织，便于 getTrace / exportTrace。
 */
export class TelemetryTracer {
  private readonly store = new Map<string, TelemetrySpan[]>();
  private readonly exportHook?: ExportHook;
  private readonly logToConsole: boolean;

  constructor(options: TracerOptions = {}) {
    this.exportHook = options.exportHook;
    this.logToConsole = options.logToConsole ?? false;
  }

  /**
   * 创建并启动一个 span。
   * @param name span 名称
   * @param parentCtx 父上下文；不传则视为 root span（同时新建 traceId）
   * @returns { span, ctx } —— span 用于后续 addEvent/setAttribute/endSpan；ctx 用于跨函数传递
   */
  startSpan(name: string, parentCtx?: TraceContext): { span: TelemetrySpan; ctx: TraceContext } {
    const traceId = parentCtx?.traceId ?? newTraceId();
    const spanId = newSpanId();
    const span: TelemetrySpan = {
      traceId,
      spanId,
      parentSpanId: parentCtx?.spanId ?? null,
      name,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      status: 'unset',
      attributes: {},
      events: [],
    };
    const list = this.store.get(traceId);
    if (list) list.push(span);
    else this.store.set(traceId, [span]);
    return { span, ctx: { traceId, spanId } };
  }

  /**
   * 结束 span：写入 endTime / durationMs / status，并触发导出 hook。
   * 重复结束会被忽略（幂等），避免双计。
   */
  endSpan(span: TelemetrySpan, status: SpanStatus = 'ok'): void {
    if (span.endTime !== null) return; // 幂等
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;
    this.export(span);
  }

  /** 给 span 添加一个事件（带可选属性） */
  addEvent(span: TelemetrySpan, eventName: string, attrs?: Record<string, unknown>): void {
    span.events.push({
      name: eventName,
      timestamp: Date.now(),
      attributes: attrs,
    });
  }

  /** 给 span 设置单个属性（覆盖同名旧值） */
  setAttribute(span: TelemetrySpan, key: string, value: unknown): void {
    span.attributes[key] = value;
  }

  /** 获取整个 trace 的所有 span（按创建顺序） */
  getTrace(traceId: string): TelemetrySpan[] {
    return this.store.get(traceId) ?? [];
  }

  /** 导出整个 trace 为可序列化的 JSON（供日志 / 外部上报） */
  exportTrace(traceId: string): string {
    return JSON.stringify({
      traceId,
      spans: this.getTrace(traceId),
    });
  }

  /** 清空所有 trace（测试用；生产慎用） */
  reset(): void {
    this.store.clear();
  }

  /**
   * 记录一次 LLM 调用的成本与 token 用量。
   * 与 ./llm/cost.ts 联动：内部调用 recordUsage 落账，同时把用量作为事件挂到指定 span。
   * @returns 返回 cost.ts 的 CostEntry，便于上层进一步处理
   */
  recordLLMCall(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cost: number,
    span?: TelemetrySpan,
  ): CostEntry {
    const entry = recordUsage(model, promptTokens, completionTokens, { cost });
    if (span) {
      span.events.push({
        name: 'llm.call',
        timestamp: Date.now(),
        attributes: {
          model,
          promptTokens,
          completionTokens,
          cost,
          totalTokens: promptTokens + completionTokens,
          recordedAt: entry.at,
        },
      });
      // 累计到 span 属性，便于聚合查看
      const prevPrompt = (span.attributes['llm.promptTokens'] as number | undefined) ?? 0;
      const prevCompletion = (span.attributes['llm.completionTokens'] as number | undefined) ?? 0;
      const prevCost = (span.attributes['llm.cost'] as number | undefined) ?? 0;
      const prevCallCount = (span.attributes['llm.callCount'] as number | undefined) ?? 0;
      span.attributes['llm.promptTokens'] = prevPrompt + promptTokens;
      span.attributes['llm.completionTokens'] = prevCompletion + completionTokens;
      span.attributes['llm.cost'] = Math.round((prevCost + cost) * 1e6) / 1e6;
      span.attributes['llm.callCount'] = prevCallCount + 1;
    }
    return entry;
  }

  /** 触发导出：默认 hook + console（可选） */
  private export(span: TelemetrySpan): void {
    if (this.logToConsole) {
      // 控制台精简输出，避免噪声；详细数据走 exportTrace / exportHook
      logger.info(
        `[telemetry] trace=${span.traceId.slice(0, 8)} span=${span.name} ` +
          `dur=${span.durationMs}ms status=${span.status} events=${span.events.length}`,
      );
    }
    this.exportHook?.(span);
  }
}

// ============================================================================
// 全局单例管理
// ============================================================================

let globalTracer: TelemetryTracer | null = null;

/** 获取全局 tracer；未配置时返回默认实例（内存态、无 hook） */
export function getTracer(): TelemetryTracer {
  if (!globalTracer) globalTracer = new TelemetryTracer();
  return globalTracer;
}

/** 配置全局 tracer（覆盖默认）；返回新实例 */
export function configureTracer(options: TracerOptions): TelemetryTracer {
  globalTracer = new TelemetryTracer(options);
  return globalTracer;
}

/** 重置全局 tracer（测试用） */
export function resetGlobalTracer(): void {
  globalTracer = null;
}

// ============================================================================
// 高阶辅助：withSpan
// ============================================================================

/**
 * 自动追踪 async 函数的高阶辅助。
 * - 自动 start / end；
 * - 抛错时记录 status='error' 并把错误信息写入属性，再向上抛出；
 * - 返回值透传 fn 的返回值。
 *
 * @param name span 名称
 * @param fn 待追踪的异步函数（接收 ctx 用于下传）
 * @param parentCtx 父上下文
 */
export async function withSpan<T>(
  name: string,
  fn: (ctx: TraceContext, span: TelemetrySpan) => Promise<T>,
  parentCtx?: TraceContext,
): Promise<T> {
  const tracer = getTracer();
  const { span, ctx } = tracer.startSpan(name, parentCtx);
  try {
    const result = await fn(ctx, span);
    tracer.endSpan(span, 'ok');
    return result;
  } catch (err) {
    span.attributes['error'] = err instanceof Error ? err.message : String(err);
    span.attributes['error.type'] = err instanceof Error ? err.name : 'unknown';
    tracer.endSpan(span, 'error');
    throw err;
  }
}

// ============================================================================
// Express 中间件
// ============================================================================

/**
 * Express 中间件：自动为每个 HTTP 请求创建 root span，
 * 注入 traceId 到响应头 X-Trace-Id；请求结束时自动 end span。
 *
 * 用法：app.use(expressTracerMiddleware())
 *
 * 通过 res.locals.traceContext 暴露上下文，下游处理函数可读取并下传到 service 层。
 */
export function expressTracerMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tracer = getTracer();
    // 路由名：method + 原始 URL，便于在 trace 中识别
    const spanName = `http.${req.method.toLowerCase()}`;
    const { span, ctx } = tracer.startSpan(spanName);
    span.attributes['http.method'] = req.method;
    span.attributes['http.url'] = req.originalUrl ?? req.url;
    span.attributes['http.path'] = req.path;
    if (req.ip) span.attributes['http.ip'] = req.ip;

    // 暴露上下文给下游
    res.locals.traceContext = ctx;
    res.locals.traceSpan = span;

    // 响应头注入 traceId，便于客户端 / 日志关联
    res.setHeader('X-Trace-Id', ctx.traceId);

    // 响应结束时记录状态码并 end span
    res.on('finish', () => {
      span.attributes['http.statusCode'] = res.statusCode;
      const status: SpanStatus =
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'error' : 'ok';
      tracer.endSpan(span, status);
    });

    next();
  };
}

/** 从 Express Response 中取出 trace 上下文（便于 service 层下传） */
export function getReqTraceContext(res: Response): TraceContext | undefined {
  return (res.locals as { traceContext?: TraceContext }).traceContext;
}

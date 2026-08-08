import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TelemetryTracer,
  getTracer,
  configureTracer,
  resetGlobalTracer,
  withSpan,
  expressTracerMiddleware,
  type TelemetrySpan,
  type TraceContext,
} from '../telemetry.js';
import { resetCostTracker, getCostReport } from '../../llm/cost.js';

// 每个用例独立的 tracer 实例，避免相互污染；同时清理全局单例与成本账本
beforeEach(() => {
  resetGlobalTracer();
  resetCostTracker();
});

afterEach(() => {
  resetGlobalTracer();
  resetCostTracker();
});

describe('TelemetryTracer — span 创建/结束/持续时间', () => {
  it('startSpan 创建未结束的 span，endTime/durationMs 为 null', () => {
    const tracer = new TelemetryTracer();
    const { span, ctx } = tracer.startSpan('test.span');
    expect(span.name).toBe('test.span');
    expect(span.startTime).toBeTypeOf('number');
    expect(span.endTime).toBeNull();
    expect(span.durationMs).toBeNull();
    expect(span.status).toBe('unset');
    expect(span.attributes).toEqual({});
    expect(span.events).toEqual([]);
    expect(span.parentSpanId).toBeNull();
    // ctx 用于跨函数传递：traceId 与 spanId 应与 span 一致
    expect(ctx.traceId).toBe(span.traceId);
    expect(ctx.spanId).toBe(span.spanId);
  });

  it('endSpan 写入 endTime/durationMs 并设置 status', async () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('work');
    // 让 duration 非零（fake timers 下 Date.now 不会推进，故用真实延时）
    await new Promise((r) => setTimeout(r, 5));
    tracer.endSpan(span, 'ok');
    expect(span.endTime).toBeTypeOf('number');
    expect(span.endTime).toBeGreaterThanOrEqual(span.startTime);
    expect(span.durationMs).toBe(span.endTime! - span.startTime);
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
    expect(span.status).toBe('ok');
  });

  it('endSpan 默认状态为 ok', () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('s');
    tracer.endSpan(span);
    expect(span.status).toBe('ok');
  });

  it('endSpan 幂等：重复结束不会重新计算 duration', () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('s');
    tracer.endSpan(span, 'ok');
    const firstEnd = span.endTime;
    const firstDur = span.durationMs;
    tracer.endSpan(span, 'error'); // 应被忽略
    expect(span.endTime).toBe(firstEnd);
    expect(span.durationMs).toBe(firstDur);
    expect(span.status).toBe('ok'); // 不被覆盖
  });

  it('traceId/spanId 格式：32/16 hex 字符', () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('s');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('TelemetryTracer — parent-child 关系', () => {
  it('root span 的 parentSpanId 为 null；child 串联 parent', () => {
    const tracer = new TelemetryTracer();
    const { span: parent, ctx: parentCtx } = tracer.startSpan('parent');
    const { span: child } = tracer.startSpan('child', parentCtx);

    expect(parent.parentSpanId).toBeNull();
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.traceId).toBe(parent.traceId);
    expect(parentCtx.spanId).toBe(parent.spanId);
  });

  it('getTrace 返回同一 traceId 的所有 span（按创建顺序）', () => {
    const tracer = new TelemetryTracer();
    const { span: root, ctx: rootCtx } = tracer.startSpan('root');
    const { ctx: l1Ctx } = tracer.startSpan('l1', rootCtx);
    tracer.startSpan('l2-a', l1Ctx);
    tracer.startSpan('l2-b', l1Ctx);

    const spans = tracer.getTrace(root.traceId);
    expect(spans.map((s) => s.name)).toEqual(['root', 'l1', 'l2-a', 'l2-b']);
    // 所有 span 共享 traceId
    expect(spans.every((s) => s.traceId === root.traceId)).toBe(true);
  });

  it('不同 root span 拥有不同 traceId', () => {
    const tracer = new TelemetryTracer();
    const { span: a } = tracer.startSpan('a');
    const { span: b } = tracer.startSpan('b');
    expect(a.traceId).not.toBe(b.traceId);
    expect(tracer.getTrace(a.traceId).length).toBe(1);
    expect(tracer.getTrace(b.traceId).length).toBe(1);
  });

  it('getTrace 不存在的 traceId 返回空数组', () => {
    const tracer = new TelemetryTracer();
    expect(tracer.getTrace('nonexistent')).toEqual([]);
  });
});

describe('TelemetryTracer — withSpan 自动追踪', () => {
  it('成功路径：自动 start/end，状态 ok，返回值透传', async () => {
    const tracer = configureTracer({});
    const result = await withSpan('async.work', async (ctx, span) => {
      expect(span.endTime).toBeNull(); // 执行中未结束
      expect(ctx.spanId).toBe(span.spanId);
      return 42;
    });
    expect(result).toBe(42);

    // 全局 tracer 应记录该 span
    const spans = tracer.getTrace(spansOf(tracer, 'async.work')[0].traceId);
    const target = spans.find((s) => s.name === 'async.work')!;
    expect(target.status).toBe('ok');
    expect(target.endTime).not.toBeNull();
    expect(target.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('错误路径：状态 error，错误信息写入属性，异常向上抛出', async () => {
    configureTracer({});
    await expect(
      withSpan('failing', async (_ctx, span) => {
        // span.attributes 是可变 Record，可直接写入（生产中推荐用 tracer.setAttribute）
        span.attributes['phase'] = 'mid';
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 通过 exportTrace / getTrace 校验 span 已被记录并标记错误
    const tracer = getTracer();
    // 找到 failing span（全局 tracer 中）
    const allTraceIds = Array.from(
      (tracer as unknown as { store: Map<string, TelemetrySpan[]> }).store.keys(),
    );
    const trace = tracer.getTrace(allTraceIds[0]);
    const failing = trace.find((s) => s.name === 'failing')!;
    expect(failing.status).toBe('error');
    expect(failing.attributes['error']).toBe('boom');
    expect(failing.attributes['error.type']).toBe('Error');
    expect(failing.attributes['phase']).toBe('mid');
    expect(failing.endTime).not.toBeNull();
  });

  it('parentCtx 下传：子 span 串到父 trace', async () => {
    const tracer = configureTracer({});
    const { span: parent, ctx: parentCtx } = tracer.startSpan('parent');
    await withSpan(
      'child',
      async (childCtx) => {
        expect(childCtx.traceId).toBe(parentCtx.traceId);
        return 'done';
      },
      parentCtx,
    );
    const spans = tracer.getTrace(parent.traceId);
    expect(spans.map((s) => s.name)).toEqual(['parent', 'child']);
    const child = spans.find((s) => s.name === 'child')!;
    expect(child.parentSpanId).toBe(parent.spanId);
  });
});

describe('TelemetryTracer — trace 导出', () => {
  it('exportTrace 返回包含 traceId 与 spans 的合法 JSON', () => {
    const tracer = new TelemetryTracer();
    const { span: root, ctx } = tracer.startSpan('root');
    tracer.setAttribute(root, 'kind', 'root');
    tracer.startSpan('child', ctx);
    tracer.endSpan(root);

    const json = tracer.exportTrace(root.traceId);
    const parsed = JSON.parse(json) as { traceId: string; spans: TelemetrySpan[] };
    expect(parsed.traceId).toBe(root.traceId);
    expect(parsed.spans.length).toBe(2);
    expect(parsed.spans.map((s) => s.name)).toEqual(['root', 'child']);
    // span 字段完整可序列化
    const sample = parsed.spans[0];
    expect(sample).toHaveProperty('traceId');
    expect(sample).toHaveProperty('spanId');
    expect(sample).toHaveProperty('parentSpanId');
    expect(sample).toHaveProperty('startTime');
    expect(sample).toHaveProperty('endTime');
    expect(sample).toHaveProperty('durationMs');
    expect(sample).toHaveProperty('status');
    expect(sample).toHaveProperty('attributes');
    expect(sample).toHaveProperty('events');
  });

  it('exportHook 在 span 结束时被回调', () => {
    const exported: TelemetrySpan[] = [];
    const tracer = new TelemetryTracer({ exportHook: (s) => exported.push(s) });
    const { span } = tracer.startSpan('hooked');
    tracer.endSpan(span);
    expect(exported.length).toBe(1);
    expect(exported[0]).toBe(span);
  });

  it('logToConsole 在 span 结束时输出精简日志', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracer = new TelemetryTracer({ logToConsole: true });
    const { span } = tracer.startSpan('logged');
    tracer.endSpan(span);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toContain('[telemetry]');
    expect(line).toContain('span=logged');
    expect(line).toContain('status=ok');
    logSpy.mockRestore();
  });
});

describe('TelemetryTracer — 事件和属性', () => {
  it('addEvent 追加事件并带时间戳与属性', () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('s');
    tracer.addEvent(span, 'hit-cache');
    tracer.addEvent(span, 'llm.called', { model: 'gpt-4o', tokens: 120 });
    expect(span.events.length).toBe(2);
    expect(span.events[0]).toEqual({
      name: 'hit-cache',
      timestamp: expect.any(Number),
      attributes: undefined,
    });
    expect(span.events[1].name).toBe('llm.called');
    expect(span.events[1].attributes).toEqual({ model: 'gpt-4o', tokens: 120 });
    expect(span.events[1].timestamp).toBeTypeOf('number');
  });

  it('setAttribute 写入并覆盖同名属性', () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('s');
    tracer.setAttribute(span, 'user.id', 'u1');
    tracer.setAttribute(span, 'retry', 0);
    expect(span.attributes['user.id']).toBe('u1');
    expect(span.attributes['retry']).toBe(0);
    tracer.setAttribute(span, 'retry', 1); // 覆盖
    expect(span.attributes['retry']).toBe(1);
  });

  it('属性支持任意 JSON 可序列化值', () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('s');
    tracer.setAttribute(span, 'meta', { a: 1, list: [1, 2] });
    expect(span.attributes['meta']).toEqual({ a: 1, list: [1, 2] });
    // 确认可序列化（exportTrace 不会抛错）
    expect(() => tracer.exportTrace(span.traceId)).not.toThrow();
  });
});

describe('TelemetryTracer — 成本记录（与 cost.ts 联动）', () => {
  it('recordLLMCall 落账到 cost.ts 并返回 CostEntry', () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('llm.chat');
    const entry = tracer.recordLLMCall('gpt-4o', 100, 50, 0.012, span);

    expect(entry.model).toBe('gpt-4o');
    expect(entry.promptTokens).toBe(100);
    expect(entry.completionTokens).toBe(50);
    expect(entry.cost).toBe(0.012);

    // cost.ts 账本同步更新
    const report = getCostReport();
    expect(report.callCount).toBe(1);
    expect(report.totalPromptTokens).toBe(100);
    expect(report.totalCompletionTokens).toBe(50);
    expect(report.totalCost).toBeCloseTo(0.012, 6);
    expect(report.byModel['gpt-4o']).toEqual({ cost: 0.012, calls: 1 });
  });

  it('recordLLMCall 在 span 上挂载事件与累计属性', () => {
    const tracer = new TelemetryTracer();
    const { span } = tracer.startSpan('llm.chat');
    tracer.recordLLMCall('gpt-4o', 100, 50, 0.01, span);
    tracer.recordLLMCall('gpt-4o', 200, 80, 0.02, span);

    // 累计属性
    expect(span.attributes['llm.callCount']).toBe(2);
    expect(span.attributes['llm.promptTokens']).toBe(300);
    expect(span.attributes['llm.completionTokens']).toBe(130);
    expect(span.attributes['llm.cost']).toBeCloseTo(0.03, 6);

    // 每次调用都追加一个 llm.call 事件
    const llmEvents = span.events.filter((e) => e.name === 'llm.call');
    expect(llmEvents.length).toBe(2);
    expect(llmEvents[0].attributes).toMatchObject({
      model: 'gpt-4o',
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(llmEvents[1].attributes).toMatchObject({
      model: 'gpt-4o',
      promptTokens: 200,
      completionTokens: 80,
    });
  });

  it('recordLLMCall 不传 span 也能落账（仅成本记录）', () => {
    const tracer = new TelemetryTracer();
    const entry = tracer.recordLLMCall('claude', 10, 5, 0.001);
    expect(entry.model).toBe('claude');
    expect(getCostReport().callCount).toBe(1);
    // 不传 span 时不应创建任何 span
    const traceIds = Array.from(
      (tracer as unknown as { store: Map<string, TelemetrySpan[]> }).store.keys(),
    );
    // tracer 内部未通过 recordLLMCall 创建 span，但 startSpan 也没调用过
    expect(traceIds.length).toBe(0);
  });
});

describe('全局 tracer 单例', () => {
  it('getTracer 默认返回同一实例', () => {
    resetGlobalTracer();
    const a = getTracer();
    const b = getTracer();
    expect(a).toBe(b);
  });

  it('configureTracer 替换全局实例并返回新实例', () => {
    const original = getTracer();
    const configured = configureTracer({ logToConsole: false });
    expect(configured).not.toBe(original);
    expect(getTracer()).toBe(configured);
  });
});

describe('expressTracerMiddleware', () => {
  it('为每个请求创建 root span，注入 X-Trace-Id 响应头，结束时记录状态', async () => {
    configureTracer({});
    const tracer = getTracer();
    const middleware = expressTracerMiddleware();

    // 构造极简的 mock req/res/next
    const req = {
      method: 'GET',
      originalUrl: '/api/health',
      path: '/api/health',
      url: '/api/health',
      ip: '127.0.0.1',
    } as unknown as import('express').Request;
    const headers: Record<string, string | string[]> = {};
    const res = {
      statusCode: 200,
      locals: {} as Record<string, unknown>,
      setHeader: vi.fn((k: string, v: string | string[]) => {
        headers[k] = v;
      }),
      on: vi.fn((event: string, cb: () => void) => {
        // 立即注册；测试中手动触发 'finish'
        if (event === 'finish') (res as unknown as { __finish?: () => void }).__finish = cb;
      }),
    } as unknown as import('express').Response;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // 响应头注入 traceId
    expect(headers['X-Trace-Id']).toBeDefined();
    expect(typeof headers['X-Trace-Id']).toBe('string');

    // res.locals 暴露 traceContext
    const ctx = (res.locals as { traceContext: TraceContext }).traceContext;
    expect(ctx).toBeDefined();
    expect(ctx.traceId).toBe(headers['X-Trace-Id']);

    // span 已记录在 tracer 中（未结束）
    const spans = tracer.getTrace(ctx.traceId);
    expect(spans.length).toBe(1);
    const span = spans[0];
    expect(span.name).toBe('http.get');
    expect(span.attributes['http.method']).toBe('GET');
    expect(span.attributes['http.url']).toBe('/api/health');
    expect(span.attributes['http.ip']).toBe('127.0.0.1');
    expect(span.endTime).toBeNull(); // 未 finish

    // 触发响应结束
    (res as unknown as { __finish: () => void }).__finish();
    expect(span.endTime).not.toBeNull();
    expect(span.status).toBe('ok');
    expect(span.attributes['http.statusCode']).toBe(200);
  });

  it('4xx/5xx 状态码标记为 error', async () => {
    configureTracer({});
    const tracer = getTracer();
    const middleware = expressTracerMiddleware();

    for (const code of [400, 500]) {
      const req = {
        method: 'POST',
        originalUrl: '/x',
        path: '/x',
        url: '/x',
        ip: undefined,
      } as unknown as import('express').Request;
      const res = {
        statusCode: code,
        locals: {},
        setHeader: vi.fn(),
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'finish') (res as unknown as { __finish?: () => void }).__finish = cb;
        }),
      } as unknown as import('express').Response;
      middleware(req, res, vi.fn());
      (res as unknown as { __finish: () => void }).__finish();

      const ctx = (res.locals as { traceContext: TraceContext }).traceContext;
      const span = tracer.getTrace(ctx.traceId)[0];
      expect(span.status).toBe('error');
      expect(span.attributes['http.statusCode']).toBe(code);
    }
  });
});

// 辅助：从 tracer 中筛出指定 name 的 span（用于 withSpan 用例）
function spansOf(tracer: TelemetryTracer, name: string): TelemetrySpan[] {
  const store = (tracer as unknown as { store: Map<string, TelemetrySpan[]> }).store;
  const out: TelemetrySpan[] = [];
  for (const spans of store.values()) {
    for (const s of spans) if (s.name === name) out.push(s);
  }
  return out;
}

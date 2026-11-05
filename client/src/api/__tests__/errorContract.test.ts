/**
 * 前后端错误契约测试（DX 架构整改）
 * - normalizeApiError：错误对象完整携带服务端的 requestId / code / retryAfter，
 *   不再只留文案（服务端 429 的 Retry-After、错误体 code/requestId 此前全被丢弃）。
 * - SSE JSON 解析失败：产生可见错误事件并 console.error 记录，且不误终止事件流。
 * 错误体形状即后端真实契约（index.ts 统一错误中间件 / limitGate / analysis 路由）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeStockStream,
  ApiError,
  chatWithAgentStream,
  normalizeApiError,
  type AnalysisStage,
  type ChatStreamEvent,
} from '../client.js';
import type { AnalysisResult } from '../generated';

const axiosInst = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  interceptors: {
    request: { use: () => {} },
    response: { use: () => {} },
  },
}));
vi.mock('axios', () => ({ default: { create: () => axiosInst } }));

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emitRaw(raw: string) {
    this.onmessage?.({ data: raw });
  }
  emit(obj: unknown) {
    this.emitRaw(JSON.stringify(obj));
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeApiError 错误元数据契约', () => {
  it('429：携带 Retry-After 秒数与错误体 code/requestId（排队超时语义不丢）', () => {
    // 后端 limitGate 排队超时的真实响应形态
    const e = {
      response: {
        status: 429,
        headers: { 'retry-after': '12', 'x-request-id': 'req-abc-1' },
        data: { error: 'LLM 调用排队超时', code: 'LLM_QUEUE_TIMEOUT', requestId: 'req-body-1' },
      },
    };
    const err = normalizeApiError(e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('LLM 调用排队超时');
    expect(err.retryAfter).toBe(12);
    expect(err.code).toBe('LLM_QUEUE_TIMEOUT');
    expect(err.requestId).toBe('req-abc-1'); // 响应头优先于错误体
  });

  it('500：错误体 requestId/code 也能保留（无响应头时回退错误体）', () => {
    const e = {
      response: {
        status: 500,
        headers: {},
        data: { error: '服务器内部错误', requestId: 'req-500', code: 'INTERNAL' },
      },
    };
    const err = normalizeApiError(e);
    expect(err.requestId).toBe('req-500');
    expect(err.code).toBe('INTERNAL');
    expect(err.retryAfter).toBeUndefined();
  });

  it('AxiosHeaders 实例（get 方法）同样可提取', () => {
    const headers = {
      get: (name: string) =>
        name === 'x-request-id' ? 'req-axios' : name === 'retry-after' ? '3' : undefined,
    };
    const e = { response: { status: 429, headers, data: {} } };
    const err = normalizeApiError(e);
    expect(err.requestId).toBe('req-axios');
    expect(err.retryAfter).toBe(3);
  });

  it('无元数据时字段为 undefined（不编造）', () => {
    const err = normalizeApiError({ response: { status: 404, data: {} } });
    expect(err.requestId).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(err.retryAfter).toBeUndefined();
  });

  it('409 在途冲突：code 供调用方编程识别', () => {
    const e = {
      response: {
        status: 409,
        headers: {},
        data: { error: '该标的已有一次分析在进行中', code: 'ANALYSIS_IN_FLIGHT' },
      },
    };
    const err = normalizeApiError(e);
    expect(err.code).toBe('ANALYSIS_IN_FLIGHT');
  });
});

describe('SSE 解析失败可见化', () => {
  it('chatWithAgentStream：坏帧产生 error 事件并记录，后续正常事件流不受影响', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: ChatStreamEvent[] = [];
    chatWithAgentStream('你好', (evt) => events.push(evt));
    const es = MockEventSource.instances[0];

    es.emitRaw('{ not valid json'); // 坏帧：此前被静默吞掉
    expect(errorSpy).toHaveBeenCalledWith(
      '[chatStream] SSE 帧 JSON 解析失败',
      expect.objectContaining({ raw: '{ not valid json' }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('error');
    expect(events[0].message).toContain('解析失败');

    // 流未终止：后续正常进度与结束事件继续送达
    es.emit({ phase: 'planning', message: '规划中' });
    es.emit({ phase: 'error', message: '服务端主动结束' });
    expect(events.map((e) => e.phase)).toEqual(['error', 'planning', 'error']);
    expect(es.closed).toBe(true); // 收到结束帧后正常收尾
  });

  it('analyzeStockStream：坏帧回调 error 阶段事件，done 不被误 reject', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stages: AnalysisStage[] = [];
    const { done } = analyzeStockStream('600519', (s) => stages.push(s));
    const es = MockEventSource.instances[0];

    es.emitRaw('broken-frame');
    expect(errorSpy).toHaveBeenCalledWith(
      '[analyzeStream] SSE 帧 JSON 解析失败',
      expect.objectContaining({ raw: 'broken-frame' }),
    );
    expect(stages).toHaveLength(1);
    expect(stages[0].phase).toBe('error');
    expect(stages[0].message).toContain('解析失败');

    // 后续 done 帧正常完成：单帧解析失败不等于分析失败
    const result: AnalysisResult = {
      stock_pool: [],
      data_sources: [],
      research_confidence: '',
      limitation_explain: '',
    };
    es.emit({ phase: 'done', message: '完成', result });
    await expect(done).resolves.toEqual(result);
  });
});

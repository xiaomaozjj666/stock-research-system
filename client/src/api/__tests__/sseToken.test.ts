// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeStockStream, chatWithAgentStream } from '../client.js';

/**
 * SSE 侧的令牌注入。
 *
 * 契约：EventSource **不能**自定义请求头，因此令牌只能走 `?token=`。
 * 若这里回归，用户表现是「一启用鉴权，流式分析/对话就连接即断」，
 * 且看不出跟鉴权有关——这是本模块存在的唯一理由。
 */

// 与 client.test.ts 同理：桩必须带 interceptors（模块加载时会注册）
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
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  emitError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  localStorage.clear();
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
});

describe('SSE 令牌注入', () => {
  it('未解锁时 URL 不含 token（默认路径逐字不变）', () => {
    analyzeStockStream('600519', () => {}, { maxRetries: 0 });
    expect(MockEventSource.instances[0].url).not.toContain('token=');
    expect(MockEventSource.instances[0].url).toContain('stockCode=600519');
  });

  it('已解锁时 analyze 流带上 ?token=', () => {
    localStorage.setItem('srs:api-token', 'tok-a');
    analyzeStockStream('600519', () => {}, { maxRetries: 0 });
    expect(MockEventSource.instances[0].url).toContain('token=tok-a');
  });

  it('已解锁时 chat 流带上 ?token=', () => {
    localStorage.setItem('srs:api-token', 'tok-b');
    chatWithAgentStream('你好', () => {});
    expect(MockEventSource.instances[0].url).toContain('token=tok-b');
  });

  it('token 与既有 query 参数共存（不被覆盖）', () => {
    localStorage.setItem('srs:api-token', 'tok-c');
    analyzeStockStream('600519', () => {}, { maxRetries: 0, resume: true });
    const url = MockEventSource.instances[0].url;
    expect(url).toContain('stockCode=600519');
    expect(url).toContain('resume=1');
    expect(url).toContain('token=tok-c');
  });

  it('令牌被 URL 编码，不破坏 SSE 连接', () => {
    localStorage.setItem('srs:api-token', 'a b&c');
    chatWithAgentStream('hi', () => {});
    const url = MockEventSource.instances[0].url;
    expect(url).toContain('token=a%20b%26c');
    // message 参数仍原样保留
    expect(url).toContain('message=hi');
  });

  it('重连产生的新连接同样带令牌（续跑不丢鉴权）', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('srs:api-token', 'tok-d');
      analyzeStockStream('600519', () => {});
      // 首次连接失败 → 1s 后重连
      MockEventSource.instances[0].emitError();
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockEventSource.instances.length).toBeGreaterThan(1);
      // 每次连接都必须带令牌，否则续跑会因鉴权失败而中断
      for (const es of MockEventSource.instances) {
        expect(es.url).toContain('token=tok-d');
      }
    } finally {
      // 不等 done 落定：本用例只断言 URL，剩余重试留在假定时器里随用例结束一并丢弃
      vi.useRealTimers();
    }
  });
});

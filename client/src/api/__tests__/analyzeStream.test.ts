import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeStockStream, type AnalysisStage } from '../client.js';

// 用可控的 EventSource 替身测试流式编排逻辑（看门狗 / 进度回调 / 完成 / 错误 / 取消），无需真实 DOM。
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(stage: unknown) {
    this.onmessage?.({ data: JSON.stringify(stage) });
  }
  emitError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('analyzeStockStream', () => {
  it('进度事件回调 onStage，done 阶段 resolve 完整结果', async () => {
    const stages: AnalysisStage[] = [];
    const { done } = analyzeStockStream('600519', (s) => stages.push(s));
    const es = MockEventSource.instances[0];
    es.emit({ phase: 'data', message: '获取数据中' });
    es.emit({ phase: 'scoring', message: '评分中', totalScore: 80, rating: '买入' });
    es.emit({ phase: 'done', message: '完成', result: { stock_pool: [] } as never });
    const result = await done;
    expect(stages).toHaveLength(2);
    expect(stages[1].totalScore).toBe(80);
    expect(result).toEqual({ stock_pool: [] });
    expect(es.closed).toBe(true); // 完成后清理连接
  });

  it('error 阶段使 done reject', async () => {
    const { done } = analyzeStockStream('600519', () => {});
    MockEventSource.instances[0].emit({ phase: 'error', message: '分析过程出错' });
    await expect(done).rejects.toThrow('分析过程出错');
  });

  it('20s 内无任何事件则判定后端无响应', async () => {
    const { done } = analyzeStockStream('600519', () => {});
    const p = expect(done).rejects.toThrow(/后端无响应/);
    await vi.advanceTimersByTimeAsync(20000);
    await p;
  });

  it('连接前出错且从未收到事件、关闭重连 → 连接错误', async () => {
    const { done } = analyzeStockStream('600519', () => {}, { maxRetries: 0 });
    MockEventSource.instances[0].emitError();
    await expect(done).rejects.toThrow(/无法连接后端服务/);
  });

  it('连接失败后自动重连，重连成功则正常完成（H-03）', async () => {
    const stages: AnalysisStage[] = [];
    const { done } = analyzeStockStream('600519', (s) => stages.push(s));
    // 首次连接失败（未收到任何事件）→ 1s 后重连
    MockEventSource.instances[0].emitError();
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockEventSource.instances).toHaveLength(2);
    // 第二次连接成功
    MockEventSource.instances[1].emit({ phase: 'data', message: '获取数据中' });
    MockEventSource.instances[1].emit({
      phase: 'done',
      message: '完成',
      result: { stock_pool: [] } as never,
    });
    const result = await done;
    expect(stages).toHaveLength(1);
    expect(result).toEqual({ stock_pool: [] });
  });

  it('重试次数耗尽后报连接失败（H-03）', async () => {
    const { done } = analyzeStockStream('600519', () => {}, { maxRetries: 2 });
    // 先挂断言再推进计时器，避免 done 提前 reject 产生 unhandled rejection
    const p = expect(done).rejects.toThrow(/无法连接后端服务/);
    // 初次连接 + 2 次重连全部失败，退避间隔 1s、2s
    for (let i = 0; i < 3; i++) {
      MockEventSource.instances[i].emitError();
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(MockEventSource.instances).toHaveLength(3);
    await p;
  });

  it('cancel 后不再触发重连', async () => {
    const { cancel } = analyzeStockStream('600519', () => {});
    MockEventSource.instances[0].emitError();
    cancel();
    await vi.advanceTimersByTimeAsync(10000);
    expect(MockEventSource.instances).toHaveLength(1); // 未创建新连接
  });

  it('接收过事件后断开 → 连接中断', async () => {
    const { done } = analyzeStockStream('600519', () => {});
    const es = MockEventSource.instances[0];
    es.emit({ phase: 'data', message: '数据获取中' });
    es.emitError();
    await expect(done).rejects.toThrow(/连接中断/);
  });

  it('cancel 中断连接且不再触发 done', async () => {
    const { done, cancel } = analyzeStockStream('600519', () => {});
    const es = MockEventSource.instances[0];
    cancel();
    expect(es.closed).toBe(true);
    let settled = false;
    done.then(() => {
      settled = true;
    });
    es.emit({ phase: 'done', message: 'x', result: {} as never });
    await Promise.resolve(); // 冲刷微任务
    expect(settled).toBe(false); // 不会因 cancel 后的事件而 resolve
  });
});

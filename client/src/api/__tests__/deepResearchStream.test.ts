/**
 * runDeepResearchStream 流式消费层测试
 * ----------------------------------------------------------------------------
 * 审查结论点名的零覆盖区：首包看门狗（20s 无进度 → 报「后端无响应」而不是
 * 无限挂起）、坏帧容忍（单帧解析失败不终止整次研究）、error 帧、取消语义。
 * 用可控的 FakeEventSource 替代原生 EventSource——本测试不依赖真实网络。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** 可控 EventSource：测试通过实例方法手动派发帧 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  /** 派发一条 SSE data 帧 */
  emit(data: string): void {
    this.onmessage?.({ data });
  }
  /** 派发错误（EventSource 的 onerror 签名无参数或被忽略） */
  error(): void {
    this.onerror?.();
  }
}

// 认证 token 在测试里不存在，withTokenQuery 应原样返回 URL（不依赖仓库实现细节）
vi.stubGlobal('EventSource', FakeEventSource);

import { runDeepResearchStream, DeepResearchInterruptedError } from '../client';

/** run_meta 帧：服务端首帧下发 runId（断线续跑凭据） */
const META_FRAME = JSON.stringify({
  phase: 'run_meta',
  runId: 'abc123-1-deadbeef',
  resumed: false,
  resumedFromRound: 0,
});

/** done 帧负载（服务端 result 的最小可断言子集；解析后为深拷贝，用 toMatchObject 断言） */
const DONE_FRAME = JSON.stringify({
  phase: 'done',
  result: { report: { title: '测试报告' }, events: [], stats: {} },
});

function lastES(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error('未创建 EventSource');
  return es;
}

beforeEach(() => {
  FakeEventSource.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runDeepResearchStream', () => {
  it('正常流：agent_event 逐帧回调，done 帧 resolve 完整结果并关闭连接', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const { done } = runDeepResearchStream('白酒行业竞争格局', (e) => {
      seen.push(e.phase);
    });
    const es = lastES();
    es.emit(JSON.stringify({ phase: 'agent_event', event: { seq: 1, type: 'run_started' } }));
    es.emit(DONE_FRAME);
    await expect(done).resolves.toMatchObject({ report: { title: '测试报告' } });
    expect(seen).toEqual(['agent_event']);
    expect(es.closed).toBe(true);
  });

  it('坏帧容忍：解析失败回调可见错误但继续等待后续帧（不终止整次研究）', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const { done } = runDeepResearchStream('问题', (e) => {
      if (e.phase === 'error') errors.push(e.message ?? '');
    });
    const es = lastES();
    es.emit('{不是合法 JSON');
    es.emit(DONE_FRAME);
    await expect(done).resolves.toMatchObject({ report: { title: '测试报告' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('解析失败');
  });

  it('首包看门狗：20 秒无任何帧 → 明确报「后端无响应」并关闭连接', async () => {
    vi.useFakeTimers();
    const { done } = runDeepResearchStream('问题', () => {});
    const es = lastES();
    const assertion = expect(done).rejects.toThrow(/后端无响应/);
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    expect(es.closed).toBe(true);
  });

  it('error 帧 → 以服务端消息 reject', async () => {
    vi.useFakeTimers();
    const { done } = runDeepResearchStream('问题', () => {});
    const assertion = expect(done).rejects.toThrow('LLM 未配置');
    lastES().emit(JSON.stringify({ phase: 'error', message: 'LLM 未配置' }));
    await assertion;
  });

  it('cancel() → reject「已取消本次研究」。且看门狗不再触发（不产生二次 settle）', async () => {
    vi.useFakeTimers();
    const { done, cancel } = runDeepResearchStream('问题', () => {});
    const assertion = expect(done).rejects.toThrow('已取消本次研究');
    cancel();
    await assertion;
    // 推进超过看门狗时限：已 settle 的 promise 不受影响（settled 守卫）
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(done).rejects.toThrow('已取消本次研究');
  });

  it('连接中断且无任何帧 → 文案同时给出「服务未起」与「未配 LLM」两个可操作原因', async () => {
    vi.useFakeTimers();
    const { done } = runDeepResearchStream('问题', () => {});
    const assertion = expect(done).rejects.toThrow(/后端服务已启动.*LLM 密钥/);
    lastES().error();
    await assertion;
  });
});

describe('runDeepResearchStream 断线续跑', () => {
  it('run_meta 帧透传给调用方（UI 据此显示「已从第 N 轮继续」）', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const { done } = runDeepResearchStream('问题', (e) => seen.push(e.phase));
    const es = lastES();
    es.emit(META_FRAME);
    es.emit(DONE_FRAME);
    await expect(done).resolves.toMatchObject({ report: { title: '测试报告' } });
    expect(seen).toContain('run_meta');
  });

  it('已收到事件后断开 → 以可续跑错误 reject，并带上 run_meta 里的 runId', async () => {
    vi.useFakeTimers();
    const { done } = runDeepResearchStream('问题', () => {});
    const assertion = expect(done).rejects.toBeInstanceOf(DeepResearchInterruptedError);
    const es = lastES();
    es.emit(META_FRAME);
    es.emit(JSON.stringify({ phase: 'agent_event', event: { seq: 2, type: 'retrieval_started' } }));
    es.error();
    await assertion;
    await done.catch((err: DeepResearchInterruptedError) => {
      expect(err.canResume).toBe(true);
      expect(err.runId).toBe('abc123-1-deadbeef');
      expect(err.message).toContain('连接中断');
    });
    expect(es.closed).toBe(true);
  });

  it('服务端 error 帧（已拿到 runId）同样标记可续跑，而不是让用户从头再来', async () => {
    vi.useFakeTimers();
    const { done } = runDeepResearchStream('问题', () => {});
    const es = lastES();
    es.emit(META_FRAME);
    es.emit(JSON.stringify({ phase: 'error', message: '研究超过最大时长，已中止' }));
    await done.catch((err: DeepResearchInterruptedError) => {
      expect(err).toBeInstanceOf(DeepResearchInterruptedError);
      expect(err.canResume).toBe(true);
      expect(err.runId).toBe('abc123-1-deadbeef');
      expect(err.message).toContain('最大时长');
    });
  });

  it('续跑调用：URL 带 runId、不带空 question；done 正常 resolve', async () => {
    vi.useFakeTimers();
    const { done } = runDeepResearchStream('', () => {}, { runId: 'abc123-1-deadbeef' });
    const es = lastES();
    expect(es.url).toContain('runId=abc123-1-deadbeef');
    expect(es.url).not.toContain('question=');
    es.emit(
      JSON.stringify({
        phase: 'run_meta',
        runId: 'abc123-1-deadbeef',
        resumed: true,
        resumedFromRound: 2,
      }),
    );
    es.emit(DONE_FRAME);
    await expect(done).resolves.toMatchObject({ report: { title: '测试报告' } });
  });

  it('续跑请求首包前被拒 → 明确提示「续跑未能开始」，并保留续跑入口', async () => {
    vi.useFakeTimers();
    const { done } = runDeepResearchStream('', () => {}, { runId: 'abc123-1-deadbeef' });
    const assertion = expect(done).rejects.toThrow(/续跑未能开始/);
    lastES().error();
    await assertion;
    await done.catch((err: DeepResearchInterruptedError) => {
      // 断点可能只是「仍在收尾」：保留续跑入口，用户可稍后重试
      expect(err.canResume).toBe(true);
      expect(err.runId).toBe('abc123-1-deadbeef');
    });
  });
});

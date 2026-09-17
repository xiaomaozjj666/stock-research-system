import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import logger from '../logger.js';
import {
  LimitGate,
  QueueTimeoutError,
  isQueueTimeoutError,
  resolveMaxConcurrency,
  resolveQueueTimeoutMs,
  resolveMaxTokensCap,
  normalizeTemperatureInput,
  normalizeMaxTokensInput,
  clampTemperature,
  clampMaxTokens,
  validateMessages,
  validateChatHistory,
  clampChatHistory,
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_LIMIT,
  DEFAULT_QUEUE_TIMEOUT_MS,
  MAX_QUEUE_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS_CAP,
  MAX_TOKENS_CAP_LIMIT,
  MAX_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_TOTAL_MESSAGE_CHARS,
} from '../limitGate.js';

// ---------------------------------------------------------------------------
// 假时钟：排队超时用「推进时钟」触发，测试不真的 sleep
// ---------------------------------------------------------------------------
function fakeClock() {
  let time = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      pending.set(id, { at: time + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle as unknown as number);
    },
    /** 推进时钟并同步执行到期的回调 */
    advance(ms: number) {
      time += ms;
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= time)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        pending.delete(id);
        t.fn();
      }
    },
    pendingCount: () => pending.size,
  };
}

describe('环境变量解析（非法值回退默认 + 硬上界）', () => {
  it('未配置时用默认值 8 / 30s / 4096（并发默认 = 单次分析的专家并行度）', () => {
    expect(resolveMaxConcurrency(undefined)).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(resolveQueueTimeoutMs(undefined)).toBe(DEFAULT_QUEUE_TIMEOUT_MS);
    expect(resolveMaxTokensCap(undefined)).toBe(DEFAULT_MAX_TOKENS_CAP);
  });

  it('合法值直接生效', () => {
    expect(resolveMaxConcurrency('8')).toBe(8);
    expect(resolveQueueTimeoutMs('50')).toBe(50);
    expect(resolveMaxTokensCap('8192')).toBe(8192);
  });

  it('非法值（NaN/空串/0/负数）一律回退默认，而不是当成 0 或 NaN 用', () => {
    for (const bad of ['abc', '', '0', '-3', 'NaN']) {
      expect(resolveMaxConcurrency(bad)).toBe(DEFAULT_MAX_CONCURRENCY);
      expect(resolveQueueTimeoutMs(bad)).toBe(DEFAULT_QUEUE_TIMEOUT_MS);
      expect(resolveMaxTokensCap(bad)).toBe(DEFAULT_MAX_TOKENS_CAP);
    }
  });

  it('超过硬上界时夹紧（防止把"保护"配成"没有保护"）', () => {
    expect(resolveMaxConcurrency('1000')).toBe(MAX_CONCURRENCY_LIMIT);
    expect(resolveQueueTimeoutMs('99999999')).toBe(MAX_QUEUE_TIMEOUT_MS);
    expect(resolveMaxTokensCap('9999999')).toBe(MAX_TOKENS_CAP_LIMIT);
  });

  it('小数向下取整（并发数必须是整数）', () => {
    expect(resolveMaxConcurrency('4.9')).toBe(4);
    expect(resolveMaxTokensCap('100.9')).toBe(100);
  });
});

describe('LimitGate — 并发限制（限并发，不退化为串行）', () => {
  it('并发峰值恰好等于上限，且明显大于 1', async () => {
    const gate = new LimitGate({ maxConcurrency: 2, queueTimeoutMs: 5000 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );
    // 精确断言：6 个任务、上限 2 时必须达到峰值 2
    // （若实现退化成串行 → 1；若无闸门 → 6）
    expect(peak).toBe(2);
    expect(gate.inFlight).toBe(0);
  });

  it('异常路径同样释放配额（finally），一次失败不会永久占用槽位', async () => {
    const gate = new LimitGate({ maxConcurrency: 1, queueTimeoutMs: 200 });
    await expect(
      gate.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(gate.inFlight).toBe(0);
    // 上限为 1：若上一轮泄漏了配额，这里会排队到超时
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
    expect(gate.inFlight).toBe(0);
  });

  it('release 幂等：重复释放不会凭空多放行配额', async () => {
    const gate = new LimitGate({ maxConcurrency: 1, queueTimeoutMs: 10_000 });
    const release1 = await gate.acquire();
    const p2 = gate.acquire();
    const p3 = gate.acquire();
    expect(gate.queued).toBe(2);

    release1();
    release1(); // 重复释放：不应把 p3 也放进来
    const release2 = await p2;
    expect(gate.inFlight).toBe(1);
    expect(gate.queued).toBe(1);

    release2();
    const release3 = await p3;
    expect(gate.inFlight).toBe(1);
    release3();
    expect(gate.inFlight).toBe(0);
    expect(gate.queued).toBe(0);
  });
});

describe('LimitGate — 排队超时（假时钟，零真实等待）', () => {
  it('排队超时抛出可识别为 429 的错误，并清空队列', async () => {
    const clock = fakeClock();
    const gate = new LimitGate({
      maxConcurrency: 1,
      queueTimeoutMs: 1000,
      name: 'test',
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const release = await gate.acquire();
    const queued = gate.acquire();
    // 先订阅 rejeciton 断言，避免 advance 后出现未处理的 rejection
    const assertion = expect(queued).rejects.toBeInstanceOf(QueueTimeoutError);
    expect(gate.queued).toBe(1);
    expect(clock.pendingCount()).toBe(1);

    clock.advance(1000);
    await assertion;

    // inFlight 仍为 1（release 未调用）→ 第二次 acquire 同样排队超时
    const capture = gate.acquire().then(
      () => null,
      (e: unknown) => e,
    );
    clock.advance(1000);
    const err = await capture;
    expect(isQueueTimeoutError(err)).toBe(true);
    expect(err).toMatchObject({
      code: 'LLM_QUEUE_TIMEOUT',
      statusCode: 429,
      retryAfterMs: 1000,
    });
    expect((err as QueueTimeoutError).retryAfterSeconds).toBe(1);
    expect(gate.queued).toBe(0);
    expect(gate.inFlight).toBe(1);

    release();
    expect(gate.inFlight).toBe(0);
    expect(gate.snapshot()).toMatchObject({ timeouts: 2, queueWaits: 2 });
  });

  it('超时的 waiter 不会在后续 release 时被误派发（无僵尸 waiter）', async () => {
    const clock = fakeClock();
    const gate = new LimitGate({
      maxConcurrency: 1,
      queueTimeoutMs: 1000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const release1 = await gate.acquire();
    const queued = gate.acquire();
    const assertion = expect(queued).rejects.toMatchObject({ code: 'LLM_QUEUE_TIMEOUT' });
    clock.advance(1000);
    await assertion;
    expect(gate.queued).toBe(0);

    release1();
    // 队列为空 → 新调用立刻拿到配额（而不是拾起那个已超时的 waiter）
    const release2 = await gate.acquire();
    expect(gate.inFlight).toBe(1);
    release2();
  });

  it('排队期间被取消：立即出队并 reject，不占用配额', async () => {
    const clock = fakeClock();
    const gate = new LimitGate({
      maxConcurrency: 1,
      queueTimeoutMs: 10_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const release = await gate.acquire();
    const controller = new AbortController();
    const queued = gate.acquire(controller.signal);
    const assertion = expect(queued).rejects.toThrow('已取消');
    controller.abort(new Error('已取消'));
    await assertion;
    expect(gate.queued).toBe(0);
    expect(clock.pendingCount()).toBe(0); // 定时器已摘除
    release();
    expect(gate.snapshot()).toMatchObject({ aborted: 1, inFlight: 0 });
  });

  it('真实定时器下的极短超时（30ms）同样生效', async () => {
    const gate = new LimitGate({ maxConcurrency: 1, queueTimeoutMs: 30 });
    const release = await gate.acquire();
    const start = Date.now();
    await expect(gate.acquire()).rejects.toMatchObject({ code: 'LLM_QUEUE_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(1000);
    release();
    expect(gate.inFlight).toBe(0);
  });
});

/* ============================================================================
 * 派发临界区必须自愈（P1：日志同步抛错会让 waiter 永不 settle + 配额泄漏）
 * ----------------------------------------------------------------------------
 * dispatch 在 settled=true 并清掉定时器之后、resolve(release) 之前夹了一次 logger.info：
 * 日志写入若同步抛错（EPIPE / 磁盘满），异常会从 release() 里冒出去，该 waiter 永不
 * settle，且已 +1 的配额再没人归还 —— 命中并发上限后闸门**无法自愈**（后续 acquire
 * 全部排队到超时，服务表现为 LLM 全线 429）。
 * ==========================================================================*/
describe('LimitGate — 派发临界区不被日志写入打断', () => {
  it('派发日志同步抛错：waiter 仍被派发、配额账自洽、闸门可继续服务', async () => {
    const gate = new LimitGate({ maxConcurrency: 1, queueTimeoutMs: 1000, name: 'test' });
    const release1 = await gate.acquire();
    const queued = gate.acquire(); // 排队
    expect(gate.queued).toBe(1);

    const spy = vi.spyOn(logger, 'info').mockImplementation((msg: string) => {
      // 只让「派发那一刻」的日志失败：模拟 EPIPE/磁盘满
      if (String(msg).includes('排队结束')) throw new Error('EPIPE: 日志写入失败');
    });
    let released = false;
    try {
      // 1) 派发临界区不得把异常抛给 release 的调用方（否则调用方的 finally 也会炸）
      expect(() => release1()).not.toThrow();
      released = true;
      // 2) waiter 必须被 settle（修复前这里会永久挂起直到排队超时/用例超时）
      const release2 = await queued;
      expect(gate.inFlight).toBe(1);
      expect(gate.queued).toBe(0);

      // 3) 闸门自愈：还能继续拿到配额，配额账不会泄漏
      const queued2 = gate.acquire();
      release2();
      const release3 = await queued2;
      release3();
      expect(gate.inFlight).toBe(0);
      expect(gate.snapshot()).toMatchObject({ acquired: 3, timeouts: 0 });
    } finally {
      spy.mockRestore();
      if (!released) release1();
    }
  });
});

describe('temperature / maxTokens 入口限幅', () => {
  afterEach(() => {
    delete process.env.LLM_MAX_TOKENS_CAP;
  });

  it('未提供（undefined/null）视为沿用默认，不算错误', () => {
    expect(normalizeTemperatureInput(undefined)).toEqual({ ok: true });
    expect(normalizeTemperatureInput(null)).toEqual({ ok: true });
    expect(normalizeMaxTokensInput(undefined)).toEqual({ ok: true });
    expect(normalizeMaxTokensInput(null)).toEqual({ ok: true });
  });

  it('非数值 / NaN / Infinity 一律拒绝（不夹紧，掩盖客户端 bug 更危险）', () => {
    for (const bad of ['0.5', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeTemperatureInput(bad).ok).toBe(false);
      expect(normalizeMaxTokensInput(bad).ok).toBe(false);
    }
  });

  it('负数一律拒绝', () => {
    expect(normalizeTemperatureInput(-0.1)).toMatchObject({ ok: false });
    expect(normalizeMaxTokensInput(-1)).toMatchObject({ ok: false });
  });

  it('temperature > 2 夹紧到 2，并回传原值供日志留痕', () => {
    expect(normalizeTemperatureInput(2.5)).toEqual({ ok: true, value: 2, clampedFrom: 2.5 });
    expect(normalizeTemperatureInput(0.7)).toEqual({ ok: true, value: 0.7 });
  });

  it('maxTokens 超过 LLM_MAX_TOKENS_CAP 夹紧到上限', () => {
    expect(normalizeMaxTokensInput(999_999)).toEqual({
      ok: true,
      value: DEFAULT_MAX_TOKENS_CAP,
      clampedFrom: 999_999,
    });
    process.env.LLM_MAX_TOKENS_CAP = '8192';
    expect(normalizeMaxTokensInput(999_999)).toEqual({
      ok: true,
      value: 8192,
      clampedFrom: 999_999,
    });
    expect(normalizeMaxTokensInput(1000)).toEqual({ ok: true, value: 1000 });
  });

  it('maxTokens < 1（含 0）拒绝：0 token 是退化请求', () => {
    expect(normalizeMaxTokensInput(0).ok).toBe(false);
  });

  it('内部调用方的宽松夹紧：非法值视为未提供，越界夹紧', () => {
    expect(clampTemperature(5)).toBe(2);
    expect(clampTemperature(-1)).toBe(0);
    expect(clampTemperature(undefined)).toBeUndefined();
    expect(clampTemperature(Number.NaN)).toBeUndefined();
    expect(clampMaxTokens(999_999)).toBe(DEFAULT_MAX_TOKENS_CAP);
    expect(clampMaxTokens(0)).toBe(1);
  });
});

describe('messages 校验（严格拒绝口径）', () => {
  const msg = (content: string, role = 'user') => ({ role, content });

  it('非数组 / 空数组 → 拒绝', () => {
    expect(validateMessages(undefined).ok).toBe(false);
    expect(validateMessages('hi').ok).toBe(false);
    expect(validateMessages([]).ok).toBe(false);
  });

  it('条数超过 80 → 拒绝（静默丢条会丢 system 指令）', () => {
    const many = Array.from({ length: MAX_HISTORY_MESSAGES + 1 }, () => msg('x'));
    const r = validateMessages(many);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('最多');
  });

  it('单条超过 8000 字 → 拒绝', () => {
    const r = validateMessages([msg('x'.repeat(MAX_MESSAGE_CHARS + 1))]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('单条上限');
  });

  it('总字符超过 40000 → 拒绝（条数与单条上限拦不住"80 条 × 8000 字"）', () => {
    const chunk = 'x'.repeat(7000);
    const r = validateMessages(Array.from({ length: 6 }, () => msg(chunk)));
    expect(chunk.length * 6).toBeGreaterThan(MAX_TOTAL_MESSAGE_CHARS);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('总字符');
  });

  it('role 不在 system/user/assistant/tool 内 → 拒绝', () => {
    const r = validateMessages([{ role: 'root', content: 'x' }]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('role');
  });

  it('content 非字符串 → 拒绝', () => {
    expect(validateMessages([{ role: 'user', content: { text: 'x' } }]).ok).toBe(false);
  });

  it('合法输入只透传已知字段（自定义字段不会带到上游）', () => {
    const r = validateMessages([{ role: 'user', content: 'hi', evil: 1 }]);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('history 校验与夹紧', () => {
  it('结构非法（非数组 / role 越权 / content 非字符串）→ 拒绝', () => {
    expect(validateChatHistory('x').ok).toBe(false);
    expect(validateChatHistory([{ role: 'system', content: 'x' }]).ok).toBe(false);
    expect(validateChatHistory([{ role: 'user', content: 1 }]).ok).toBe(false);
    expect(validateChatHistory(undefined)).toEqual({ ok: true, turns: [] });
  });

  it('条数超限保留「最近」的 80 条', () => {
    const many = Array.from({ length: 100 }, (_v, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第${i}条`,
    }));
    const r = validateChatHistory(many);
    expect(r.ok).toBe(true);
    const turns = r.ok === true ? r.turns : [];
    expect(turns).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(turns[0].content).toBe('第20条');
    expect(turns[turns.length - 1].content).toBe('第99条');
  });

  it('单条超长截断、总字符超限丢最早（保留最新上下文）', () => {
    // 6 条 × 20000 字 → 先按单条 8000 截断（共 48000）→ 再从最早的一条开始丢到 ≤40000
    const long = Array.from({ length: 6 }, (_v, i) => ({
      role: 'user' as const,
      content: String(i) + 'x'.repeat(19_999),
    }));
    const turns = clampChatHistory(long);
    const total = turns.reduce((sum, t) => sum + t.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_MESSAGE_CHARS);
    expect(turns).toHaveLength(5);
    expect(turns[0].content.startsWith('1')).toBe(true); // 最早的"0"被丢弃
    expect(turns[turns.length - 1].content.startsWith('5')).toBe(true);
    expect(turns.every((t) => t.content.length <= MAX_MESSAGE_CHARS)).toBe(true);
  });

  it('clampChatHistory 丢弃结构不合法的条目（持久记忆路径兜底）', () => {
    const turns = clampChatHistory([
      { role: 'user', content: '正常' },
      { role: 'system', content: '越权注入' },
      { role: 'assistant', content: null },
      null,
      { role: 'assistant', content: '正常回答' },
    ]);
    expect(turns).toEqual([
      { role: 'user', content: '正常' },
      { role: 'assistant', content: '正常回答' },
    ]);
  });
});

describe('队列超时错误的识别口径', () => {
  beforeEach(() => {
    delete process.env.LLM_MAX_CONCURRENCY;
  });

  it('instanceof 与 code 双通道识别（mock/跨模块实例也能识别）', () => {
    const err = new QueueTimeoutError('llm', 30_000, 30_000);
    expect(isQueueTimeoutError(err)).toBe(true);
    expect(isQueueTimeoutError({ code: 'LLM_QUEUE_TIMEOUT' })).toBe(true);
    expect(isQueueTimeoutError(new Error('别的错'))).toBe(false);
    expect(isQueueTimeoutError(undefined)).toBe(false);
    expect(err.retryAfterSeconds).toBe(30);
  });
});

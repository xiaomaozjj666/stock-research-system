import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../concurrency.js';

describe('mapWithConcurrency', () => {
  it('空数组返回空数组', async () => {
    const out = await mapWithConcurrency([], 4, async (x) => x);
    expect(out).toEqual([]);
  });

  it('结果按输入顺序返回（与完成顺序无关）', async () => {
    // 故意让靠后的任务先完成，验证保序
    const delays = [30, 5, 15, 1];
    const out = await mapWithConcurrency([0, 1, 2, 3], 4, async (i) => {
      await new Promise((r) => setTimeout(r, delays[i]));
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30]);
  });

  it('限制并发数：同时进行的任务不超过 limit（且实际达到 limit）', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 12 }), 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    // 精确断言：12 个任务 limit=3 必然达到峰值 3（此前 toBeLessThanOrEqual(3) 在实现退化为 2 时也过）
    expect(maxActive).toBe(3);
  });

  it('limit 为 NaN 时钳制为 1 不崩溃', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 5 }), Number.NaN, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    expect(maxActive).toBe(1);
  });

  it('limit 超过数组长度时退化为全并发', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 4 }), 99, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    expect(maxActive).toBe(4);
  });

  it('单个 worker 抛错会向上传播', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }),
    ).rejects.toThrow('boom');
  });

  it('limit 非法（≤0）被钳制为 1', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 5 }), 0, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    expect(maxActive).toBe(1);
  });

  it('预置位的 signal：不派发任何任务并整体拒绝', async () => {
    const controller = new AbortController();
    controller.abort();
    let started = 0;
    await expect(
      mapWithConcurrency(
        [1, 2, 3],
        2,
        async () => {
          started += 1;
          return started;
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(started).toBe(0);
  });

  it('在途中止：置位后不再派发新任务（limit=1 串行可精确计数）', async () => {
    const controller = new AbortController();
    let started = 0;
    await expect(
      mapWithConcurrency(
        Array.from({ length: 20 }),
        1,
        async () => {
          started += 1;
          if (started === 2) controller.abort(); // 第 2 个任务开始时中止
          await new Promise((r) => setTimeout(r, 2));
          return started;
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    // 恰好派发了 2 个：第 3 个及以后不再启动
    expect(started).toBe(2);
  });
});

/* ============================================================================
 * 首个失败即整体收手（P1：Promise.all 只保证调用方早返回，不保证后台停手）
 * ----------------------------------------------------------------------------
 * 修复前：`await Promise.all(runners)` 在第一个 rejection 后立刻返回，调用方已按失败
 * 处理（HTTP 已 500），但其余 runner 仍停在 `await worker(...)` 上继续打上游，
 * 且它们后续的 rejection 无人 await。下面用「放行闸门」精确复刻这个时序。
 * ==========================================================================*/
describe('mapWithConcurrency — 首个失败后停止派发', () => {
  it('首个 worker 失败后不再派发新任务（在途 worker 收手）', async () => {
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const pending = mapWithConcurrency(
      Array.from({ length: 6 }, (_, i) => i),
      2,
      async (_item, i) => {
        started.push(i);
        if (i === 0) throw new Error('boom'); // 第 0 个立即失败
        // 其余任务挂在闸门上（模拟「正在打上游」），等测试放行
        await new Promise<void>((resolve) => gates.push(resolve));
        return i;
      },
    );
    await expect(pending).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]); // 只派发了 2 个

    // 放行在途任务：修复前它们会继续拉取第 2..5 个任务（后台白烧上游），修复后立即收手
    gates.forEach((g) => g());
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual([0, 1]);
  });

  it('首个失败后，在途 worker 收到的 signal 被置位（可据此提前收手）', async () => {
    let siblingSignal: AbortSignal | undefined;
    const started: number[] = [];
    const pending = mapWithConcurrency([0, 1, 2, 3], 2, async (_item, i, signal) => {
      started.push(i);
      if (i === 0) throw new Error('boom');
      siblingSignal = signal;
      // 等 signal 置位（或兜底超时，避免用例挂死）
      await Promise.race([
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      return i;
    });

    await expect(pending).rejects.toThrow('boom');
    expect(siblingSignal).toBeDefined(); // worker 的第 3 个参数就是取消信号
    expect(siblingSignal!.aborted).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it('抛出的仍是首个错误本身（不包装、不丢失原始 message）', async () => {
    const first = new Error('上游 429');
    const pending = mapWithConcurrency([0, 1], 2, async (_item, i) => {
      if (i === 0) throw first;
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('第二个错误不该被看到');
    });
    await expect(pending).rejects.toBe(first);
  });

  it('不产生无人 await 的 rejection（在途 worker 的后续失败被内部消化）', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        mapWithConcurrency([0, 1, 2, 3], 2, async (_item, i) => {
          if (i === 0) throw new Error('boom');
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          if (i === 1) throw new Error('第二个也失败'); // 修复前：无人 await 的 rejection
          return i;
        }),
      ).rejects.toThrow('boom');
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('全部成功时行为不变：结果保序、达到并发上限', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (_item, i, signal) => {
      active++;
      peak = Math.max(peak, active);
      expect(signal.aborted).toBe(false); // 无失败时信号不应被置位
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i * 2;
    });
    expect(out).toEqual([0, 2, 4, 6, 8]);
    expect(peak).toBe(2);
  });
});

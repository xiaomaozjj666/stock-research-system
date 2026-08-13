import { describe, it, expect, vi } from 'vitest';
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
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalysisCancelledError, runFactorExpression } from '../client.js';

/**
 * 因子表达式评估是分钟级任务：调用方必须能把 AbortSignal 透传给 axios，
 * 并在取消时拿到 AnalysisCancelledError（据此静默收尾，而不是当失败渲染）。
 * axios 被 mock：这里验证的是我们的透传/错误映射，不发真实请求。
 */
const axiosInst = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    create: () => axiosInst,
    // 复刻真实 axios 的取消判据：被取消的错误带 __CANCEL__ 标记
    isCancel: (v: unknown) => !!(v && (v as { __CANCEL__?: boolean }).__CANCEL__),
  },
}));

beforeEach(() => {
  axiosInst.post.mockReset();
  axiosInst.get.mockReset();
});

describe('runFactorExpression 取消支持', () => {
  it('signal 透传到请求配置（与 runCrossSectionEvaluation 同形）', async () => {
    axiosInst.post.mockResolvedValue({ data: { ledger: { recorded: 1, total: 1 } } });
    const controller = new AbortController();

    await runFactorExpression(
      { expression: 'close/mean(close,20)-1', board: 'BK0475' },
      controller.signal,
    );

    expect(axiosInst.post).toHaveBeenCalledWith(
      '/quant/factor/expression',
      expect.objectContaining({ expression: 'close/mean(close,20)-1', board: 'BK0475' }),
      expect.objectContaining({ signal: controller.signal, timeout: 600000 }),
    );
  });

  it('不传 signal 时不带 signal 字段（兼容既有调用点）', async () => {
    axiosInst.post.mockResolvedValue({ data: { ledger: { recorded: 0, total: 0 } } });

    await runFactorExpression({ expression: 'close', board: 'BK0475' });

    const cfg = axiosInst.post.mock.calls[0][2] as { signal?: AbortSignal };
    expect(cfg.signal).toBeUndefined();
  });

  it('请求被取消 → 抛 AnalysisCancelledError（而非普通错误）', async () => {
    // 模拟 axios 在 signal 已中止时的行为：以 ERR_CANCELED / __CANCEL__ 拒绝
    axiosInst.post.mockImplementation(
      (_url: string, _data: unknown, cfg: { signal?: AbortSignal }) =>
        cfg?.signal?.aborted
          ? Promise.reject({ __CANCEL__: true, code: 'ERR_CANCELED', message: 'canceled' })
          : Promise.resolve({ data: {} }),
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      runFactorExpression({ expression: 'close', board: 'BK0475' }, controller.signal),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
  });

  it('未取消的失败仍走普通错误映射（不误判为取消）', async () => {
    axiosInst.post.mockRejectedValue({
      response: { status: 400, data: { error: '表达式不合法' } },
    });

    await expect(
      runFactorExpression({ expression: '(', board: 'BK0475' }, new AbortController().signal),
    ).rejects.toThrow('表达式不合法');
  });
});

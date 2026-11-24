import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalysisCancelledError, runFactorExpression } from '../client.js';

/**
 * 因子表达式评估是分钟级任务：调用方必须能把 AbortSignal 透传给 HTTP 客户端，
 * 并在取消时拿到 AnalysisCancelledError（据此静默收尾，而不是当失败渲染）。
 * HTTP 客户端被 mock：这里验证的是我们的透传/错误映射，不发真实请求。
 */
// 注：桩必须带 interceptors —— client.ts 在模块加载时就注册了 request/response
// 拦截器（鉴权头注入 + 401 广播）。这里内联而非抽公共 helper：vi.hoisted 的回调
// 在 ESM import 之前执行，抽成 import 的 helper 会撞 "Cannot access before
// initialization"（已实测）。桩只需调用不报错，无需断言，故用 no-op。

const httpInst = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  interceptors: {
    request: { use: () => {} },
    response: { use: () => {} },
  },
}));

vi.mock('../http.js', () => ({
  default: {
    create: () => httpInst,
  },
  // 复刻真实客户端的取消判据：被 AbortSignal 取消的错误带 ERR_CANCELED
  isCancelled: (v: unknown) => !!(v && (v as { code?: string }).code === 'ERR_CANCELED'),
}));

beforeEach(() => {
  httpInst.post.mockReset();
  httpInst.get.mockReset();
});

describe('runFactorExpression 取消支持', () => {
  it('signal 透传到请求配置（与 runCrossSectionEvaluation 同形）', async () => {
    httpInst.post.mockResolvedValue({ data: { ledger: { recorded: 1, total: 1 } } });
    const controller = new AbortController();

    await runFactorExpression(
      { expression: 'close/mean(close,20)-1', board: 'BK0475' },
      controller.signal,
    );

    expect(httpInst.post).toHaveBeenCalledWith(
      '/quant/factor/expression',
      expect.objectContaining({ expression: 'close/mean(close,20)-1', board: 'BK0475' }),
      expect.objectContaining({ signal: controller.signal, timeout: 600000 }),
    );
  });

  it('不传 signal 时不带 signal 字段（兼容既有调用点）', async () => {
    httpInst.post.mockResolvedValue({ data: { ledger: { recorded: 0, total: 0 } } });

    await runFactorExpression({ expression: 'close', board: 'BK0475' });

    const cfg = httpInst.post.mock.calls[0][2] as { signal?: AbortSignal };
    expect(cfg.signal).toBeUndefined();
  });

  it('请求被取消 → 抛 AnalysisCancelledError（而非普通错误）', async () => {
    // 模拟底层客户端在 signal 已中止时的行为：以 ERR_CANCELED 拒绝
    httpInst.post.mockImplementation(
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
    httpInst.post.mockRejectedValue({
      response: { status: 400, data: { error: '表达式不合法' } },
    });

    await expect(
      runFactorExpression({ expression: '(', board: 'BK0475' }, new AbortController().signal),
    ).rejects.toThrow('表达式不合法');
  });
});

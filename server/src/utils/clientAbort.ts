/**
 * 客户端断开 → 级联中止在途取数
 * ----------------------------------------------------------------------------
 * 为什么单独成文件：routes/watchlist.ts 与 routes/quant.ts 此前各写了一份等价实现
 * （注释也记着"该 helper 未导出，跨模块共享需改动 quant.ts"），两份一旦分叉，
 * 就会出现"某条路由客户端断开后仍在白烧上游配额"的隐性差异。统一到这里，
 * 语义只有一处定义。
 *
 * 语义（与原两份实现逐字一致，勿改）：
 *  - 监听 res 的 'close'（连接被关闭）；
 *  - **响应已写完（writableFinished）时视为正常结束，不 abort**——否则每个成功响应
 *    结束时的 close 都会误触发一次取消；
 *  - 返回 AbortController：调用方把 controller.signal 传进 mapWithConcurrency /
 *    各 fetch* 函数，取消沿调用链级联到 socket 级。
 */
import type { Response } from 'express';

/**
 * 客户端提前断开时中止在途取数。
 * @param res Express 响应对象（监听其 'close'）
 * @returns AbortController（`controller.signal` 为取消信号，字段与既有调用点一致）
 */
export function abortOnClientClose(res: Response): AbortController {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}

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
 *
 * 补充（P1 修复）：「注册时连接**已经**关闭」必须先判、立即 abort。
 * 'close' 是一次性事件：客户端若在本函数被调用**之前**就断开（如请求刚进来就取消、
 * 或前置中间件耗时较久），事件早已派发完毕，事后注册的监听器永远不会再触发，
 * signal.aborted 会恒为 false —— 在途取数照样全量跑完，白烧上游配额。
 * 判据（按 Node 的 http.ServerResponse 状态定义，见下方 isConnectionGone）：
 *   - writableFinished === true            → 正常写完收尾，**不算断开**（保持既有语义）；
 *   - destroyed === true                   → 底层 message/socket 已被销毁；
 *   - closed === true                      → 'close' 已经发生过（响应未写完，故不是正常收尾）；
 *   - socket?.destroyed === true           → 底层 socket 已销毁（连接确实没了）。
 * 刻意**不**把 writableEnded 单独当作断开判据：res.end() 之后 flush 仍未完成属正常在途，
 * 单看它会把「响应正在收尾」误判成「客户端已走」而误取消；只有在连接侧的
 * destroyed / closed / socket.destroyed 有实证时才认定已断开。
 */
import type { Response } from 'express';

/** 连接是否已经关闭（注册时判据；见文件头注释的取舍理由） */
function isConnectionGone(res: Response): boolean {
  if (res.writableFinished) return false; // 正常结束：后续 close 属收尾，不算断开
  if (res.destroyed === true) return true;
  if ((res as { closed?: boolean }).closed === true) return true; // 'close' 已发生过
  const socket = (res as { socket?: { destroyed?: boolean } | null }).socket;
  return socket?.destroyed === true;
}

/**
 * 客户端提前断开时中止在途取数。
 * @param res Express 响应对象（监听其 'close'）
 * @returns AbortController（`controller.signal` 为取消信号，字段与既有调用点一致）
 */
export function abortOnClientClose(res: Response): AbortController {
  const controller = new AbortController();
  // 注册时连接已关闭：'close' 不会再触发，必须在这里直接置位，
  // 否则调用方拿到的 signal 恒为「未中止」，取消链路整条失效
  if (isConnectionGone(res)) {
    controller.abort(new Error('客户端连接已关闭'));
    return controller;
  }
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}

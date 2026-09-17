/**
 * 生产环境错误 detail 的统一收口。
 * ----------------------------------------------------------------------------
 * 为什么需要它：index.ts 的通用错误处理中间件早已按 NODE_ENV 决定是否回传 detail，
 * 但**路由内 catch** 不会走到那个中间件，此前一律无条件回传 `error.message`。
 * 而 error.message 里常常带着不该出境的东西：上游 URL（如
 * `http://push2.eastmoney.com/api/qt/...` 返回 500）、本机文件路径
 * （`/app/server/src/services/dataService.ts:255`）、Python 解释器路径、内部标识
 * （股票/板块内部 code）。生产环境把这些直接回给调用方，等于把信息面白送出去。
 *
 * 语义（**fail-safe：只有明确处于开发/测试态才回传**）：
 * - NODE_ENV=development / test，或显式 EXPOSE_ERROR_DETAIL=1：返回 err.message；
 * - 其余（含 NODE_ENV 未设置）：返回 undefined —— `res.json({ detail })` 里该字段被
 *   JSON.stringify 丢弃，响应体少一个字段（前端按可选字段处理，仍有稳定的 error 文案）；
 *   定位问题走服务端日志（各 catch 里都有 logger.error / logger.warn 留档）。
 *
 * 为什么反转判据：原实现是 `NODE_ENV === 'production' ? undefined : message`，
 * 而本仓库的启动方式（`npm start` → `node dist/index.js`、以及 启动系统.bat 的
 * `tsx watch src/index.ts`）**都不会设置 NODE_ENV**，.env.example 也明确引导用户
 * 「一般无需写进 .env」。于是按自带方式部署时该判断永不生效，
 * 20 多处 detail 会无条件外泄上游 URL 与本机路径。
 *
 * 注意：**只用于错误对象**。业务上刻意设计的中文校验提示（如"限价单需提供正价格"）
 * 是给调用方看的可操作指引，必须原样保留，不要套 errorDetail。
 */
export function errorDetail(err: unknown): string | undefined {
  const env = process.env.NODE_ENV;
  const expose = env === 'development' || env === 'test' || process.env.EXPOSE_ERROR_DETAIL === '1';
  if (!expose) return undefined;
  if (err instanceof Error) return err.message;
  // 非 Error 的抛出物（字符串/对象）：沿用各路由原先 `String(error)` 的兜底口径
  if (typeof err === 'string') return err;
  if (err === undefined || err === null) return undefined;
  return String(err);
}

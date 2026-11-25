/**
 * API 层公开入口（barrel）
 * ----------------------------------------------------------------------------
 * 实现按域拆到 api/rest/*.ts，本文件只保留「公开导出面」：
 *  - 共享基础（http 实例 + 令牌/401 拦截器 + 错误层）在 api/rest/base.ts；
 *  - 各域 REST 封装在 api/rest/{analysis,stocks,quant,intl,watchlist,chat,research,
 *    deepResearch,paper,history,admin}.ts；
 *  - SSE 共享内核仍从 api/sse.ts 原样再导出。
 *
 * 为什么坚持单一入口：全站 40+ 处（含测试的 vi.mock 路径）都 import 自
 * `api/client`，这是既定的公开契约。拆分只是内部搬家，任何调用方与 mock 都不需要
 * 改路径；对外名称、函数签名、URL、错误文案与原来逐字一致。
 *
 * 端点的响应类型全部由契约生成（见 api/generated.ts，头部有「请勿手改」告警）：
 * 泛型写错会在 tsc 立刻报错，契约改动后忘记重新生成会被 `npm run check:api-types`
 * （CI 门禁）拦下——这是本项目「契约与前端各写一份、必然分叉」的解法。
 */

// SSE 共享内核的公共类型/常量从 API 入口再导出：调用方与测试仍只依赖 api/client，
// 不必知道内部拆成了独立文件。
export { SSE_WATCHDOG_MS, SseSession } from './sse';
export type { SseSessionOptions } from './sse';

// 共享基础（错误层 + 取消语义）。http 实例本身不对外导出，保持原公开面不变。
export {
  ApiError,
  AnalysisCancelledError,
  BACKEND_UNREACHABLE_MESSAGE,
  normalizeApiError,
} from './rest/base';

// 按域拆分的 REST 封装：逐个域名再导出，等价于拆分前的扁平导出面。
export * from './rest/admin';
export * from './rest/analysis';
export * from './rest/chat';
export * from './rest/deepResearch';
export * from './rest/history';
export * from './rest/intl';
export * from './rest/paper';
export * from './rest/quant';
export * from './rest/research';
export * from './rest/stocks';
export * from './rest/watchlist';

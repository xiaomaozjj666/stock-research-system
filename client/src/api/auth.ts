/**
 * API 访问令牌的浏览器侧持有与注入。
 * ----------------------------------------------------------------------------
 * 为什么需要这个文件：服务端 `apiAuthGuard`（server/src/middleware.ts）在配置了
 * `API_AUTH_TOKEN` 后会校验令牌，但**浏览器默认不会带上任何令牌**——于是启用鉴权后
 * 整个前端立即 401，用户被挡在自己系统的 UI 外面，且没有任何办法自救。
 * 这个模块补上「令牌从哪来、怎么存、怎么自动带上」这条链路。
 *
 * 为什么不用 cookie：cookie 会随请求自动发送，既省掉这里的注入逻辑，也让 CSRF
 * 面变大（写操作就变成"能带着 cookie 就发"）。本系统是单机自托管、令牌只在
 * 启用鉴权时存在，用 localStorage + 显式注入把权限收得更紧。
 *
 * 两条注入路径（缺一不可）：
 *  1. `Authorization: Bearer` / `x-api-token` 头 —— 覆盖全部 axios REST 调用；
 *  2. `?token=` query —— **只为 SSE**。EventSource 是浏览器唯一能消费 text/event-stream
 *     的原生 API，而它**不允许自定义请求头**（无 header 选项），这不是本项目的选择。
 *     因此流式端点只能走 query。服务端日志与 telemetry 侧已有 sanitizeUrlForLog
 *     把非白名单 query 键的值替换成 [redacted]（见 server/src/utils/logSanitize.ts），
 *     故 `token` 不会落进日志文件或 span。
 */

const TOKEN_KEY = 'srs:api-token';

/** 读取已保存的令牌；未设置返回 null（= 服务端未启用鉴权时的常态） */
export function getApiToken(): string | null {
  try {
    const v = localStorage.getItem(TOKEN_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    // 隐私模式 / 存储被禁用：降级为"没令牌"，而不是让整个应用崩在读取上
    return null;
  }
}

/** 保存令牌（trim 后写入，空串视为清除） */
export function setApiToken(token: string): void {
  try {
    const t = token.trim();
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 存储不可用时静默失败：调用方随后会从 401 得到反馈 */
  }
}

/** 清除令牌（退出解锁状态） */
export function clearApiToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 同上 */
  }
}

/**
 * 给 URL 拼上 `token` query 参数（SSE 专用）。
 * 已有 query 时用 `&` 追加，避免覆盖调用方已设的参数。
 */
export function withTokenQuery(url: string): string {
  const token = getApiToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/* ===== 401 广播：让解锁条在任意页面出现 ===== */

type Listener = () => void;
const listeners = new Set<Listener>();
let unauthorized = false;

/** 是否已收到过 401（服务端启用了鉴权且当前令牌无效/缺失） */
export function isUnauthorized(): boolean {
  return unauthorized;
}

/**
 * 由 axios 响应拦截器调用：任一 REST 请求返回 401 即广播。
 *
 * 为什么放在拦截器而不是各页面自己判断：401 可能出现在任意端点（首屏的股票列表、
 * 成本面板、历史页…），逐个页面判断等于赌"用户触发的第一个请求恰好是某个已知端点"。
 * 拦截器是唯一能覆盖全部端点的位置。
 *
 * 注意 SSE 走 EventSource，**拿不到状态码**（失败只触发 onerror），因此流式端点的
 * 401 无法在此上报；实际上首屏的 REST 请求会先一步暴露问题，不影响解锁入口出现。
 */
export function notifyUnauthorized(): void {
  unauthorized = true;
  for (const fn of [...listeners]) fn();
}

/** 重置 401 状态（解锁成功后调用，避免旧标记继续弹解锁条） */
export function resetUnauthorized(): void {
  unauthorized = false;
}

/** 订阅 401 事件；返回取消订阅函数 */
export function onUnauthorized(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

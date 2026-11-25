/**
 * REST 封装的共享基础：带鉴权的 http 实例 + 统一错误层。
 * ----------------------------------------------------------------------------
 * 从 client.ts 拆出，目的是让 api/rest/* 各域模块共用同一个实例而不必反向
 * import client.ts —— client.ts 只做 barrel 再导出，反向依赖会形成循环。
 * 行为与原 client.ts 内联版本逐字一致（拦截器注册时机、文案、错误字段均未改）。
 */
import { getApiToken, notifyUnauthorized } from '../auth';
import http from '../http';

/** 全站唯一的 REST 实例（令牌注入与 401 广播都挂在这里） */
export const api = http.create({
  baseURL: '/api',
  timeout: 120000,
});

/**
 * 自动附带访问令牌（仅在用户已解锁时）。
 *
 * 为什么用拦截器而不是逐个请求传参：REST 端点有 30+ 个，逐个加参数等于给
 * 「某处忘传令牌」留下永久的坑——而那种坑的表现是"某个页面莫名其妙 401"，
 * 极难定位。拦截器是唯一能保证**新增端点默认就带鉴权**的位置。
 */
api.interceptors.request.use((config) => {
  const token = getApiToken();
  if (token) {
    // 用 set() 而非展开合并：拦截器拿到的 headers 是 Headers 实例，
    // 展开成普通对象会丢掉 set/get/has 等方法（TS 与运行时都会出问题）。
    config.headers.set('x-api-token', token);
  }
  return config;
});

/**
 * 收到 401 就广播出去，驱动解锁条出现（见 api/auth.ts 的 notifyUnauthorized）。
 * 必须在这里而不是各页面：401 可能来自任意端点，拦截器是唯一的全局覆盖点。
 *
 * 返回 rejected 原样透传：拦截器只观察、不吞错误，各调用方的错误处理逻辑不变。
 */
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401) notifyUnauthorized();
    return Promise.reject(error);
  },
);

/**
 * 带服务端排障元数据的 API 错误。
 * 文案（message）面向用户；requestId/code/retryAfter 面向排障与程序化重试——
 * 此前 normalizeApiError 只保留文案，服务端 429 的 Retry-After、错误体的
 * requestId/code 全被丢掉，排查时无法把前端报错与服务端日志对起来。
 */
export class ApiError extends Error {
  /** 服务端请求 ID（X-Request-ID 响应头优先，其次错误体 requestId） */
  requestId?: string;
  /** 机器可读错误码（如 ANALYSIS_IN_FLIGHT、LLM 排队超时 code） */
  code?: string;
  /** 建议重试等待秒数（Retry-After 响应头或错误体 retryAfter，按 HTTP 语义以秒计） */
  retryAfter?: number;
}

interface HttpErrorLike {
  code?: string;
  message?: string;
  response?: {
    status?: number;
    headers?: Record<string, unknown> & { get?: (name: string) => unknown };
    data?: {
      error?: string;
      message?: string;
      requestId?: string;
      code?: string;
      retryAfter?: number;
    };
  };
}

/** 从响应头/错误体提取排障元数据并挂到错误对象上（不改变文案语义） */
function attachErrorMetadata(err: ApiError, e: HttpErrorLike): ApiError {
  const headers = e.response?.headers;
  const data = e.response?.data;
  const header = (name: string): unknown =>
    typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  const requestId = header('x-request-id') ?? data?.requestId;
  if (typeof requestId === 'string' && requestId) err.requestId = requestId;
  if (typeof data?.code === 'string' && data.code) err.code = data.code;
  const retryAfterRaw = header('retry-after') ?? data?.retryAfter;
  const retryAfter = Number(retryAfterRaw);
  if (retryAfterRaw !== undefined && retryAfterRaw !== null && Number.isFinite(retryAfter)) {
    err.retryAfter = retryAfter;
  }
  return err;
}

/**
 * 把底层 HTTP 客户端（fetch）的原始错误翻译成用户能理解、能行动的中文提示。
 * 后端未启动时只会抛 "Network Error"，对用户毫无意义。
 */
/**
 * 后端不可达时的统一文案。前端走同源 /api（开发期由 Vite 代理），实际后端地址因部署而异，
 * 因此不写死 host:port——写死的 localhost:3001 在部署环境或改端口后会误导排查。
 */
export const BACKEND_UNREACHABLE_MESSAGE =
  '无法连接后端服务，请确认服务已启动后重试（本地运行可执行「启动系统.bat」）';

export function normalizeApiError(error: unknown, fallback = '请求失败'): ApiError {
  const e = error as HttpErrorLike;

  if (e?.code === 'ERR_CANCELED') return new ApiError('请求已取消');
  if (e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '')) {
    // 这里是所有接口共用的出口（自选股、模拟盘等 15s 短请求也会走到），
    // 文案不能只针对「个股分析」，否则用户在加载自选股时会看到「换一只标的」。
    return new ApiError('请求超时：服务端在预期时间内没有响应，请稍后重试');
  }
  if (e?.code === 'ERR_NETWORK' || e?.code === 'ECONNREFUSED') {
    return new ApiError(BACKEND_UNREACHABLE_MESSAGE);
  }
  if (!e?.response) {
    // 没有 response 且不是已知网络错误码（如前端自身 TypeError）：不能都归因为“后端没启动”，
    // 否则真正的代码错误会被误导成运维问题。
    return new ApiError(fallback);
  }

  const status = e.response.status;
  const data = e.response.data;
  // Vite 开发代理在后端未启动时回 502 + 机器码；文案由前端单一来源渲染，
  // 避免代理 body 里再写一份带 host:port 的提示绕过统一出口。
  if (status === 502 && data?.code === 'PROXY_ECONNREFUSED') {
    return new ApiError(BACKEND_UNREACHABLE_MESSAGE);
  }
  const serverMsg = data?.error || data?.message;
  if (serverMsg) return attachErrorMetadata(new ApiError(serverMsg), e);
  if (status === 404) {
    return attachErrorMetadata(new ApiError('接口不存在（404），请确认前后端版本一致'), e);
  }
  // 鉴权：只在服务端确实回 401 时提示"输令牌"。未启用鉴权时不存在这个状态码，
  // 所以本地开发不会看到这条提示。
  // 文案不写"右上角"这类方位词——解锁条的位置可能调整，写位置就等于给自己埋一个
  // 会过期的说明；只说"页面上的解锁条"，位置变了也不用改这句。
  if (status === 401) {
    return attachErrorMetadata(
      new ApiError('需要访问令牌：请在页面上的解锁条中填入 API_AUTH_TOKEN'),
      e,
    );
  }
  if (status === 429) return attachErrorMetadata(new ApiError('请求过于频繁，请稍后再试'), e);
  if (status && status >= 500) {
    return attachErrorMetadata(new ApiError(`后端服务异常（${status}），请查看服务端日志`), e);
  }
  return attachErrorMetadata(new ApiError(fallback), e);
}

/** 取消导致的 Promise 拒绝：调用方应静默处理（区别于真实失败） */
export class AnalysisCancelledError extends Error {
  constructor(message = '分析已取消') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

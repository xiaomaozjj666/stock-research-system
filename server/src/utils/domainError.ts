/**
 * 领域错误（Domain Error）：让「错误类型」而不是「中文错误文案」决定 HTTP 状态码。
 * ----------------------------------------------------------------------------
 * 此前多条路由用正则嗅探 message（如 /(需|不足|至少|一致|失败|必填)/）来判 400/502：
 *  - 任何含「失败」二字的**上游**异常会被当 400（客户端错误），客户端据此不会退避重试；
 *  - 新文案漏掉这些字眼就退化成 500；
 *  - 文案是给人看的，不该是协议的一部分。
 *
 * 约定：服务层在**确定**错误性质时抛 DomainError（带 status 与稳定 code），
 * 路由层按类型映射状态码；未类型化的异常一律按 500（意外）处理并记日志。
 * code 是给客户端程序判断用的稳定标识（如 'TS_DATA'），与 message 文案解耦。
 */

/** 可作为 HTTP 状态码回写的错误状态（只列本项目实际用到的） */
export type DomainErrorStatus = 400 | 409 | 422 | 429 | 502 | 503;

export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: DomainErrorStatus,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** 路由层统一回写：{ error, code? }（code 仅在携带时出现，保持既有响应契约） */
export function domainErrorPayload(error: DomainError): { error: string; code?: string } {
  return error.code ? { error: error.message, code: error.code } : { error: error.message };
}

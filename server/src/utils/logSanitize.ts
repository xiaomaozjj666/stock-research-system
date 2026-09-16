/**
 * 日志 / trace 的 URL 脱敏。
 * ----------------------------------------------------------------------------
 * 为什么需要：请求日志（index.ts）与 http span（services/telemetry.ts）此前记录的是
 * 完整 `req.originalUrl`，而本系统把**用户原文放在 query 里**：
 *   - `GET /api/chat/stream?message=<用户原话>`（可能含持仓、身份、自述）
 *   - `GET /api/stocks/search?keyword=<人名/公司名>`
 *   - `GET /api/llm/skills?message=<用户原话>`
 * 这些值一旦写进日志文件或 span（LOG_LEVEL=debug 时 span 整段落盘）就是隐私外泄，
 * 且落盘后无法回收。
 *
 * 策略：保留**路径** + 白名单 query 键的**值**，其余键只保留**键名**、值统一写
 * `[redacted]`。这样日志仍能回答"调了哪个接口、带了哪些参数"，但看不到参数内容；
 * 路径本身不含隐私（股票代码、资源 ID 都是公开标识）。
 */

/**
 * 白名单 query 键：全部是股票代码 / 市场 / 分页 / 日期 / 枚举这类**无隐私**参数。
 * 收录依据是「这个值写进日志会不会暴露用户是谁、问了什么」——会，就绝不收录：
 * message（用户原话）、keyword（搜索词）、q/query/text（自由文本）、sessionId
 * （可按会话把多条记录串起来还原用户）都不在表内。
 */
export const LOG_SAFE_QUERY_KEYS: readonly string[] = [
  // 标的
  'stockCode',
  'code',
  'code2',
  'market',
  'index',
  'board',
  'artCode',
  // 分页 / 规模
  'limit',
  'pageSize',
  'topN',
  'horizons',
  // 日期
  'startDate',
  'endDate',
  'date',
  // 枚举式过滤
  'resume',
  'source',
  'kept',
  'category',
  'riskLevel',
];

/** 非白名单 query 键的统一占位值（保留键名，抹掉值） */
export const REDACTED = '[redacted]';

/**
 * 把 URL（含 query）转成可安全写入日志/span 的形式。
 * - 无 query：原样返回（不解码、不重排，避免破坏既有日志逐字比对）；
 * - 有 query：`?key=value&secret=[redacted]`（重复键按原顺序逐条保留）；
 * - 非字符串 / 空值：返回 ''，调用方无需再判空。
 */
export function sanitizeUrlForLog(url: unknown): string {
  if (typeof url !== 'string' || url === '') return '';

  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return url;

  const pathPart = url.slice(0, queryIndex);
  let queryPart = url.slice(queryIndex + 1);
  let hashPart = '';
  const hashIndex = queryPart.indexOf('#');
  if (hashIndex !== -1) {
    hashPart = queryPart.slice(hashIndex);
    queryPart = queryPart.slice(0, hashIndex);
  }
  if (queryPart === '') return url;

  const params = new URLSearchParams(queryPart);
  const safe = LOG_SAFE_QUERY_KEYS as readonly string[];
  const parts: string[] = [];
  for (const [key, value] of params) {
    parts.push(`${key}=${safe.includes(key) ? value : REDACTED}`);
  }
  // 形如 "?&&" 这类解析不出任何键值的畸形 query：整体记 [redacted]，不原样带出去
  const rendered = parts.length > 0 ? parts.join('&') : REDACTED;
  return `${pathPart}?${rendered}${hashPart}`;
}

/**
 * ============================================================================
 * 日志 / span 的 URL 脱敏单测（utils/logSanitize.ts）
 *
 * 背景（审计）：请求日志（index.ts）与 http span（services/telemetry.ts）此前
 * 记录完整 req.originalUrl，而本系统把**用户原文放在 query 里**：
 *   - /api/chat/stream?message=<用户原话>
 *   - /api/stocks/search?keyword=<人名/公司名>
 * 日志与 span（debug 导出整段落盘）都会把这些值写出去，属隐私外泄。
 *
 * 契约：路径 + 白名单键的**值**照旧可见（都是股票代码/分页/日期这类无隐私参数），
 * 非白名单键只留**键名**、值统一记 [redacted]。
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import { sanitizeUrlForLog, LOG_SAFE_QUERY_KEYS, REDACTED } from '../logSanitize.js';

describe('sanitizeUrlForLog', () => {
  it('用户原话（message）被抹掉，但路径与参数键名仍可见', () => {
    const out = sanitizeUrlForLog(
      '/api/chat/stream?message=我持有贵州茅台，成本1680&sessionId=abc-123',
    );

    expect(out).toBe(`/api/chat/stream?message=${REDACTED}&sessionId=${REDACTED}`);
    expect(out).not.toContain('贵州茅台');
    expect(out).not.toContain('1680');
    expect(out).not.toContain('abc-123');
    // 仍能看出"调了哪个接口、带了哪些参数"
    expect(out.startsWith('/api/chat/stream?')).toBe(true);
    expect(out).toContain('message=');
  });

  it('搜索关键词（keyword，可能是人名）被抹掉', () => {
    const out = sanitizeUrlForLog('/api/stocks/search?keyword=张三');

    expect(out).toBe(`/api/stocks/search?keyword=${REDACTED}`);
    expect(out).not.toContain('张三');
  });

  it('白名单参数（股票代码/分页/日期/枚举）保留原值，便于排障', () => {
    const out = sanitizeUrlForLog(
      '/api/intl/klines?code=00700&market=HK&startDate=2024-01-01&endDate=2024-06-30&limit=50',
    );

    expect(out).toBe(
      '/api/intl/klines?code=00700&market=HK&startDate=2024-01-01&endDate=2024-06-30&limit=50',
    );
    expect(sanitizeUrlForLog('/api/analyze/stream?stockCode=600519&resume=1')).toBe(
      '/api/analyze/stream?stockCode=600519&resume=1',
    );
  });

  it('白名单/非白名单混排：逐个键判定，不因一个敏感键丢掉其余信息', () => {
    const out = sanitizeUrlForLog(
      '/api/quant/announcements?code=600519&artCode=ABC123&q=内部关键词',
    );

    expect(out).toBe(`/api/quant/announcements?code=600519&artCode=ABC123&q=${REDACTED}`);
  });

  it('无 query 的 URL 原样返回（不解码、不重排，保持既有日志逐字可比）', () => {
    expect(sanitizeUrlForLog('/api/health')).toBe('/api/health');
    expect(sanitizeUrlForLog('/api/quant/research-memory/600519')).toBe(
      '/api/quant/research-memory/600519',
    );
  });

  it('非字符串 / 空值 / 只有问号：稳定返回，不抛错', () => {
    expect(sanitizeUrlForLog(undefined)).toBe('');
    expect(sanitizeUrlForLog(null)).toBe('');
    expect(sanitizeUrlForLog('')).toBe('');
    expect(sanitizeUrlForLog('/api/health?')).toBe('/api/health?');
  });

  it('保留下 URL fragment，且畸形 query 整体记 [redacted]（不原样带出去）', () => {
    expect(sanitizeUrlForLog('/api/x?a=1#frag')).toBe(`/api/x?a=${REDACTED}#frag`);
    expect(sanitizeUrlForLog('/api/x?&&&')).toBe(`/api/x?${REDACTED}`);
  });

  it('重复键逐条保留（不合并、不丢条数）', () => {
    expect(sanitizeUrlForLog('/api/x?code=600519&code=000858&kw=a&kw=b')).toBe(
      `/api/x?code=600519&code=000858&kw=${REDACTED}&kw=${REDACTED}`,
    );
  });

  it('白名单本身不含自由文本 / 会话标识（防后人误加）', () => {
    for (const risky of ['message', 'keyword', 'q', 'query', 'text', 'sessionId', 'prompt']) {
      expect(LOG_SAFE_QUERY_KEYS).not.toContain(risky);
    }
  });
});

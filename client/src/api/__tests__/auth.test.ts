// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getApiToken,
  setApiToken,
  clearApiToken,
  withTokenQuery,
  notifyUnauthorized,
  isUnauthorized,
  resetUnauthorized,
  onUnauthorized,
} from '../auth';

/**
 * 浏览器侧令牌持有的契约。
 *
 * 最要紧的不变量：**未解锁（无令牌）时所有产物与"没有这个模块"逐字相同**——
 * URL 不被追加任何东西。本系统默认不鉴权，任何多余参数都会变成回归。
 */

const KEY = 'srs:api-token';

beforeEach(() => {
  localStorage.clear();
  resetUnauthorized();
});

describe('get/set/clear', () => {
  it('未设置时返回 null（服务端未启用鉴权的常态）', () => {
    expect(getApiToken()).toBeNull();
  });

  it('设置后可读回', () => {
    setApiToken('tok-123');
    expect(getApiToken()).toBe('tok-123');
  });

  it('写入前 trim，避免复制粘贴带空格导致 401', () => {
    setApiToken('  tok-456  ');
    expect(getApiToken()).toBe('tok-456');
  });

  it('空白串视为清除，而不是存一个空令牌', () => {
    setApiToken('tok-789');
    setApiToken('   ');
    expect(getApiToken()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('clearApiToken 清掉已存的令牌', () => {
    setApiToken('tok-abc');
    clearApiToken();
    expect(getApiToken()).toBeNull();
  });

  it('localStorage 抛错时降级为 null，而不是让应用崩在读取上', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(getApiToken()).toBeNull();
    spy.mockRestore();
  });
});

describe('withTokenQuery（SSE 专用注入）', () => {
  it('无令牌时 URL 逐字不变（默认路径零影响）', () => {
    const url = '/api/analyze/stream?stockCode=600519';
    expect(withTokenQuery(url)).toBe(url);
  });

  it('已有 query 时用 & 追加', () => {
    setApiToken('tok-1');
    expect(withTokenQuery('/api/analyze/stream?stockCode=600519')).toBe(
      '/api/analyze/stream?stockCode=600519&token=tok-1',
    );
  });

  it('无 query 时用 ? 追加', () => {
    setApiToken('tok-2');
    expect(withTokenQuery('/api/chat/stream')).toBe('/api/chat/stream?token=tok-2');
  });

  it('令牌含特殊字符时正确编码（否则会截断 URL）', () => {
    setApiToken('a b&c=d');
    const out = withTokenQuery('/api/chat/stream?message=hi');
    expect(out).toBe('/api/chat/stream?message=hi&token=a%20b%26c%3Dd');
    // 反解回原值，确保编码的是完整令牌
    expect(new URL(out, 'http://x').searchParams.get('token')).toBe('a b&c=d');
  });

  it('resume 参数存在时同样正确追加', () => {
    setApiToken('tok-3');
    expect(withTokenQuery('/api/analyze/stream?stockCode=600519&resume=1')).toContain(
      'resume=1&token=tok-3',
    );
  });
});

describe('401 广播', () => {
  it('默认不处于未授权状态', () => {
    expect(isUnauthorized()).toBe(false);
  });

  it('notifyUnauthorized 置位并通知订阅者', () => {
    const fn = vi.fn();
    onUnauthorized(fn);
    notifyUnauthorized();
    expect(isUnauthorized()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('取消订阅后不再收到通知', () => {
    const fn = vi.fn();
    const off = onUnauthorized(fn);
    off();
    notifyUnauthorized();
    expect(fn).not.toHaveBeenCalled();
  });

  it('多个订阅者都被通知', () => {
    const a = vi.fn();
    const b = vi.fn();
    onUnauthorized(a);
    onUnauthorized(b);
    notifyUnauthorized();
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('resetUnauthorized 清掉标记（解锁后不再弹解锁条）', () => {
    notifyUnauthorized();
    resetUnauthorized();
    expect(isUnauthorized()).toBe(false);
  });
});

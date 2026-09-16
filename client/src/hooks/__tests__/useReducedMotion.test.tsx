// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducedMotion } from '../useReducedMotion';
import { useCountUp } from '../useCountUp';

interface Listener {
  (event: { matches: boolean }): void;
}

/**
 * jsdom 没有 matchMedia，按测试需要造一个可控实现。
 * legacy=true 时只提供已废弃的 addListener/removeListener（老 Safari 形态）。
 */
function stubMatchMedia(initialMatches: boolean, legacy = false) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialMatches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_type: string, cb: Listener) => listeners.delete(cb),
    addListener: legacy ? (cb: Listener) => listeners.add(cb) : undefined,
    removeListener: legacy ? (cb: Listener) => listeners.delete(cb) : undefined,
  };
  const matchMedia = vi.fn(() => mql);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    listenerCount: () => listeners.size,
    emit(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((cb) => cb({ matches }));
    },
  };
}

describe('useReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('无 matchMedia 时返回 false 且不抛错（jsdom / 老浏览器）', () => {
    // jsdom 默认就没有 window.matchMedia：直接调用会 TypeError 打断整棵树
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('系统已开启「减少动态效果」时返回 true', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('系统偏好变化时实时更新', () => {
    const mm = stubMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    act(() => mm.emit(true));
    expect(result.current).toBe(true);
    act(() => mm.emit(false));
    expect(result.current).toBe(false);
  });

  it('卸载时移除 change 监听（否则 MediaQueryList 会一直持有已卸载组件）', () => {
    const mm = stubMatchMedia(false);
    const { unmount } = renderHook(() => useReducedMotion());
    expect(mm.listenerCount()).toBe(1);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });

  it('兼容只有 addListener/removeListener 的老实现', () => {
    const mm = stubMatchMedia(false, true);
    const { result, unmount } = renderHook(() => useReducedMotion());
    act(() => mm.emit(true));
    expect(result.current).toBe(true);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });
});

describe('useCountUp —— reduced-motion 覆盖 JS 动画', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reduced 时直接返回目标值，且不排 rAF 帧（不做补间）', () => {
    stubMatchMedia(true);
    const raf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { result } = renderHook(() => useCountUp(85, 1200, 0));

    expect(result.current).toBe(85);
    expect(raf).not.toHaveBeenCalled();
  });

  it('reduced 时按 decimals 取整（与补间最后一帧口径一致）', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useCountUp(12.3456, 1000, 2));
    expect(result.current).toBe(12.35);
  });

  it('未开启 reduced 时仍走 rAF 补间（行为不回归）', () => {
    stubMatchMedia(false);
    const frames: ((t: number) => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) => frames.push(fn));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { result } = renderHook(() => useCountUp(100, 1000, 0));
    expect(result.current).toBe(0); // 起始值
    expect(frames.length).toBe(1);

    act(() => frames[0]?.(performance.now() + 1000)); // 走完整个时长
    expect(result.current).toBe(100);
  });

  it('目标值为 0 时不启动动画（保持既有短路逻辑）', () => {
    stubMatchMedia(false);
    const raf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { result } = renderHook(() => useCountUp(0, 1200, 0));
    expect(result.current).toBe(0);
    expect(raf).not.toHaveBeenCalled();
  });
});

import { useEffect, useState } from 'react';

/** 系统级「减少动态效果」偏好查询串 */
const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 读取当前系统偏好。
 * 为什么单独抽函数：jsdom（单测）与部分老浏览器没有 matchMedia，
 * 直接调用会抛 "window.matchMedia is not a function" 把整个组件树打断，
 * 因此统一走「无 matchMedia → 按未开启处理」，保持既有动画行为。
 */
function readPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * 系统「减少动态效果」偏好（prefers-reduced-motion: reduce）
 * ----------------------------------------------------------------------------
 * index.css 里的 @media (prefers-reduced-motion: reduce) 只能关掉 CSS 动画/过渡，
 * 关不掉 JS 驱动的动画：useCountUp 的 rAF 补间、ECharts 的 canvas 入场动画
 * 都会照常播放。这些地方必须读同一个媒体查询，才能与 CSS 侧口径一致。
 *
 * 返回值随系统设置实时变化（用户在系统里改了偏好无需刷新页面）。
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readPreference);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    // 首次渲染到 effect 执行之间用户可能已改设置，订阅前先同步一次
    setReduced(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);

    // 兼容老 Safari（<14）/旧内核：只有已废弃的 addListener/removeListener
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    // 卸载时必须移除监听：LoadingScreen/DashboardCards 会随分析状态反复挂载，
    // 漏掉清理会让 MediaQueryList 一直持有已卸载组件的 setState
    return () => mql.removeListener(onChange);
  }, []);

  return reduced;
}

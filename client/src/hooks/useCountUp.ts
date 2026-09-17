import { useEffect, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

export function useCountUp(target: number, duration = 1200, decimals = 0) {
  const [value, setValue] = useState(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    // 系统开启「减少动态效果」时不做补间：数字滚动属于纯粹的装饰性动画，
    // 且 index.css 的 @media (prefers-reduced-motion) 管不到 rAF 驱动的 JS 动画
    if (reduced) return;
    // 注意 target === 0 不能短路：依赖变化是合法的（如换到没有 PE 的标的、
    // 或同一只重跑后估值字段缺失），短路会让 state 永久停在上一轮的数字，
    // 把别的标的的 PE/PB 显示在当前标的上。target=0 时补间首帧即落到 0，无动画代价。
    let rafId = 0;
    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Number((eased * target).toFixed(decimals)));
      if (progress < 1) rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);
    // 卸载/target 变化时取消旧动画，避免两个 rAF 循环并发 setValue
    return () => cancelAnimationFrame(rafId);
  }, [target, duration, decimals, reduced]);

  // reduced 时直接返回目标值（不经 state）：省掉一次渲染，也避免首帧仍显示 0
  // 再跳到终值的闪烁。四舍五入口径与动画最后一帧保持一致（同样保留 decimals）。
  return reduced ? Number(target.toFixed(decimals)) : value;
}

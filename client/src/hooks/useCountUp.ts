import { useEffect, useState } from 'react';

export function useCountUp(target: number, duration = 1200, decimals = 0) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (target === 0) return;
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
  }, [target, duration, decimals]);

  return value;
}

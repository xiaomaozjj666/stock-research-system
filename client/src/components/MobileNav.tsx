import { useEffect, useId, useRef, useState } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion';

const navItems = [
  { id: 'summary', label: '核心摘要' },
  { id: 'financial', label: '财务分析' },
  { id: 'charts', label: '数据图表' },
  { id: 'valuation', label: '估值分析' },
  { id: 'experts', label: '专家观点' },
  { id: 'capital', label: '资金筹码' },
  { id: 'scenario', label: '情景推演' },
  { id: 'strategy', label: '量化策略' },
  { id: 'scoring', label: '综合评分' },
  { id: 'controversy', label: '争议焦点' },
  { id: 'risk', label: '风险清单' },
  { id: 'reflection', label: '自省校验' },
  { id: 'limitation', label: '研究局限性' },
  { id: 'followup', label: '跟踪指标' },
];

export default function MobileNav({ activeSection }: { activeSection: string }) {
  const [open, setOpen] = useState(false);
  // 系统「减少动态效果」偏好：平滑滚动是 JS 驱动的，CSS 的 @media 覆盖不到
  const reducedMotion = useReducedMotion();
  // 抽屉容器 id（useId 保证唯一）：供切换按钮的 aria-controls 指向
  const dropdownId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  /** 关闭抽屉并把焦点交还切换按钮（preventScroll：不打断目录项的平滑滚动定位） */
  const closeNav = () => {
    setOpen(false);
    toggleRef.current?.focus({ preventScroll: true });
  };

  const handleClick = (id: string) => {
    closeNav();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    }
  };

  // 仅在抽屉打开时绑定：Esc 关闭并归还焦点；打开即把焦点移入抽屉第一项
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    firstItemRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="mobile-nav">
      <button
        ref={toggleRef}
        className={`mobile-nav-toggle ${open ? 'open' : ''}`}
        onClick={() => (open ? closeNav() : setOpen(true))}
        aria-label="目录导航"
        aria-expanded={open}
        aria-controls={dropdownId}
      >
        <span className="mobile-nav-icon" />
        <span className="mobile-nav-label">目录</span>
      </button>

      {open && (
        <div className="mobile-nav-dropdown" id={dropdownId} role="dialog" aria-label="目录">
          {navItems.map((item, i) => (
            <button
              key={item.id}
              ref={i === 0 ? firstItemRef : undefined}
              className={`mobile-nav-item ${activeSection === item.id ? 'active' : ''}`}
              onClick={() => handleClick(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

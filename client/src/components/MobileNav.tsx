import { useState } from 'react';

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

  const handleClick = (id: string) => {
    setOpen(false);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="mobile-nav">
      <button
        className={`mobile-nav-toggle ${open ? 'open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-label="目录导航"
      >
        <span className="mobile-nav-icon" />
        <span className="mobile-nav-label">目录</span>
      </button>

      {open && (
        <div className="mobile-nav-dropdown">
          {navItems.map((item) => (
            <button
              key={item.id}
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

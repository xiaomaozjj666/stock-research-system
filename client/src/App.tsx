import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { analyzeStockStream, AnalysisCancelledError, type AnalysisStage } from './api/client';
import type { AnalysisResult } from './types';
import StockSelector from './components/StockSelector';
import LoadingScreen from './components/LoadingScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import ReportHeader from './components/ReportHeader';
import CoreSummary from './components/CoreSummary';
import FinancialSection from './components/FinancialSection';
import ValuationSection from './components/ValuationSection';
import ExpertOpinions from './components/ExpertOpinions';
import CapitalFlowSection from './components/CapitalFlowSection';
import ScenarioSection from './components/ScenarioSection';
import StrategyListSection from './components/StrategyListSection';
import NewsSentimentCard from './components/NewsSentimentCard';
import ConsensusCard from './components/ConsensusCard';
import ScoringTable from './components/ScoringTable';
import ControversySection from './components/ControversySection';
import RiskSection from './components/RiskSection';
import ReflectionSection from './components/ReflectionSection';
import FollowUpSection from './components/FollowUpSection';
import MobileNav from './components/MobileNav';
import ChatPanel from './components/ChatPanel';
import { useToast } from './components/Toast';
import { generateReportMarkdown, downloadMarkdown } from './utils/reportExport';
import { useCountUp } from './hooks/useCountUp';

// 路由级懒加载：减小首屏体积，量化/对比/模拟盘/自选股/历史页按需加载
const QuantPage = lazy(() => import('./pages/quant/QuantPage'));
const ComparisonView = lazy(() => import('./components/ComparisonView'));
const PaperTradingPage = lazy(() => import('./pages/paper/PaperTradingPage'));
const WatchlistPage = lazy(() => import('./pages/watchlist/WatchlistPage'));
const HistoryPage = lazy(() => import('./pages/history/HistoryPage'));
// 图表区懒加载：echarts 运行时（~196KB gzip）不再随首屏预加载，
// 仅在分析结果出现、真正需要渲染图表时才拉取
const ChartsSection = lazy(() => import('./components/ChartsSection'));

/* ===== 全局快捷键用的小工具（模块级：不依赖组件闭包，也不必每次渲染重建） ===== */

/** 顶部股票搜索输入框的 id：与 components/StockSelector.tsx 中 input 上的 id 保持一致 */
const SEARCH_INPUT_ID = 'global-stock-search';

/**
 * 取顶部搜索输入框。取不到（组件尚未挂载、或被测试替身替换）返回 null，
 * 快捷键据此退化为「提示」而不是拿猜测的输入值发起分析。
 */
function getSearchInput(): HTMLInputElement | null {
  const el = document.getElementById(SEARCH_INPUT_ID);
  return el instanceof HTMLInputElement ? el : null;
}

/** 焦点是否落在可编辑元素上：数字键切 tab 必须避开，否则数字会被打进输入框 */
function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * tab 面板容器：外层的普通 div 承担 hidden —— 各页面根节点（.quant-page / .chat-panel 等）
 * 自带 display: grid/flex，作者样式会盖掉浏览器对 [hidden] 的 display: none，
 * 用无样式的 div 包裹即可让 hidden 生效，无需改各页面。
 * 内层独立 Suspense：若共用一个边界，新面板首次拉取 chunk 会把整块区域（含已挂载的
 * 隐藏面板）一起切到 fallback；独立边界则互不影响。
 * hidden 不会阻止 lazy 加载：切走后 chunk 仍继续拉取并挂载，切回来直接可显示。
 */
function TabPane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div hidden={!active}>
      <Suspense fallback={<div className="page-suspense">页面加载中…</div>}>{children}</Suspense>
    </div>
  );
}

/* ===== 区块包裹：仅保留锚点 id 与滚动偏移，不做入场动画 ===== */
function RevealSection({
  children,
  id,
  className = '',
}: {
  children: React.ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <div id={id} className={className} style={{ scrollMarginTop: 96 }}>
      {children}
    </div>
  );
}

/* ===== Dashboard with count-up ===== */
function DashboardCards({ data }: { data: AnalysisResult['stock_pool'][0] }) {
  const totalScore = useCountUp(data.total_score, 1200, 0);
  const pe = useCountUp(data.valuation?.pe ?? 0, 1000, 1);
  const pb = useCountUp(data.valuation?.pb ?? 0, 1000, 2);

  return (
    <div className="dashboard-cards">
      <div className="dash-card">
        <div className="dash-label">综合评分</div>
        <div className="dash-value accent">
          {totalScore}
          <span className="dash-unit">/100</span>
        </div>
      </div>
      <div className="dash-card">
        <div className="dash-label">投资评级</div>
        <div className="dash-value">{data.rating}</div>
      </div>
      <div className="dash-card">
        <div className="dash-label">当前价格</div>
        <div className="dash-value">¥{data.valuation?.currentPrice?.toFixed(2) || '—'}</div>
      </div>
      <div className="dash-card">
        <div className="dash-label">PE / PB</div>
        <div className="dash-value">
          {pe || '—'} / {pb || '—'}
        </div>
      </div>
      <div className="dash-card">
        <div className="dash-label">市值</div>
        <div className="dash-value">
          {(data.valuation?.marketCap ?? 0) >= 10000
            ? ((data.valuation?.marketCap ?? 0) / 10000).toFixed(1) + ' 万亿'
            : (data.valuation?.marketCap ?? 0).toFixed(0) + ' 亿'}
        </div>
      </div>
    </div>
  );
}

type TabId = 'research' | 'quant' | 'compare' | 'watchlist' | 'paper' | 'chat' | 'history';

/** 顶部功能导航：集中定义便于 ARIA tablist 的键盘导航（←/→/Home/End） */
const TABS: { id: TabId; label: string }[] = [
  { id: 'research', label: '深度研究' },
  { id: 'quant', label: '量化研究' },
  { id: 'compare', label: '对比分析' },
  { id: 'watchlist', label: '自选股' },
  { id: 'paper', label: '模拟盘' },
  { id: 'chat', label: '研究助手' },
  { id: 'history', label: '历史' },
];

function App() {
  const { showToast } = useToast();
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [analysisStage, setAnalysisStage] = useState<AnalysisStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState('');
  const [activeTab, setActiveTab] = useState<
    'research' | 'quant' | 'compare' | 'watchlist' | 'paper' | 'chat' | 'history'
  >('research');
  /**
   * 已激活过的 tab 集合：首次激活才挂载，之后常驻（非激活时靠 hidden 隐藏）。
   * 原先用 activeTab === 'xxx' && 条件渲染，切走即卸载，导致「对比已选股票」「模拟盘
   * 已填的下单参数」「研究助手整段对话」全部丢失；与 QuantPage 内部三个子模式的
   * 「常驻挂载 + hidden」保持一致。未激活过的 tab 仍不渲染，避免首屏并发取数。
   */
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(() => new Set<TabId>(['research']));
  /**
   * 当前 tab 的镜像值：滚动监听只注册一次（[] 依赖），又需要知道报告面板是否可见
   * （见滚动监听内注释），故用 ref 传值。
   */
  const activeTabRef = useRef<TabId>(activeTab);
  /** 最近一次分析的代码，用于失败后一键重试 */
  const lastCodeRef = useRef<string>('');
  /** tab 按钮引用：ARIA tablist 的方向键导航需要把焦点移到目标 tab */
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  /** 是否处于"回看历史快照"模式（顶部提示条；新分析开始即退出） */
  const [viewingHistory, setViewingHistory] = useState(false);
  /** 滚动超过阈值时显示"回到顶部"浮动按钮 */
  const [showBackTop, setShowBackTop] = useState(false);

  /** 导出当前报告为 Markdown（前端生成 + 下载） */
  const handleExport = useCallback(() => {
    if (!analysisResult) return;
    try {
      const item = analysisResult.stock_pool[0];
      if (!item) {
        showToast('导出失败：报告内容为空', 'error');
        return;
      }
      const md = generateReportMarkdown(analysisResult);
      downloadMarkdown(`${item.stock_name}(${item.stock_code})_研究报告.md`, md);
      showToast('研究报告已导出');
    } catch {
      showToast('导出失败，请重试', 'error');
    }
  }, [analysisResult, showToast]);

  // 页面标题随当前分析/历史快照更新（标签页可读性）
  useEffect(() => {
    const item = analysisResult?.stock_pool?.[0];
    document.title = item
      ? `${item.stock_name}(${item.stock_code}) 研究报告 - 投研系统`
      : '投研系统 - 多专家股票研究';
  }, [analysisResult]);
  /** 在途 SSE 的取消函数 */
  const cancelRef = useRef<(() => void) | null>(null);
  /** 分析代际号：旧分析的收尾逻辑不得清理新分析的状态 */
  const analyzeSeqRef = useRef(0);

  // 跟踪当前 tab（供滚动监听的可见性判断使用，避免为它重新注册监听）
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // 激活即登记：hidden 常驻挂载后，离开的 tab 仍留在树里，靠这个集合保证不被卸载
  useEffect(() => {
    setMountedTabs((prev) => {
      if (prev.has(activeTab)) return prev; // 引用不变 → 不触发多余渲染
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  // 滚动监听，更新导航高亮 + 滚动进度
  // 用 rAF 节流，避免高频 setState 引发重渲染；section 仅在变化时才 setState
  useEffect(() => {
    let ticking = false;
    let lastSection = '';
    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        // 报告面板隐藏时（已切到其他 tab）不推进高亮：hidden 元素 rect 全为 0，
        // 会被末尾兜底分支误判成「已滚到跟踪指标」，切回报告时侧栏高亮就是错的
        if (activeTabRef.current !== 'research') return;
        // 回到顶部按钮：仅在跨越阈值时更新状态（避免每帧 setState）
        setShowBackTop((prev) => {
          const next = window.scrollY > 600;
          return prev === next ? prev : next;
        });

        const sections = [
          'summary',
          'financial',
          'charts',
          'valuation',
          'experts',
          'capital',
          'scenario',
          'strategy',
          'scoring',
          'controversy',
          'risk',
          'reflection',
          'limitation',
          'followup',
        ];

        // 高亮判定：视口中心线——包含视口中心（innerHeight/2）的区块为"当前区块"。
        // 相比"顶部 150px 判定线"，矮区块（如研究局限性仅 ~146px）的高亮窗口
        // 从 ~21px 滚动距离扩大到整个区块高度（~146px），滚轮滚动不再"跳过"。
        const vh = window.innerHeight;
        const mid = vh / 2;
        const lastId = sections[sections.length - 1];
        const atBottom = window.scrollY + vh >= document.documentElement.scrollHeight - 2;
        // 到底兜底：末尾区块已在视口内（部分可见）时直接高亮它（含浮点容差）
        if (atBottom) {
          const lastEl = document.getElementById(lastId);
          if (lastEl) {
            const r = lastEl.getBoundingClientRect();
            if (r.top < vh + 1 && r.bottom > -1) {
              if (lastSection !== lastId) {
                lastSection = lastId;
                setActiveSection(lastId);
              }
              return;
            }
          }
        }
        let matched = false;
        // 浮点容差：区块边界与中心线恰好重合时（如 limitation 底部 = 视口中心），
        // getBoundingClientRect 返回 360.5 之类的小数，严格 <= 会漏判
        const EPS = 1;
        for (const id of sections) {
          const el = document.getElementById(id);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.top <= mid + EPS && rect.bottom >= mid - EPS) {
              if (id !== lastSection) {
                lastSection = id;
                setActiveSection(id);
              }
              matched = true;
              break;
            }
          }
        }
        // 常规判定无结果且已到底：末尾区块贴底（中心线未触及），补高亮它
        if (!matched && atBottom && lastSection !== lastId) {
          lastSection = lastId;
          setActiveSection(lastId);
        }
      });
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleAnalyze = useCallback(async (stockCode: string, opts?: { resume?: boolean }) => {
    // 有在途分析先取消，避免两条 SSE 竞争写同一份状态
    cancelRef.current?.();
    lastCodeRef.current = stockCode;
    const gen = ++analyzeSeqRef.current;
    // 顶部搜索在任意页可用：发起分析必须切回深度研究页，
    // 否则加载屏（只渲染在 research tab）不可见，用户点了没反应
    setActiveTab('research');
    setLoading(true);
    setError(null);
    setAnalysisStage(null);
    setViewingHistory(false); // 新分析开始：退出历史快照模式
    try {
      const { done, cancel } = analyzeStockStream(
        stockCode,
        (stage) => {
          setAnalysisStage(stage);
        },
        { resume: opts?.resume === true },
      );
      cancelRef.current = cancel;
      const result = await done;
      if (gen !== analyzeSeqRef.current) return; // 已被更新的分析接管
      setAnalysisResult(result);
    } catch (err: unknown) {
      // cancel() 触发的拒绝：状态由新分析或手动取消逻辑接管，此处不覆盖
      if (err instanceof AnalysisCancelledError) return;
      if (gen !== analyzeSeqRef.current) return;
      const message = err instanceof Error ? err.message : '分析请求失败';
      setError(message);
    } finally {
      if (gen === analyzeSeqRef.current) {
        cancelRef.current = null;
        setLoading(false);
        setAnalysisStage(null);
      }
    }
  }, []);

  const handleRetry = useCallback(() => {
    // 失败重试默认走断点续跑：从服务端最后成功阶段继续，不重复支付已完成的 LLM 成本；
    // 无断点或断点过期时服务端会自动全新开始。
    if (lastCodeRef.current) handleAnalyze(lastCodeRef.current, { resume: true });
  }, [handleAnalyze]);

  const handleCancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setLoading(false);
    setAnalysisStage(null);
    setError('已取消本次分析');
  }, []);

  // 卸载时中断在途 SSE，避免内存泄漏与无效 setState
  useEffect(() => () => cancelRef.current?.(), []);

  /* ===== 全局快捷键：Ctrl/⌘+K 聚焦搜索、Ctrl/⌘+Enter 直接分析、1~7 切 tab ===== */
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // ① Ctrl/⌘+K：聚焦顶部搜索框（并全选，便于直接覆盖输入新代码）
      if (mod && (e.key === 'k' || e.key === 'K')) {
        const input = getSearchInput();
        if (!input) return;
        // 必须 preventDefault：否则 Chrome/Firefox 会把焦点抢到地址栏/浏览器搜索栏
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }

      // ② Ctrl/⌘+Enter：用当前输入框里的股票代码发起分析
      if (mod && e.key === 'Enter') {
        const input = getSearchInput();
        const editing = isEditableTarget(e.target);
        // 焦点在「别的输入框/文本域」时不抢这个组合键：
        // ChatPanel 的 Enter（不看修饰键）即发送、FollowUpSection 的输入框 Enter 即新增指标，
        // 二者都会与全局分析同时触发（一次按键两个动作），而它们不在本次可改范围内。
        // 焦点在正文/按钮/搜索框（最常见两种用法）时照常生效。
        if (editing && e.target !== input) return;
        e.preventDefault();
        // data-stock-code 由 StockSelector 维护：点选下拉项后输入框显示的是「名称」，
        // 只有该属性才是当前真正可分析的代码，读 input.value 会取到名称而失效
        const code = input?.dataset.stockCode ?? '';
        if (code) {
          if (loading) {
            showToast('分析进行中，请稍候');
            return;
          }
          handleAnalyze(code);
          return;
        }
        // 取不到可靠代码时不猜：聚焦搜索框并提示（若用户正在别处输入，则只提示不抢焦点）
        if (!editing) input?.focus();
        showToast('请先输入 6 位股票代码');
        return;
      }

      // ③ 1~7：切换到第 N 个 tab（输入框/文本域聚焦时屏蔽，否则数字会被打进输入框）
      // 带修饰键的数字键不拦：Ctrl/⌘+1~9 是浏览器/系统的标签页切换，不应被页面劫持
      if (!mod && !e.altKey && !isEditableTarget(e.target) && /^[1-7]$/.test(e.key)) {
        const tab = TABS[Number(e.key) - 1];
        if (!tab) return;
        e.preventDefault();
        setActiveTab(tab.id);
        // 焦点跟随（与 tablist 方向键一致）；preventScroll 避免在长报告中部按数字键时页面被拉回顶部
        tabRefs.current[tab.id]?.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleAnalyze, loading, showToast]);

  /** tablist 键盘导航（WAI-ARIA 惯例：←/→ 循环切换，Home/End 到首尾） */
  const handleTabKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const idx = TABS.findIndex((t) => t.id === activeTab);
      let next = -1;
      if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TABS.length - 1;
      if (next < 0) return;
      e.preventDefault();
      const target = TABS[next].id;
      setActiveTab(target);
      tabRefs.current[target]?.focus();
    },
    [activeTab],
  );

  const stockData = analysisResult?.stock_pool?.[0];
  /**
   * 是否渲染该面板：当前 tab 在渲染期即视为已挂载 —— 否则「点击 → effect 补登记」
   * 之间会先渲染一帧空面板（useEffect 在提交/绘制之后才跑）。
   */
  const shouldRenderTab = (tab: TabId) => {
    // 「历史」例外：该页没有任何需要保留的输入态，且它只在挂载时取一次数据。
    // 若随其它面板一起常驻，新分析入库后再切回会看不到最新一条（需刷新页面），
    // 因此让它随切换卸载/重挂，进入即取最新列表。
    if (tab === 'history') return activeTab === 'history';
    return tab === activeTab || mountedTabs.has(tab);
  };

  return (
    <div className="app">
      <StockSelector onAnalyze={handleAnalyze} loading={loading} />

      <div className="tab-bar" role="tablist" aria-label="功能导航" onKeyDown={handleTabKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={activeTab === t.id}
            // 漫游 tabindex：只有当前 tab 可 Tab 聚焦，其余用方向键切换
            tabIndex={activeTab === t.id ? 0 : -1}
            className={`tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 深度研究面板：非 lazy，始终挂载；切走时仅 hidden（保留报告与滚动锚点，
          避免每次切回来都重排整份报告）。普通 div 保证 [hidden] 的 display:none 生效 */}
      <div hidden={activeTab !== 'research'}>
        {loading && (
          <>
            <LoadingScreen stage={analysisStage} />
            <div className="loading-actions">
              <button className="btn-ghost" onClick={handleCancel}>
                取消分析
              </button>
            </div>
          </>
        )}
        {!loading && !error && !stockData && (
          <div className="research-empty">
            <div className="research-empty-card">
              <h2>多专家深度研究</h2>
              <p className="research-empty-desc">
                输入 6 位股票代码或点击上方快捷标签，8 位独立研判专家（基本面 / 估值 / 行业 / 风险 /
                资金 / 政策 / 题材 / 解禁）将并行分析并辩论仲裁，输出带评分、情景推演与
                量化策略的完整研究报告。全程约 1-3 分钟。
              </p>
              <div className="research-empty-steps">
                <div className="research-empty-step">
                  <span className="step-num">1</span>输入代码或点快捷标签
                </div>
                <div className="research-empty-step">
                  <span className="step-num">2</span>点击「开始分析」
                </div>
                <div className="research-empty-step">
                  <span className="step-num">3</span>阅读完整研究报告
                </div>
              </div>
              <p className="research-empty-hint">
                结果会自动存入「历史」，可随时回看与对比；也可以切到「研究助手」用自然语言提问。
              </p>
            </div>
          </div>
        )}
        {error && !loading && (
          <div className="error-banner" role="alert">
            <div className="error-banner-body">
              <span className="error-banner-icon" aria-hidden="true">
                !
              </span>
              <span className="error-banner-text">{error}</span>
            </div>
            {lastCodeRef.current && (
              <button className="error-banner-retry" onClick={handleRetry}>
                重试 {lastCodeRef.current}
              </button>
            )}
          </div>
        )}
        {stockData && !loading && (
          <div className="report-layout" key={stockData.stock_code}>
            {/* 左侧导航锚点 */}
            <nav className="side-nav">
              <a href="#summary" className={activeSection === 'summary' ? 'active' : ''}>
                核心摘要
              </a>
              <a href="#financial" className={activeSection === 'financial' ? 'active' : ''}>
                财务分析
              </a>
              <a href="#charts" className={activeSection === 'charts' ? 'active' : ''}>
                数据图表
              </a>
              <a href="#valuation" className={activeSection === 'valuation' ? 'active' : ''}>
                估值分析
              </a>
              <a href="#experts" className={activeSection === 'experts' ? 'active' : ''}>
                专家观点
              </a>
              <a href="#capital" className={activeSection === 'capital' ? 'active' : ''}>
                资金筹码
              </a>
              <a href="#scenario" className={activeSection === 'scenario' ? 'active' : ''}>
                情景推演
              </a>
              <a href="#strategy" className={activeSection === 'strategy' ? 'active' : ''}>
                量化策略
              </a>
              <a href="#scoring" className={activeSection === 'scoring' ? 'active' : ''}>
                综合评分
              </a>
              <a href="#controversy" className={activeSection === 'controversy' ? 'active' : ''}>
                争议焦点
              </a>
              <a href="#risk" className={activeSection === 'risk' ? 'active' : ''}>
                风险清单
              </a>
              <a href="#reflection" className={activeSection === 'reflection' ? 'active' : ''}>
                自省校验
              </a>
              <a href="#limitation" className={activeSection === 'limitation' ? 'active' : ''}>
                研究局限性
              </a>
              <a href="#followup" className={activeSection === 'followup' ? 'active' : ''}>
                跟踪指标
              </a>
            </nav>

            {/* 移动端导航 */}
            <MobileNav activeSection={activeSection} />

            {/* 右侧主内容 */}
            <main className="report-main">
              <div className="disclaimer">
                【风险提示】本内容依托公开市场数据进行学术投研模拟分析，所有推演假设标注【推演，存在不确定性】，不构成任何投资建议。
              </div>

              {viewingHistory && (
                <div className="history-snapshot-banner" role="status">
                  正在查看<b>历史快照</b>（非实时分析）——发起新的分析即可刷新
                </div>
              )}

              <RevealSection>
                <ReportHeader
                  data={stockData}
                  research_confidence={analysisResult?.research_confidence}
                  onExport={analysisResult ? handleExport : undefined}
                  generatedAt={analysisResult?.generatedAt}
                  dataAsOf={analysisResult?.dataAsOf}
                />
              </RevealSection>

              {/* Dashboard 关键指标 */}
              <RevealSection>
                <DashboardCards data={stockData} />
              </RevealSection>

              {/* 最新消息情绪（若有） */}
              {stockData.newsSentiment?.hasNews && (
                <RevealSection>
                  <NewsSentimentCard data={stockData.newsSentiment} />
                </RevealSection>
              )}

              {/* 机构一致预期（若有；快照口径） */}
              {stockData.consensus && (
                <RevealSection>
                  {/* 缓存回放/历史快照可能缺 ratings/forecasts 字段，兜 ErrorBoundary 防整页白屏 */}
                  <ErrorBoundary label="机构一致预期">
                    <ConsensusCard data={stockData.consensus} />
                  </ErrorBoundary>
                </RevealSection>
              )}

              {/* 数据来源与覆盖范围（溯源表：来源 → 报告里哪些数字出自它） */}
              {analysisResult?.data_sources && analysisResult.data_sources.length > 0 && (
                <RevealSection>
                  <div className="card data-source-table">
                    <h4 className="quant-panel-title">数据来源与覆盖范围</h4>
                    <table>
                      <thead>
                        <tr>
                          <th>来源</th>
                          <th>说明</th>
                          <th>覆盖的报告模块</th>
                          <th>置信度</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysisResult.data_sources.map((src, i) => (
                          <tr key={i}>
                            <td className="ds-name">{src.name}</td>
                            <td className="ds-desc">{src.description}</td>
                            <td className="ds-coverage">{src.coverage ?? '—'}</td>
                            <td>
                              <span className="chip-confidence">{src.confidence}%</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="batch-hint">
                      各模块数字可在对应卡片中回看；公告与新闻类来源为原文口径，研判结论不构成投资建议。
                    </p>
                  </div>
                </RevealSection>
              )}

              <RevealSection id="summary">
                <ErrorBoundary label="核心摘要">
                  <CoreSummary data={stockData} />
                </ErrorBoundary>
              </RevealSection>
              <RevealSection id="financial">
                <ErrorBoundary label="财务分析">
                  <FinancialSection data={stockData.finance_metrics} />
                </ErrorBoundary>
              </RevealSection>
              <RevealSection id="charts">
                <ErrorBoundary label="数据图表">
                  
                  <Suspense fallback={<div className="charts-suspense">图表加载中…</div>}>
                    <ChartsSection data={stockData} />
                  </Suspense>
                </ErrorBoundary>
              </RevealSection>
              <RevealSection id="valuation">
                <ErrorBoundary label="估值分析">
                  
                  <ValuationSection
                    data={stockData.valuation}
                    valuation_level={stockData.valuation_level}
                    stockName={stockData.stock_name}
                  />
                </ErrorBoundary>
              </RevealSection>
              <RevealSection id="experts">
                <ErrorBoundary label="专家观点">
                  <ExpertOpinions data={stockData.expert_opinions} />
                </ErrorBoundary>
              </RevealSection>
              {/* 资金筹码分析 */}
              {(() => {
                // 同一次 find 复用（条件渲染与传参各调一次，抽出来只扫一遍）
                const capitalFlow = stockData.expert_opinions.find(
                  (e) => e.expert === '资金筹码分析师',
                );
                if (!capitalFlow) return null;
                return (
                  <RevealSection id="capital">
                    <ErrorBoundary label="资金筹码">
                      <CapitalFlowSection data={capitalFlow} />
                    </ErrorBoundary>
                  </RevealSection>
                );
              })()}
              {/* 情景推演 */}
              {stockData.scenarios && stockData.scenarios.length > 0 && (
                <RevealSection id="scenario">
                  <ErrorBoundary label="情景推演">
                    <ScenarioSection data={stockData.scenarios} />
                  </ErrorBoundary>
                </RevealSection>
              )}
              {/* 量化策略清单 */}
              {stockData.strategyList && stockData.strategyList.length > 0 && (
                <RevealSection id="strategy">
                  <ErrorBoundary label="量化策略">
                    <StrategyListSection data={stockData.strategyList} />
                  </ErrorBoundary>
                </RevealSection>
              )}
              <RevealSection id="scoring">
                <ErrorBoundary label="综合评分">
                  <ScoringTable data={stockData} />
                </ErrorBoundary>
              </RevealSection>
              <RevealSection id="controversy">
                <ErrorBoundary label="争议焦点">
                  <ControversySection data={stockData.controversy_points} />
                </ErrorBoundary>
              </RevealSection>
              <RevealSection id="risk">
                <ErrorBoundary label="风险清单">
                  
                  <RiskSection data={stockData.risk_list} attribution={stockData.riskAttribution} />
                </ErrorBoundary>
              </RevealSection>
              <RevealSection id="reflection">
                <ErrorBoundary label="自省校验">
                  <ReflectionSection data={stockData.reflection_notes} />
                </ErrorBoundary>
              </RevealSection>
              {/* 研究局限性 */}
              {analysisResult?.limitation_explain && (
                <RevealSection id="limitation">
                  <ErrorBoundary label="研究局限性">
                    <section className="report-section">
                      <h2 className="limitation-title">研究局限性</h2>
                      <div className="limitation-card">
                        <p>{analysisResult.limitation_explain}</p>
                      </div>
                    </section>
                  </ErrorBoundary>
                </RevealSection>
              )}
              <RevealSection id="followup">
                <ErrorBoundary label="跟踪指标">
                  
                  <FollowUpSection
                    // key 不可省：组件用 useState 初始化器读取当前股票的本地状态，
                    // 若实例被复用（换股票但未卸载），上一只的星标会被写进新股票的存储键。
                    key={stockData.stock_code}
                    data={stockData.follow_up_indicators}
                    stockCode={stockData.stock_code}
                  />
                </ErrorBoundary>
              </RevealSection>
            </main>
          </div>
        )}
      </div>
      {/* 懒加载面板：首次激活才挂载，之后常驻 + hidden（未激活过的不渲染，首屏不并发取数）。
          每个面板一个独立 Suspense 边界，见上方 TabPane 注释 */}
      {shouldRenderTab('quant') && (
        <TabPane active={activeTab === 'quant'}>
          <QuantPage />
        </TabPane>
      )}
      {shouldRenderTab('compare') && (
        <TabPane active={activeTab === 'compare'}>
          <ComparisonView />
        </TabPane>
      )}
      {shouldRenderTab('watchlist') && (
        <TabPane active={activeTab === 'watchlist'}>
          <WatchlistPage />
        </TabPane>
      )}
      {shouldRenderTab('paper') && (
        <TabPane active={activeTab === 'paper'}>
          <PaperTradingPage />
        </TabPane>
      )}
      {shouldRenderTab('chat') && (
        <TabPane active={activeTab === 'chat'}>
          <ChatPanel />
        </TabPane>
      )}
      {shouldRenderTab('history') && (
        <TabPane active={activeTab === 'history'}>
          <HistoryPage
            onOpenHistory={(result) => {
              // 回看历史：恢复完整分析结果并切回深度研究页渲染
              setAnalysisResult(result);
              setError(null);
              setViewingHistory(true);
              setActiveTab('research');
            }}
          />
        </TabPane>
      )}

      {showBackTop && (
        <button
          className="back-top"
          aria-label="回到顶部"
          title="回到顶部"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          ↑
        </button>
      )}
    </div>
  );
}

export default App;

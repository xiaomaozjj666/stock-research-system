import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { analyzeStockStream, type AnalysisStage } from './api/client';
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
import ScoringTable from './components/ScoringTable';
import ControversySection from './components/ControversySection';
import RiskSection from './components/RiskSection';
import ReflectionSection from './components/ReflectionSection';
import FollowUpSection from './components/FollowUpSection';
import MobileNav from './components/MobileNav';
import ChatPanel from './components/ChatPanel';
import { useToast } from './components/Toast';
import { generateReportMarkdown, downloadMarkdown } from './utils/reportExport';
import { useScrollReveal } from './hooks/useScrollReveal';
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

/* ===== RevealSection wrapper ===== */
function RevealSection({
  children,
  id,
  className = '',
  delay = 0,
}: {
  children: React.ReactNode;
  id?: string;
  className?: string;
  delay?: number;
}) {
  const { ref, isVisible } = useScrollReveal();
  return (
    <div
      ref={ref}
      id={id}
      className={`reveal-section ${isVisible ? 'revealed' : ''} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
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
  const [scrollProgress, setScrollProgress] = useState(0);
  /** 最近一次分析的代码，用于失败后一键重试 */
  const lastCodeRef = useRef<string>('');
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
      : '投研系统 - AI 多专家股票研究';
  }, [analysisResult]);
  /** 在途 SSE 的取消函数 */
  const cancelRef = useRef<(() => void) | null>(null);

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
        // 滚动进度
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        if (docHeight > 0) {
          setScrollProgress((window.scrollY / docHeight) * 100);
        }
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
  }, [analysisResult]);

  const handleAnalyze = useCallback(async (stockCode: string) => {
    // 有在途分析先取消，避免两条 SSE 竞争写同一份状态
    cancelRef.current?.();
    lastCodeRef.current = stockCode;
    setLoading(true);
    setError(null);
    setAnalysisStage(null);
    setViewingHistory(false); // 新分析开始：退出历史快照模式
    try {
      const { done, cancel } = analyzeStockStream(stockCode, (stage) => {
        setAnalysisStage(stage);
      });
      cancelRef.current = cancel;
      const result = await done;
      setAnalysisResult(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '分析请求失败';
      setError(message);
    } finally {
      cancelRef.current = null;
      setLoading(false);
      setAnalysisStage(null);
    }
  }, []);

  const handleRetry = useCallback(() => {
    if (lastCodeRef.current) handleAnalyze(lastCodeRef.current);
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

  const stockData = analysisResult?.stock_pool?.[0];

  return (
    <div className="app">
      {/* 滚动进度条 */}
      {stockData && !loading && (
        <div className="scroll-progress" style={{ width: `${scrollProgress}%` }} />
      )}

      <StockSelector onAnalyze={handleAnalyze} loading={loading} />

      <div className="tab-bar">
        <button
          className={`tab ${activeTab === 'research' ? 'active' : ''}`}
          onClick={() => setActiveTab('research')}
        >
          深度研究
        </button>
        <button
          className={`tab ${activeTab === 'quant' ? 'active' : ''}`}
          onClick={() => setActiveTab('quant')}
        >
          量化研究
        </button>
        <button
          className={`tab ${activeTab === 'compare' ? 'active' : ''}`}
          onClick={() => setActiveTab('compare')}
        >
          对比分析
        </button>
        <button
          className={`tab ${activeTab === 'watchlist' ? 'active' : ''}`}
          onClick={() => setActiveTab('watchlist')}
        >
          自选股
        </button>
        <button
          className={`tab ${activeTab === 'paper' ? 'active' : ''}`}
          onClick={() => setActiveTab('paper')}
        >
          模拟盘
        </button>
        <button
          className={`tab ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          研究助手
        </button>
        <button
          className={`tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          历史
        </button>
      </div>

      {activeTab === 'research' && (
        <>
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
            <div className="report-layout">
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

                {/* 数据来源标签 */}
                {analysisResult?.data_sources && analysisResult.data_sources.length > 0 && (
                  <RevealSection>
                    <div className="data-source-tags">
                      {analysisResult.data_sources.map((src, i) => (
                        <span key={i} className="chip chip-neutral">
                          {src.name}
                          <span className="chip-confidence">{src.confidence}%</span>
                        </span>
                      ))}
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
                {stockData.expert_opinions.find((e) => e.expert === '资金筹码分析师') && (
                  <RevealSection id="capital">
                    <ErrorBoundary label="资金筹码">
                      
                      <CapitalFlowSection
                        data={stockData.expert_opinions.find((e) => e.expert === '资金筹码分析师')}
                      />
                    </ErrorBoundary>
                  </RevealSection>
                )}
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
                    <RiskSection data={stockData.risk_list} />
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
                      data={stockData.follow_up_indicators}
                      stockCode={stockData.stock_code}
                    />
                  </ErrorBoundary>
                </RevealSection>
              </main>
            </div>
          )}
        </>
      )}
      {/* 懒加载页切换用轻量占位（全屏 LoadingScreen 只保留给深度研究分析中） */}
      <Suspense fallback={<div className="page-suspense">页面加载中…</div>}>
        {activeTab === 'quant' && <QuantPage />}
        {activeTab === 'compare' && <ComparisonView />}
        {activeTab === 'watchlist' && <WatchlistPage />}
        {activeTab === 'paper' && <PaperTradingPage />}
        {activeTab === 'chat' && <ChatPanel />}
        {activeTab === 'history' && (
          <HistoryPage
            onOpenHistory={(result) => {
              // 回看历史：恢复完整分析结果并切回深度研究页渲染
              setAnalysisResult(result);
              setError(null);
              setViewingHistory(true);
              setActiveTab('research');
            }}
          />
        )}
      </Suspense>

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

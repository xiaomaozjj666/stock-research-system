import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { analyzeStockStream, type AnalysisStage } from './api/client';
import type { AnalysisResult } from './types';
import StockSelector from './components/StockSelector';
import LoadingScreen from './components/LoadingScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import WatchlistPage from './pages/watchlist/WatchlistPage';
import ReportHeader from './components/ReportHeader';
import CoreSummary from './components/CoreSummary';
import FinancialSection from './components/FinancialSection';
import ChartsSection from './components/ChartsSection';
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
import { useScrollReveal } from './hooks/useScrollReveal';
import { useCountUp } from './hooks/useCountUp';

// 路由级懒加载：减小首屏体积，量化/对比/模拟盘页按需加载
const QuantPage = lazy(() => import('./pages/quant/QuantPage'));
const ComparisonView = lazy(() => import('./components/ComparisonView'));
const PaperTradingPage = lazy(() => import('./pages/paper/PaperTradingPage'));

/* ===== RevealSection wrapper ===== */
function RevealSection({ children, id, className = '', delay = 0 }: {
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
        <div className="dash-value accent">{totalScore}<span className="dash-unit">/100</span></div>
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
        <div className="dash-value">{pe || '—'} / {pb || '—'}</div>
      </div>
      <div className="dash-card">
        <div className="dash-label">市值</div>
        <div className="dash-value">{(data.valuation?.marketCap ?? 0) >= 10000 ? ((data.valuation?.marketCap ?? 0) / 10000).toFixed(1) + ' 万亿' : ((data.valuation?.marketCap ?? 0).toFixed(0)) + ' 亿'}</div>
      </div>
    </div>
  );
}

function App() {
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [analysisStage, setAnalysisStage] = useState<AnalysisStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState('');
  const [activeTab, setActiveTab] = useState<'research' | 'quant' | 'compare' | 'watchlist' | 'paper' | 'chat'>('research');
  const [scrollProgress, setScrollProgress] = useState(0);
  /** 最近一次分析的代码，用于失败后一键重试 */
  const lastCodeRef = useRef<string>('');
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

        const sections = ['summary', 'financial', 'charts', 'valuation', 'experts', 'capital', 'scenario', 'strategy', 'scoring', 'controversy', 'risk', 'reflection', 'limitation', 'followup'];
        for (const id of sections) {
          const el = document.getElementById(id);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.top <= 150 && rect.bottom > 150) {
              if (id !== lastSection) {
                lastSection = id;
                setActiveSection(id);
              }
              break;
            }
          }
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
      </div>

      {activeTab === 'research' && (<>
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
            <span className="error-banner-icon" aria-hidden="true">!</span>
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
            <a href="#summary" className={activeSection === 'summary' ? 'active' : ''}>核心摘要</a>
            <a href="#financial" className={activeSection === 'financial' ? 'active' : ''}>财务分析</a>
            <a href="#charts" className={activeSection === 'charts' ? 'active' : ''}>数据图表</a>
            <a href="#valuation" className={activeSection === 'valuation' ? 'active' : ''}>估值分析</a>
            <a href="#experts" className={activeSection === 'experts' ? 'active' : ''}>专家观点</a>
            <a href="#capital" className={activeSection === 'capital' ? 'active' : ''}>资金筹码</a>
            <a href="#scenario" className={activeSection === 'scenario' ? 'active' : ''}>情景推演</a>
            <a href="#strategy" className={activeSection === 'strategy' ? 'active' : ''}>量化策略</a>
            <a href="#scoring" className={activeSection === 'scoring' ? 'active' : ''}>综合评分</a>
            <a href="#controversy" className={activeSection === 'controversy' ? 'active' : ''}>争议焦点</a>
            <a href="#risk" className={activeSection === 'risk' ? 'active' : ''}>风险清单</a>
            <a href="#reflection" className={activeSection === 'reflection' ? 'active' : ''}>自省校验</a>
            <a href="#limitation" className={activeSection === 'limitation' ? 'active' : ''}>研究局限性</a>
            <a href="#followup" className={activeSection === 'followup' ? 'active' : ''}>跟踪指标</a>
          </nav>

          {/* 移动端导航 */}
          <MobileNav activeSection={activeSection} />

          {/* 右侧主内容 */}
          <main className="report-main">
            <div className="disclaimer">
              【风险提示】本内容依托公开市场数据进行学术投研模拟分析，所有推演假设标注【推演，存在不确定性】，不构成任何投资建议。
            </div>

            <RevealSection>
              <ReportHeader
                data={stockData}
                research_confidence={analysisResult?.research_confidence}
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

            <RevealSection id="summary"><ErrorBoundary label="核心摘要"><CoreSummary data={stockData} /></ErrorBoundary></RevealSection>
            <RevealSection id="financial"><ErrorBoundary label="财务分析"><FinancialSection data={stockData.finance_metrics} /></ErrorBoundary></RevealSection>
            <RevealSection id="charts"><ErrorBoundary label="数据图表"><ChartsSection data={stockData} /></ErrorBoundary></RevealSection>
            <RevealSection id="valuation">
              <ErrorBoundary label="估值分析"><ValuationSection
                data={stockData.valuation}
                valuation_level={stockData.valuation_level}
                stockName={stockData.stock_name}
              /></ErrorBoundary>
            </RevealSection>
            <RevealSection id="experts"><ErrorBoundary label="专家观点"><ExpertOpinions data={stockData.expert_opinions} /></ErrorBoundary></RevealSection>
            {/* 资金筹码分析 */}
            {stockData.expert_opinions.find(e => e.expert === '资金筹码分析师') && (
              <RevealSection id="capital">
                <ErrorBoundary label="资金筹码"><CapitalFlowSection data={stockData.expert_opinions.find(e => e.expert === '资金筹码分析师')} /></ErrorBoundary>
              </RevealSection>
            )}
            {/* 情景推演 */}
            {stockData.scenarios && stockData.scenarios.length > 0 && (
              <RevealSection id="scenario"><ErrorBoundary label="情景推演"><ScenarioSection data={stockData.scenarios} /></ErrorBoundary></RevealSection>
            )}
            {/* 量化策略清单 */}
            {stockData.strategyList && stockData.strategyList.length > 0 && (
              <RevealSection id="strategy"><ErrorBoundary label="量化策略"><StrategyListSection data={stockData.strategyList} /></ErrorBoundary></RevealSection>
            )}
            <RevealSection id="scoring"><ErrorBoundary label="综合评分"><ScoringTable data={stockData} /></ErrorBoundary></RevealSection>
            <RevealSection id="controversy"><ErrorBoundary label="争议焦点"><ControversySection data={stockData.controversy_points} /></ErrorBoundary></RevealSection>
            <RevealSection id="risk"><ErrorBoundary label="风险清单"><RiskSection data={stockData.risk_list} /></ErrorBoundary></RevealSection>
            <RevealSection id="reflection"><ErrorBoundary label="自省校验"><ReflectionSection data={stockData.reflection_notes} /></ErrorBoundary></RevealSection>
            {/* 研究局限性 */}
            {analysisResult?.limitation_explain && (
              <RevealSection id="limitation">
                <ErrorBoundary label="研究局限性"><section className="report-section">
                  <h2 className="limitation-title">研究局限性</h2>
                  <div className="limitation-card">
                    <p>{analysisResult.limitation_explain}</p>
                  </div>
                </section></ErrorBoundary>
              </RevealSection>
            )}
            <RevealSection id="followup"><ErrorBoundary label="跟踪指标"><FollowUpSection data={stockData.follow_up_indicators} /></ErrorBoundary></RevealSection>
          </main>
        </div>
      )}
      </>)}
      <Suspense fallback={<LoadingScreen />}>
        {activeTab === 'quant' && <QuantPage />}
        {activeTab === 'compare' && <ComparisonView />}
        {activeTab === 'watchlist' && <WatchlistPage />}
        {activeTab === 'paper' && <PaperTradingPage />}
        {activeTab === 'chat' && <ChatPanel />}
      </Suspense>
    </div>
  );
}

export default App;

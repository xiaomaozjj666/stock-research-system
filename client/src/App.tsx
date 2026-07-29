import { useState, useEffect } from 'react';
import { analyzeStock } from './api/client';
import QuantPage from './pages/quant/QuantPage';
import StockSelector from './components/StockSelector';
import LoadingScreen from './components/LoadingScreen';
import ReportHeader from './components/ReportHeader';
import CoreSummary from './components/CoreSummary';
import FinancialSection from './components/FinancialSection';
import ChartsSection from './components/ChartsSection';
import ValuationSection from './components/ValuationSection';
import ExpertOpinions from './components/ExpertOpinions';
import ScoringTable from './components/ScoringTable';
import ControversySection from './components/ControversySection';
import RiskSection from './components/RiskSection';
import ReflectionSection from './components/ReflectionSection';
import FollowUpSection from './components/FollowUpSection';

interface AnalysisResult {
  stock_pool: {
    stock_code: string;
    stock_name: string;
    industry: string;
    core_summary: string;
    total_score: number;
    rating: string;
    score_detail: {
      profit_quality: number;
      growth: number;
      valuation: number;
      industry_boom: number;
      risk_deduction: number;
    };
    strengths: string[];
    risk_list: string[];
    controversy_points: {
      topic: string;
      bullishView: string;
      bearishView: string;
      arbitration: string;
      confidence: number;
    }[];
    finance_metrics: {
      years: string[];
      revenue: number[];
      netProfit: number[];
      grossMargin: number[];
      netMargin: number[];
      roe: number[];
      operatingCashFlow: number[];
      eps: number[];
    };
    valuation: {
      currentPrice: number;
      pe: number;
      pb: number;
      ps: number;
      marketCap: number;
      historicalPE: { year: string; pe: number }[];
      peerComparison: {
        name: string;
        code: string;
        pe: number;
        pb: number;
        roe: number;
        marketCap: number;
      }[];
    };
    valuation_level: string;
    expert_opinions: {
      expert: string;
      arguments: { text: string; confidence: number; type: 'support' | 'oppose' }[];
      overallSentiment: 'bullish' | 'neutral' | 'bearish';
      confidence: number;
      keyPoints: string[];
    }[];
    reflection_notes: string[];
    follow_up_indicators: string[];
  }[];
  research_confidence: string;
  limitation_explain: string;
  data_sources?: {
    name: string;
    description: string;
    confidence: number;
  }[];
}

function App() {
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState('');
  const [activeTab, setActiveTab] = useState<'research' | 'quant'>('research');

  // 滚动监听，更新导航高亮
  useEffect(() => {
    const handleScroll = () => {
      const sections = ['summary', 'financial', 'charts', 'valuation', 'experts', 'scoring', 'controversy', 'risk', 'reflection', 'followup'];
      for (const id of sections) {
        const el = document.getElementById(id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= 150 && rect.bottom > 150) {
            setActiveSection(id);
            break;
          }
        }
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [analysisResult]);

  const handleAnalyze = async (stockCode: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await analyzeStock(stockCode);
      setAnalysisResult(result);
    } catch {
      setError('分析失败，请检查后端服务是否启动');
    } finally {
      setLoading(false);
    }
  };

  const stockData = analysisResult?.stock_pool?.[0];

  return (
    <div className="app">
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
      </div>

      {activeTab === 'research' && (<>
      {loading && <LoadingScreen />}
      {error && <div className="error-banner">{error}</div>}
      {stockData && !loading && (
        <div className="report-layout">
          {/* 左侧导航锚点 */}
          <nav className="side-nav">
            <a href="#summary" className={activeSection === 'summary' ? 'active' : ''}>核心摘要</a>
            <a href="#financial" className={activeSection === 'financial' ? 'active' : ''}>财务分析</a>
            <a href="#charts" className={activeSection === 'charts' ? 'active' : ''}>数据图表</a>
            <a href="#valuation" className={activeSection === 'valuation' ? 'active' : ''}>估值分析</a>
            <a href="#experts" className={activeSection === 'experts' ? 'active' : ''}>专家观点</a>
            <a href="#scoring" className={activeSection === 'scoring' ? 'active' : ''}>综合评分</a>
            <a href="#controversy" className={activeSection === 'controversy' ? 'active' : ''}>争议焦点</a>
            <a href="#risk" className={activeSection === 'risk' ? 'active' : ''}>风险清单</a>
            <a href="#reflection" className={activeSection === 'reflection' ? 'active' : ''}>自省校验</a>
            <a href="#followup" className={activeSection === 'followup' ? 'active' : ''}>跟踪指标</a>
          </nav>

          {/* 右侧主内容 */}
          <main className="report-main">
            <div className="disclaimer">
              【风险提示】本内容依托公开市场数据进行学术投研模拟分析，所有推演假设标注【推演，存在不确定性】，不构成任何投资建议。
            </div>

            <ReportHeader
              data={stockData}
              research_confidence={analysisResult?.research_confidence}
            />

            {/* Dashboard 关键指标 */}
            <div className="dashboard-cards">
              <div className="dash-card">
                <div className="dash-label">综合评分</div>
                <div className="dash-value accent">{stockData.total_score}<span className="dash-unit">/100</span></div>
              </div>
              <div className="dash-card">
                <div className="dash-label">投资评级</div>
                <div className="dash-value">{stockData.rating}</div>
              </div>
              <div className="dash-card">
                <div className="dash-label">当前价格</div>
                <div className="dash-value">¥{stockData.valuation.currentPrice}</div>
              </div>
              <div className="dash-card">
                <div className="dash-label">PE / PB</div>
                <div className="dash-value">{stockData.valuation.pe} / {stockData.valuation.pb}</div>
              </div>
              <div className="dash-card">
                <div className="dash-label">市值</div>
                <div className="dash-value">{(stockData.valuation.marketCap / 1e8).toFixed(1)}<span className="dash-unit">亿</span></div>
              </div>
            </div>

            {/* 数据来源标签 */}
            {analysisResult?.data_sources && analysisResult.data_sources.length > 0 && (
              <div className="data-source-tags">
                {analysisResult.data_sources.map((src, i) => (
                  <span key={i} className="chip chip-neutral">
                    {src.name}
                    <span style={{ opacity: 0.7, marginLeft: 4 }}>{src.confidence}%</span>
                  </span>
                ))}
              </div>
            )}

            <section id="summary"><CoreSummary data={stockData} /></section>
            <section id="financial"><FinancialSection data={stockData.finance_metrics} /></section>
            <section id="charts"><ChartsSection data={stockData} /></section>
            <section id="valuation">
              <ValuationSection
                data={stockData.valuation}
                valuation_level={stockData.valuation_level}
                stockName={stockData.stock_name}
              />
            </section>
            <section id="experts"><ExpertOpinions data={stockData.expert_opinions} /></section>
            <section id="scoring"><ScoringTable data={stockData} /></section>
            <section id="controversy"><ControversySection data={stockData.controversy_points} /></section>
            <section id="risk"><RiskSection data={stockData.risk_list} /></section>
            <section id="reflection"><ReflectionSection data={stockData.reflection_notes} /></section>
            <section id="followup"><FollowUpSection data={stockData.follow_up_indicators} /></section>
          </main>
        </div>
      )}
      </>)}
      {activeTab === 'quant' && <QuantPage />}
    </div>
  );
}

export default App;

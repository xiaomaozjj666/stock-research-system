import { memo } from 'react';
interface StrategyRecommendation {
  strategyType: string;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalReturn: number;
  applicableMarket: string;
  fatalWeakness: string;
  backtestWarning: string;
  newsAware?: {
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    posture: number;
  };
}

interface Props {
  data: StrategyRecommendation[];
}

function StrategyListSection({ data }: Props) {
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <div className="section-title">量化策略清单</div>
        <div className="strategy-empty">暂无策略数据</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="section-title">量化策略清单</div>

      <div className="strategy-list">
        {data.map((strategy, i) => (
          <div key={i} className="strategy-card">
            <div className="strategy-name">{strategy.strategyType}</div>

            <div className="strategy-metrics">
              <div className="strategy-metric">
                <div className="strategy-metric-label">夏普比率</div>
                <div className="strategy-metric-value">
                  {(strategy.sharpeRatio ?? 0).toFixed(2)}
                </div>
              </div>
              <div className="strategy-metric">
                <div className="strategy-metric-label">最大回撤</div>
                <div className="strategy-metric-value val-negative">
                  {(strategy.maxDrawdown ?? 0).toFixed(1)}%
                </div>
              </div>
              <div className="strategy-metric">
                <div className="strategy-metric-label">胜率</div>
                <div className="strategy-metric-value">{(strategy.winRate ?? 0).toFixed(1)}%</div>
              </div>
              <div className="strategy-metric">
                <div className="strategy-metric-label">总收益</div>
                <div
                  className={`strategy-metric-value ${strategy.totalReturn >= 0 ? 'val-positive' : 'val-negative'}`}
                >
                  {strategy.totalReturn >= 0 ? '+' : ''}
                  {(strategy.totalReturn ?? 0).toFixed(1)}%
                </div>
              </div>
            </div>

            <div className="strategy-tags">
              {strategy.applicableMarket && (
                <span className="strategy-tag applicable">{strategy.applicableMarket}</span>
              )}
              {strategy.fatalWeakness && (
                <span className="strategy-tag weakness">{strategy.fatalWeakness}</span>
              )}
            </div>

            {strategy.backtestWarning && (
              <div className="strategy-warning">{strategy.backtestWarning}</div>
            )}

            {strategy.newsAware && (
              <div className="strategy-news-aware">
                含最新消息（姿态 {(strategy.newsAware.posture * 100).toFixed(0)}%）： 收益{' '}
                {strategy.newsAware.totalReturn >= 0 ? '+' : ''}
                {strategy.newsAware.totalReturn.toFixed(1)}% · 夏普{' '}
                {strategy.newsAware.sharpeRatio.toFixed(2)} · 回撤{' '}
                {strategy.newsAware.maxDrawdown.toFixed(1)}%
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// App 的滚动/悬停等本地状态变化频率高，memo 避免纯数据展示区块随之全量重渲染
export default memo(StrategyListSection);

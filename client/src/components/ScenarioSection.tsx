import { memo } from 'react';
interface ScenarioResult {
  name: '乐观' | '中性' | '悲观';
  probability: number;
  keyAssumptions: string[];
  targetPriceRange: { low: number; high: number };
  supportingArguments: { expert: string; text: string; confidence: number }[];
  preconditions: string[];
}

interface Props {
  data: ScenarioResult[];
}

function getScenarioClass(name: string): string {
  if (name === '乐观') return 'optimistic';
  if (name === '悲观') return 'pessimistic';
  return 'neutral';
}

function ScenarioSection({ data }: Props) {
  if (!data || data.length === 0) return null;

  return (
    <div className="card">
      <div className="section-title">情景推演</div>
      <div className="scenario-subtitle">基于专家情绪分布的概率加权分析</div>

      <div className="scenario-grid scenario-cards">
        {data.map((scenario, i) => (
          <div key={i} className={`scenario-card ${getScenarioClass(scenario.name)}`}>
            <div className={`scenario-name scenario-color-${getScenarioClass(scenario.name)}`}>
              {scenario.name}
            </div>
            <div className={`scenario-prob scenario-color-${getScenarioClass(scenario.name)}`}>
              {(scenario.probability * 100).toFixed(0)}%
            </div>
            <div className="scenario-price-range">
              目标价区间：¥{scenario.targetPriceRange?.low?.toFixed(0) || '—'} - ¥
              {scenario.targetPriceRange?.high?.toFixed(0) || '—'}
            </div>

            {scenario.keyAssumptions.length > 0 && (
              <div className="scenario-assumptions">
                <div className="scenario-section-label">关键假设</div>
                <ul>
                  {scenario.keyAssumptions.map((a, j) => (
                    <li key={j}>{a}</li>
                  ))}
                </ul>
              </div>
            )}

            {scenario.preconditions.length > 0 && (
              <div className="scenario-assumptions scenario-preconditions">
                <div className="scenario-section-label">前置条件</div>
                <ul>
                  {scenario.preconditions.map((p, j) => (
                    <li key={j}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            {scenario.supportingArguments && scenario.supportingArguments.length > 0 && (
              <div className="scenario-arguments">
                <div className="scenario-section-label">专家论据</div>
                {scenario.supportingArguments.slice(0, 3).map((arg, j) => (
                  <div key={j} className="scenario-arg-item">
                    <span className="scenario-arg-expert">{arg.expert}</span>
                    <span className="scenario-arg-text">{arg.text}</span>
                    <span className="scenario-arg-confidence">({arg.confidence}%)</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="scenario-disclaimer">概率为主观估计，仅供参考</div>
    </div>
  );
}

// App 的滚动/悬停等本地状态变化频率高，memo 避免纯数据展示区块随之全量重渲染
export default memo(ScenarioSection);

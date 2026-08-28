import { memo } from 'react';
import type { StockPoolItem } from '../types';

interface RiskSectionProps {
  data: string[];
  /** 风险归因（可选）：风格因子暴露 + 系统/特异风险分解 */
  attribution?: StockPoolItem['riskAttribution'];
}

/** 风格因子中文名与解释 */
const FACTOR_LABELS: Array<{
  key: keyof NonNullable<StockPoolItem['riskAttribution']>['exposures'];
  label: string;
  hint: string;
}> = [
  { key: 'size', label: '规模', hint: '市值越大暴露越高' },
  { key: 'value', label: '价值', hint: 'PE 越低价值暴露越高' },
  { key: 'momentum', label: '动量', hint: '近期涨幅越高暴露越高' },
  { key: 'profitability', label: '盈利', hint: 'ROE 越高暴露越高' },
  { key: 'leverage', label: '杠杆', hint: '负债率越高暴露越高' },
];

function RiskSection({ data = [], attribution }: RiskSectionProps) {
  const hasAttribution = !!attribution?.exposures && !!attribution?.decomposition;
  if (data.length === 0 && !hasAttribution) return null;

  return (
    <div className="card">
      <div className="section-title">风险清单</div>
      {data.length > 0 && (
        <div className="risk-list">
          {data.map((risk, i) => (
            <div className="risk-item" key={i}>
              <span>{risk}</span>
            </div>
          ))}
        </div>
      )}

      {hasAttribution && (
        <div className="risk-attribution">
          <div className="risk-attribution-title">风险归因（风格因子暴露）</div>
          <div className="risk-factor-list">
            {FACTOR_LABELS.map((f) => {
              const v = attribution!.exposures[f.key];
              const pct = Math.max(-100, Math.min(100, Math.round(v * 50))); // 映射到 ±100 条长
              return (
                <div className="risk-factor" key={f.key}>
                  <span className="risk-factor-label" title={f.hint}>
                    {f.label}
                  </span>
                  <span className="risk-factor-bar">
                    <span
                      className={`risk-factor-fill ${v >= 0 ? 'positive' : 'negative'}`}
                      style={{
                        width: `${Math.abs(pct)}%`,
                        marginLeft: v >= 0 ? '50%' : `${50 - Math.abs(pct)}%`,
                      }}
                    />
                  </span>
                  <span className="risk-factor-value">
                    {v >= 0 ? '+' : ''}
                    {v.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="risk-decomposition">
            系统风险 {attribution!.decomposition.systematicVol}% · 特异风险{' '}
            {attribution!.decomposition.specificVol}% · 总波动 {attribution!.decomposition.totalVol}
            %（因子解释占比 {(attribution!.decomposition.explainedRatio * 100).toFixed(0)}%）
          </div>
        </div>
      )}
    </div>
  );
}

// App 的滚动/悬停等本地状态变化频率高，memo 避免纯数据展示区块随之全量重渲染
export default memo(RiskSection);

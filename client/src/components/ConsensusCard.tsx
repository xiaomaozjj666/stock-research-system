import { memo } from 'react';
import type { ConsensusSnapshot } from '../types';

interface Props {
  data: ConsensusSnapshot;
}

/**
 * 机构一致预期卡片（深度分析结果页）。
 * 数据为「当前快照」口径（东财盈利预测 + 北向季度持股）——随研报/披露更新，
 * 不代表分析时点的历史状态，因此卡片上明示快照属性，避免误读为时点序列。
 */
function ConsensusCard({ data }: Props) {
  const hasRatings = data.ratings.buy !== null || data.ratings.add !== null;
  const est = data.forecasts.filter((f) => f.mark === 'E');
  const target =
    data.targetPriceMin !== null || data.targetPriceMax !== null
      ? `${data.targetPriceMin ?? '—'} ~ ${data.targetPriceMax ?? '—'} 元`
      : null;

  return (
    <div className="news-sentiment-card">
      <div className="news-sentiment-head">
        <h3 className="news-sentiment-title">机构一致预期</h3>
        <span className="news-badge news-badge--neutral">快照</span>
      </div>
      <div className="news-metrics">
        <div className="news-metric">
          <div className="news-metric-value">{data.orgNum ?? '—'}</div>
          <div className="news-metric-label">覆盖机构</div>
        </div>
        <div className="news-metric">
          <div className="news-metric-value">
            {hasRatings ? `${data.ratings.buy ?? 0}/${data.ratings.add ?? 0}` : '—'}
          </div>
          <div className="news-metric-label">买入/增持评级</div>
        </div>
        <div className="news-metric">
          <div className="news-metric-value">
            {est.length > 0 ? est.map((f) => f.eps.toFixed(2)).join(' / ') : '—'}
          </div>
          <div className="news-metric-label">
            EPS 预测{est.length > 0 ? `（${est.map((f) => `${f.year}E`).join('/')}）` : ''}
          </div>
        </div>
        <div className="news-metric">
          <div className="news-metric-value">
            {data.north?.holdSharesRatio != null ? `${data.north.holdSharesRatio}%` : '—'}
          </div>
          <div className="news-metric-label">北向持股占比</div>
        </div>
      </div>
      <ul className="news-list">
        {target && (
          <li className="news-item">
            <span className="news-dot news-dot--neutral" />
            <div className="news-item-body">
              <div className="news-item-title">机构目标价区间：{target}</div>
            </div>
          </li>
        )}
        {data.north?.date && (
          <li className="news-item">
            <span className="news-dot news-dot--neutral" />
            <div className="news-item-body">
              <div className="news-item-title">
                北向持股披露：{data.north.date}
                {data.north.holdMarketCap != null &&
                  `，市值 ${(data.north.holdMarketCap / 1e8).toFixed(0)} 亿`}
              </div>
              <div className="news-item-meta">
                <span>季度披露口径（2024-08 起停止逐日披露）</span>
              </div>
            </div>
          </li>
        )}
        <li className="news-item">
          <span className="news-dot news-dot--neutral" />
          <div className="news-item-body">
            <div className="news-item-meta">
              <span>当前时点快照（无历史序列），仅作研判参考、不参与历史回测</span>
            </div>
          </div>
        </li>
      </ul>
    </div>
  );
}

export default memo(ConsensusCard);

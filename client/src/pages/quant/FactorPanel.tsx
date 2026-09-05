import type {
  PriceVolumeFactor,
  PriceVolumeFactorName,
  FactorCategory,
  FactorPredictabilityHorizon,
  CompositeAlpha,
  CompositeDirection,
} from './types';

/** 因子中文显示名（提升可读性，原始 key 为英文） */
const FACTOR_LABELS: Record<PriceVolumeFactorName, string> = {
  volatility_1m: '1月波动率',
  volatility_3m: '3月波动率',
  idiosyncratic_vol: '特异波动率',
  reversal_1m: '1月反转',
  reversal_3m: '3月反转',
  residual_momentum_6m: '残差动量(6月)',
  momentum_12_1: '12-1动量',
  turnover_ratio_reversal: '换手率反转',
  amihud_illiquidity: 'Amihud非流动性',
  beta: '贝塔',
  max_daily_return_1m: '1月最大日收益',
};

const CATEGORY_LABELS: Record<FactorCategory, string> = {
  volatility: '波动率',
  reversal: '反转',
  momentum: '动量',
  liquidity: '流动性',
  volume: '成交',
  risk: '风险',
};

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

function formatP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 1e-4) return '<1e-4';
  return p.toExponential(2);
}

/** 单个持有期的预测力单元格：IC（按经济方向着色）+ p 值 + 显著徽标 */
function HorizonCell({ h }: { h: FactorPredictabilityHorizon | null }) {
  if (!h) return <span className="factor-muted">样本不足</span>;
  // effectiveIc > 0：因子预期方向与真实收益一致（有效）；< 0：显著但方向相反（需反转使用）
  const dirCls = h.significant ? (h.effectiveIc > 0 ? 'sig-valid' : 'sig-inverted') : 'sig-none';
  const tag = !h.significant ? '不显著' : h.effectiveIc > 0 ? '显著·方向一致' : '显著·方向相反';
  return (
    <div className="factor-horizon">
      <div className={`factor-ic ${dirCls}`}>IC {h.ic.toFixed(3)}</div>
      <div className="factor-pval">
        p={formatP(h.pValue)} · n={h.n}
      </div>
      <span className={`factor-badge ${dirCls}`}>{tag}</span>
    </div>
  );
}

const DIRECTION_LABEL: Record<CompositeDirection, string> = {
  up: '看多',
  down: '看空',
  neutral: '中性',
};

/** 多因子加权组合 alpha 汇总条：综合方向 + 各持有期 α + 显著因子数 + 方向一致率 */
function CompositeSummary({ alpha }: { alpha: CompositeAlpha }) {
  const dirCls =
    alpha.overallDirection === 'up'
      ? 'sig-valid'
      : alpha.overallDirection === 'down'
        ? 'sig-inverted'
        : 'sig-none';
  return (
    <div className="composite-summary">
      <div className={`composite-overall ${dirCls}`}>
        <span className="composite-overall-label">组合信号</span>
        <span className="composite-overall-dir">{DIRECTION_LABEL[alpha.overallDirection]}</span>
      </div>
      <div className="composite-horizons">
        {alpha.horizons.map((h) => (
          <div className="composite-horizon" key={h.period}>
            <span className="composite-horizon-period">
              {h.period === 21 ? '1月' : h.period === 63 ? '3月' : `${h.period}日`}
            </span>
            <span
              className={`composite-alpha ${h.direction === 'up' ? 'sig-valid' : h.direction === 'down' ? 'sig-inverted' : 'sig-none'}`}
            >
              α {h.alpha >= 0 ? '+' : ''}
              {h.alpha.toFixed(3)}
            </span>
            <span className="composite-meta">
              显著 {h.significantCount}/{h.evaluableCount}
              {h.significantCount > 0 ? ` · 一致率 ${(h.agreement * 100).toFixed(0)}%` : ''}
            </span>
          </div>
        ))}
      </div>
      {alpha.hasSignal ? (
        <div className="composite-foot">
          仅纳入统计显著（p&lt;0.05）因子，按 |t| 置信度加权方向校正 IC；多因子同向且置信越高 → |α|
          越大。
        </div>
      ) : (
        <div className="composite-foot composite-foot-empty">
          本轮无因子通过显著门槛（p&lt;0.05，已做重叠修正与 Holm
          多重检验校正）——这是如实结果而非异常：
          单股样本下因子显著性本就稀缺。可尝试拉长回测区间积累样本后重试。
        </div>
      )}
    </div>
  );
}

export default function FactorPanel({
  data,
  compositeAlpha,
}: {
  data: PriceVolumeFactor[];
  compositeAlpha?: CompositeAlpha;
}) {
  if (!data || data.length === 0) return null;
  return (
    <div className="card quant-panel factor-panel">
      <h3 className="quant-panel-title">
        量价因子与预测力
        <span className="factor-subtitle">
          当前快照值 + 对这只股票自身远期收益的时间序列 IC（21/63 交易日，Spearman + Student t）
        </span>
      </h3>
      {compositeAlpha && <CompositeSummary alpha={compositeAlpha} />}
      <div className="factor-table-wrap">
        <table className="factor-table">
          <thead>
            <tr>
              <th>因子</th>
              <th>方向</th>
              <th>当前值</th>
              <th>1月预测力</th>
              <th>3月预测力</th>
              <th>实证依据</th>
            </tr>
          </thead>
          <tbody>
            {data.map((f) => (
              <tr key={f.name} className={f.predictability?.hasSignal ? 'factor-row-signal' : ''}>
                <td>
                  <div className="factor-name">
                    {FACTOR_LABELS[f.name] ?? f.name}
                    {f.aShareAdjusted && (
                      <span className="factor-tag tag-adjusted" title="按 A 股实证做过方向翻转">
                        A股校正
                      </span>
                    )}
                  </div>
                  <div className="factor-cat">{CATEGORY_LABELS[f.category]}</div>
                </td>
                <td className="factor-dir">
                  {f.direction === 1 ? '↑ 值高→收益高' : '↓ 值低→收益高'}
                </td>
                <td className={f.available ? '' : 'factor-muted'}>{formatValue(f.value)}</td>
                <td>
                  {f.predictability ? (
                    <HorizonCell h={f.predictability.horizons[21] ?? null} />
                  ) : (
                    <span className="factor-muted">—</span>
                  )}
                </td>
                <td>
                  {f.predictability ? (
                    <HorizonCell h={f.predictability.horizons[63] ?? null} />
                  ) : (
                    <span className="factor-muted">—</span>
                  )}
                </td>
                <td className="factor-evidence" title={f.evidence}>
                  {f.evidence}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="factor-footnote">
        截面 IC 需多股票横截面（见「因子评估」端点）；此处为单股时间序列 IC，判定「该因子对
        <b>本标的</b>自身远期收益有无可证伪的预测力」。有效样本 &lt; 3 或回看不足（如 253 日最小窗口
        + 63 日持有期需 ≥316 根 K 线）时显示「样本不足」。无市场收益时 Beta 类因子恒为「样本不足」。
      </p>
    </div>
  );
}

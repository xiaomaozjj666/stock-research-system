import type {
  PriceVolumeFactor,
  PriceVolumeFactorName,
  FactorCategory,
  FactorPredictabilityHorizon,
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

export default function FactorPanel({ data }: { data: PriceVolumeFactor[] }) {
  if (!data || data.length === 0) return null;
  return (
    <div className="card quant-panel factor-panel">
      <h3 className="quant-panel-title">
        量价因子与预测力
        <span className="factor-subtitle">
          当前快照值 + 对这只股票自身远期收益的时间序列 IC（21/63 交易日，Spearman + Student t）
        </span>
      </h3>
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

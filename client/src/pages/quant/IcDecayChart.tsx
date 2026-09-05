import { useMemo } from 'react';
import type { FactorPredictability, PriceVolumeFactorName } from './types';
import { IC_DECAY_HORIZONS } from './types';

/** 因子中文显示名（与 FactorPanel 保持一致；图表内空间有限，用短名） */
const FACTOR_SHORT_LABELS: Partial<Record<PriceVolumeFactorName, string>> = {
  volatility_1m: '波动1月',
  volatility_3m: '波动3月',
  idiosyncratic_vol: '特异波动',
  reversal_1m: '反转1月',
  reversal_3m: '反转3月',
  residual_momentum_6m: '残差动量',
  momentum_12_1: '12-1动量',
  turnover_ratio_reversal: '换手反转',
  amihud_illiquidity: '非流动性',
  beta: '贝塔',
  max_daily_return_1m: '最大日收益',
};

const HORIZON_LABELS: Record<number, string> = {
  1: '1日',
  5: '5日',
  10: '10日',
  21: '1月',
  63: '3月',
};

const W = 560;
const H = 190;
const PAD_L = 34;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

interface DecayLine {
  name: PriceVolumeFactorName;
  label: string;
  /** 每个网格点的 effectiveIc；缺失（null）处断线 */
  values: (number | null)[];
  significant: boolean;
  /** 全部显著点的方向是否与经济方向一致（着色用） */
  valid: boolean;
}

/**
 * IC 衰减曲线：横轴 = 持有期（1/5/10/21/63 交易日），纵轴 = 经济方向 IC。
 * 一条线一个因子；显著因子着色（绿 = 方向一致 / 红 = 显著但反向），不显著的
 * 画浅灰作背景参照——「衰减到哪一档还显著」直接给出该股信号的自然调仓频率。
 */
export default function IcDecayChart({ data }: { data: FactorPredictability[] }) {
  const lines = useMemo<DecayLine[]>(() => {
    return data
      .map((f) => {
        const values = IC_DECAY_HORIZONS.map((h) => {
          const v = f.horizons[h];
          return v && Number.isFinite(v.effectiveIc) ? v.effectiveIc : null;
        });
        const finite = values.filter((v): v is number => v !== null);
        if (finite.length < 2) return null; // 单点画不出趋势
        const horizons = f.horizons;
        const sigPts = IC_DECAY_HORIZONS.map((h) => horizons[h]).filter(
          (v) => v && v.significant && Number.isFinite(v.effectiveIc),
        );
        const significant = sigPts.length > 0;
        const valid = significant
          ? sigPts.filter((v) => (v as { effectiveIc: number }).effectiveIc > 0).length >=
            sigPts.length / 2
          : false;
        return {
          name: f.name,
          label: FACTOR_SHORT_LABELS[f.name] ?? f.name,
          values,
          significant,
          valid,
        } as DecayLine;
      })
      .filter((l): l is DecayLine => l !== null);
  }, [data]);

  if (lines.length === 0) {
    return (
      <div className="ic-decay-empty">
        可用持有期不足两个（回看窗口或样本不足），无法绘制 IC 衰减曲线。拉长回测区间后重试。
      </div>
    );
  }

  const allFinite = lines.flatMap((l) => l.values.filter((v): v is number => v !== null));
  const maxAbs = Math.max(0.1, ...allFinite.map((v) => Math.abs(v)));
  const yMax = Math.ceil(maxAbs * 10) / 10; // 留 20% 余量向上取整到 0.1
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v + yMax) / (2 * yMax));
  const x = (i: number) => PAD_L + ((W - PAD_L - PAD_R) * i) / (IC_DECAY_HORIZONS.length - 1);

  const sigLines = lines.filter((l) => l.significant);
  const mutedLines = lines.filter((l) => !l.significant);

  return (
    <div className="ic-decay">
      <div className="ic-decay-head">
        <span className="ic-decay-title">IC 衰减曲线</span>
        <span className="ic-decay-note">
          信号随持有期的衰减（经济方向 IC）：衰减越慢，因子越扛得住低频调仓
        </span>
      </div>
      <svg
        className="ic-decay-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="IC 衰减曲线：各因子经济方向 IC 随持有期的变化"
      >
        {/* 零轴与正负区参考线 */}
        <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} className="ic-decay-zero" />
        {[yMax, -yMax].map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="ic-decay-gridline" />
            <text x={PAD_L - 4} y={y(v) + 3} className="ic-decay-ylabel">
              {v.toFixed(1)}
            </text>
          </g>
        ))}
        <text x={PAD_L - 4} y={y(0) + 3} className="ic-decay-ylabel">
          0
        </text>
        {/* 不显著的因子作背景 */}
        {mutedLines.map((l) => (
          <polyline
            key={l.name}
            points={l.values
              .map((v, i) => (v === null ? null : `${x(i)},${y(v)}`))
              .filter(Boolean)
              .join(' ')}
            className="ic-decay-line-muted"
            fill="none"
          />
        ))}
        {/* 显著因子高亮 */}
        {sigLines.map((l) => (
          <polyline
            key={l.name}
            points={l.values
              .map((v, i) => (v === null ? null : `${x(i)},${y(v)}`))
              .filter(Boolean)
              .join(' ')}
            className={l.valid ? 'ic-decay-line-valid' : 'ic-decay-line-inverted'}
            fill="none"
          />
        ))}
        {/* 横轴刻度 */}
        {IC_DECAY_HORIZONS.map((h, i) => (
          <text key={h} x={x(i)} y={H - 8} className="ic-decay-xlabel">
            {HORIZON_LABELS[h] ?? `${h}日`}
          </text>
        ))}
      </svg>
      {sigLines.length > 0 ? (
        <div className="ic-decay-legend">
          {sigLines.map((l) => (
            <span
              key={l.name}
              className={`ic-decay-chip ${l.valid ? 'sig-valid' : 'sig-inverted'}`}
            >
              {l.label}
            </span>
          ))}
        </div>
      ) : (
        <div className="ic-decay-legend ic-decay-legend-empty">
          本股无因子通过显著性门槛（已做重叠修正与 Holm 校正）——灰色曲线仍可观察衰减形态，
          但不应作为交易依据。
        </div>
      )}
    </div>
  );
}

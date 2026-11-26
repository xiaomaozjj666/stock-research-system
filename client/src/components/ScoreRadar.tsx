/**
 * 综合评分雷达（轻量 SVG 实现）
 * ----------------------------------------------------------------------------
 * 这个五维雷达此前用 ECharts 的 RadarChart + 极坐标系统绘制。为了 5 个静态分数
 * 引入整块 radar 渲染代码（实测 11.9 kB），是当前前端体积里性价比最低的一块。
 * 换成直接画 SVG：同样的五边形网格 + 轴标签 + 顶点数值（原生 <title> 提供悬停
 * 明细，替代原来的 tooltip），视觉与信息量不变，且不再依赖 ECharts 的雷达坐标系。
 *
 * 评分口径与原图表一致：五个维度上限 20，越界值夹紧到 [0, 20]。
 */

const MAX_SCORE = 20;
const VIEW = 300;
const CENTER = VIEW / 2;
const RADIUS = 96;
const LABEL_GAP = 22;

interface ScoreLike {
  profit_quality: number;
  growth: number;
  valuation: number;
  industry_boom: number;
  risk_deduction: number;
}

export interface ScoreRadarProps {
  scores?: ScoreLike | null;
}

const AXES = [
  { key: 'profit_quality' as const, label: '盈利质量' },
  { key: 'growth' as const, label: '成长性' },
  { key: 'valuation' as const, label: '估值性价比' },
  { key: 'industry_boom' as const, label: '行业景气度' },
  { key: 'risk_deduction' as const, label: '风险水平' },
];

function clampScore(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_SCORE, value));
}

function vertex(index: number, ratio: number): { x: number; y: number } {
  // 从正上方开始顺时针分布 5 个轴
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / AXES.length;
  const r = RADIUS * ratio;
  return { x: CENTER + r * Math.cos(angle), y: CENTER + r * Math.sin(angle) };
}

function polygonPoints(values: number[]): string {
  return values
    .map((value, index) => {
      const p = vertex(index, clampScore(value) / MAX_SCORE);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(' ');
}

export default function ScoreRadar({ scores }: ScoreRadarProps) {
  const values = AXES.map((axis) => clampScore(scores?.[axis.key]));
  const summary = AXES.map((axis, i) => `${axis.label} ${values[i]}/${MAX_SCORE}`).join('，');

  return (
    <svg
      className="score-radar"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      role="img"
      aria-label={`综合评分雷达：${summary}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>综合评分</title>
      {/* 四圈网格：由内到外 25% / 50% / 75% / 100% */}
      {[0.25, 0.5, 0.75, 1].map((ratio) => (
        <polygon
          key={ratio}
          points={polygonPoints(AXES.map(() => MAX_SCORE * ratio))}
          fill="none"
          stroke="var(--border-default, #3a3a3a)"
          strokeWidth={1}
        />
      ))}
      {/* 轴线 */}
      {AXES.map((axis, index) => {
        const outer = vertex(index, 1);
        return (
          <line
            key={axis.key}
            x1={CENTER}
            y1={CENTER}
            x2={outer.x}
            y2={outer.y}
            stroke="var(--border-default, #3a3a3a)"
            strokeWidth={1}
          />
        );
      })}
      {/* 评分多边形 */}
      <polygon
        points={polygonPoints(values)}
        fill="var(--accent-dim, rgba(76,141,255,0.18))"
        stroke="var(--accent, #4c8dff)"
        strokeWidth={2}
        strokeLinejoin="round"
      >
        <title>{summary}</title>
      </polygon>
      {/* 轴标签 + 顶点数值 */}
      {AXES.map((axis, index) => {
        const outer = vertex(index, 1);
        const dx = (outer.x - CENTER) / RADIUS;
        const dy = (outer.y - CENTER) / RADIUS;
        const labelX = CENTER + dx * (RADIUS + LABEL_GAP);
        const labelY = CENTER + dy * (RADIUS + LABEL_GAP) + 4;
        const point = vertex(index, values[index] / MAX_SCORE);
        const anchor = dx > 0.3 ? 'start' : dx < -0.3 ? 'end' : 'middle';
        return (
          <g key={axis.key}>
            <text
              x={labelX}
              y={labelY}
              textAnchor={anchor}
              fill="var(--text-secondary, #b0b0b0)"
              fontSize={12}
            >
              {axis.label}
            </text>
            <text
              x={point.x}
              y={point.y - 6}
              textAnchor="middle"
              fill="var(--text-secondary, #b0b0b0)"
              fontSize={11}
            >
              {values[index]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

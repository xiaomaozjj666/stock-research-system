import EChart from './EChart';
import type { WatchlistNewsBacktestReport, NewsSignal } from '../types';

// 设计系统配色（与 index.css / ChartsSection 协调）：红=看多、绿=看空、灰=无新闻
const BULL = { r: 239, g: 68, b: 68 }; // #ef4444
const BEAR = { r: 34, g: 197, b: 94 }; // #22c55e
const NEUTRAL = { r: 100, g: 116, b: 139 }; // #64748b

/** 新闻姿态颜色：极性决定红/绿，影响强度(weightedImpact)决定深浅 */
function postureColor(polarity: number, weightedImpact: number, hasNews: boolean): string {
  if (!hasNews) return `rgba(${NEUTRAL.r},${NEUTRAL.g},${NEUTRAL.b},0.45)`;
  const intensity = 0.4 + 0.6 * Math.min(1, Math.max(0, weightedImpact));
  // 极性恰为 0 的"中性新闻"必须单独一类：此前 `polarity > 0 ? 红 : 绿` 会把它涂成看空色，
  // 中性消息看起来像利空。用中性灰（与"无新闻"的灰同色系、但按影响强度取不透明度区分）。
  if (polarity === 0) return `rgba(${NEUTRAL.r},${NEUTRAL.g},${NEUTRAL.b},${intensity.toFixed(3)})`;
  const c = polarity > 0 ? BULL : BEAR;
  return `rgba(${c.r},${c.g},${c.b},${intensity.toFixed(3)})`;
}

/** 极性是否为中性（0）：图例与 tooltip 与配色共用同一判定，避免两处口径打架 */
function isNeutralNews(polarity: number, hasNews: boolean): boolean {
  return hasNews && polarity === 0;
}

interface RowVM {
  label: string;
  code: string;
  name: string | null;
  polarity: number;
  weightedImpact: number;
  bullishRatio: number;
  hasNews: boolean;
  posture: number | null;
}

function toViewModel(report: WatchlistNewsBacktestReport): RowVM[] {
  const rows = report.results.map((row) => {
    const ns: NewsSignal | null = row.newsSentiment;
    const hasNews = !!ns?.hasNews;
    return {
      label: `${row.code}${row.name ? ' ' + row.name : ''}`,
      code: row.code,
      name: row.name,
      polarity: hasNews ? ns!.polarity : 0,
      weightedImpact: hasNews ? ns!.weightedImpact : 0,
      bullishRatio: hasNews ? ns!.bullishRatio : 0,
      hasNews,
      posture: row.bestStrategy?.newsAware?.posture ?? null,
    } satisfies RowVM;
  });
  // 按极性降序：看多在前、看空在后；无新闻(极性0)自然排末尾，保持相对稳定
  return rows.slice().sort((a, b) => b.polarity - a.polarity);
}

interface TooltipParam {
  data: { _extra: RowVM };
}
interface LabelParam {
  data: { _extra: RowVM };
}

export default function NewsPostureHeatBar({
  report,
}: {
  report: WatchlistNewsBacktestReport | null;
}) {
  if (!report || report.results.length === 0) return null;

  const vm = toViewModel(report);
  const labels = vm.map((r) => r.label);
  const data = vm.map((r) => ({
    value: Number(r.polarity.toFixed(3)),
    itemStyle: {
      color: postureColor(r.polarity, r.weightedImpact, r.hasNews),
      borderRadius: [3, 3, 3, 3],
    },
    _extra: r,
  }));

  const height = Math.max(240, Math.min(560, vm.length * 38 + 56));

  const option = {
    backgroundColor: 'transparent',
    textStyle: { color: '#a0a0a0' },
    grid: { left: 116, right: 56, top: 16, bottom: 28 },
    tooltip: {
      trigger: 'item' as const,
      formatter: (p: TooltipParam) => {
        const r = p.data._extra;
        if (!r.hasNews) return `<b>${r.code}</b> ${r.name ?? ''}<br/>无最新消息`;
        const postureTxt = r.posture != null ? `${(r.posture * 100).toFixed(0)}%` : '—';
        const polarityTxt = isNeutralNews(r.polarity, r.hasNews)
          ? `${r.polarity.toFixed(2)}（中性）`
          : r.polarity.toFixed(2);
        return [
          `<b>${r.code}</b> ${r.name ?? ''}`,
          `新闻极性：${polarityTxt}`,
          `影响强度：${(r.weightedImpact * 100).toFixed(0)}%`,
          `看多占比：${(r.bullishRatio * 100).toFixed(0)}%`,
          `新闻姿态：${postureTxt}`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'value' as const,
      min: -1,
      max: 1,
      name: '新闻极性',
      nameTextStyle: { color: '#a0a0a0' },
      axisLabel: { color: '#a0a0a0' },
      splitLine: { lineStyle: { color: '#2a2a2a', type: 'dashed' as const } },
    },
    yAxis: {
      type: 'category' as const,
      data: labels,
      axisLabel: { color: '#a0a0a0', fontSize: 12 },
      axisLine: { lineStyle: { color: '#2a2a2a' } },
      axisTick: { show: false },
    },
    series: [
      {
        type: 'bar' as const,
        data,
        barWidth: '62%',
        label: {
          show: true,
          position: 'right' as const,
          color: '#a0a0a0',
          formatter: (p: LabelParam) => p.data._extra.polarity.toFixed(2),
        },
        markLine: {
          silent: true,
          symbol: 'none' as const,
          data: [{ xAxis: 0 }],
          lineStyle: { color: '#888', type: 'solid' as const },
          label: { formatter: '中性', color: '#888', fontSize: 11 },
        },
      },
    ],
  };

  return (
    <div className="card watchlist-heatbar">
      <div className="section-title">新闻姿态热力条（自选股批量回测总览）</div>
      {/* canvas 对读屏不可见：没有 ariaLabel 时这张图对辅助技术等于不存在 */}
      <EChart
        option={option}
        style={{ height }}
        ariaLabel="新闻姿态热力条：每行一只自选股，条形长度与颜色表示新闻极性（红=偏多、绿=偏空、灰=中性或无消息），颜色深浅表示影响强度"
      />
      <div className="watchlist-heatbar-legend">
        <span className="hb-dot hb-bull" /> 偏多（红）
        <span className="hb-dot hb-bear" /> 偏空（绿）
        <span className="hb-dot hb-flat" /> 中性·极性为 0（灰）
        <span className="hb-dot hb-neutral" /> 无最新消息（浅灰）
        <span className="hb-hint">颜色越深＝新闻影响越强；条长按极性，右多左空</span>
      </div>
    </div>
  );
}

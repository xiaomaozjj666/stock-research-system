import { formatMarketCap } from '../lib/format';
import type { RatingAccuracy, StockPoolItem } from '../api/generated';

/**
 * 报告头只需要 StockPoolItem 的一个子集；直接引用契约类型，字段改名会立刻编译报错。
 * 附加字段保持可选：头部可以在“只有基础评分”的场景单独渲染（如组件测试）。
 */
type StockData = Pick<
  StockPoolItem,
  'stock_code' | 'stock_name' | 'industry' | 'total_score' | 'rating'
> &
  Partial<
    Pick<StockPoolItem, 'valuation' | 'vs_previous' | 'degraded_experts' | 'rating_accuracy'>
  >;

interface ReportHeaderProps {
  data: StockData;
  research_confidence?: string;
  onExport?: () => void;
  /** 报告生成时间（ISO）；历史快照时为当时生成的时间 */
  generatedAt?: string;
  /** 行情数据截止日（YYYY-MM-DD，最后一根 K 线） */
  dataAsOf?: string;
}

function getRatingClass(rating: string) {
  if (rating.includes('优先')) return 'priority';
  if (rating.includes('持续')) return 'watch';
  if (rating.includes('谨慎')) return 'caution';
  if (rating.includes('规避')) return 'avoid';
  return 'watch';
}

/** 较上次分析的评分变化标签（记忆反思闭环展示） */
function VsPreviousTag({
  prev,
  currentRating,
}: {
  prev: NonNullable<StockData['vs_previous']>;
  currentRating: string;
}) {
  const delta = prev.score_delta;
  const up = delta > 0;
  const down = delta < 0;
  const cls = up ? 'vs-previous-up' : down ? 'vs-previous-down' : 'vs-previous-flat';
  const arrow = up ? '▲' : down ? '▼' : '＝';
  return (
    <div
      className={`vs-previous-tag ${cls}`}
      title={`上次分析：${prev.previous_date} · ${prev.previous_rating} · ${prev.previous_score} 分`}
    >
      {arrow} 较上次分析 {up ? '+' : ''}
      {Math.round(delta * 100) / 100} 分
      {prev.rating_changed && (
        <span className="vs-previous-rating">
          · 评级 {prev.previous_rating} → {currentRating}
        </span>
      )}
    </div>
  );
}

/** 本次降级未参与研判的专家提示（覆盖度披露，避免按满员研判理解置信度） */
function DegradedTag({ names }: { names: string[] }) {
  return (
    <div
      className="degraded-tag"
      title={`未能返回结果：${names.join('、')}。已自动降级剔除，结论置信度相应下调`}
    >
      {names.length} 位专家降级未参与
    </div>
  );
}

/**
 * 历史评级命中率（决策-结果闭环展示）。
 * 命中率可用 → 显示命中率；样本尚未到期（<20 天）→ 显示「统计积累中」，
 * 让用户知道闭环在运转而不是功能缺失。
 */
function AccuracyTag({ stat, overall }: { stat: RatingAccuracy; overall?: RatingAccuracy }) {
  if (stat.accuracyPct !== null) {
    const overallText =
      overall?.accuracyPct !== null && overall?.accuracyPct !== undefined
        ? `；全部标的整体命中率 ${overall.accuracyPct}%（${overall.hitCount}/${overall.judgedCount}）`
        : '';
    return (
      <div
        className="accuracy-tag"
        title={`近 ${stat.judgedCount} 次方向判断命中 ${stat.hitCount} 次${
          stat.avgReturnPct !== null ? `，评级后平均区间收益 ${stat.avgReturnPct}%` : ''
        }${overallText}`}
      >
        历史命中率 {stat.accuracyPct}%（{stat.hitCount}/{stat.judgedCount}）
      </div>
    );
  }
  if ((stat.pendingCount ?? 0) > 0) {
    return (
      <div
        className="accuracy-tag accuracy-tag-accumulating"
        title="评级已记入台账，持有满 20 个交易日后回填实际收益并统计命中率"
      >
        命中率统计积累中（{stat.pendingCount} 条评级待到期）
      </div>
    );
  }
  return null;
}

/** 生成本地时区 YYYY-MM-DD HH:mm（不用 toLocaleString：各浏览器格式不一致，导出/打印不稳定） */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 数据截止日距今天数（日历日粗判，非交易日精确计算）。
 * 阈值取宽松值：跨周末/小长假属正常，只有明显滞后才提示，避免天天报警造成狼来了。
 */
function daysSince(dateStr: string): number | null {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((todayStart.getTime() - d.getTime()) / 86_400_000);
}

export default function ReportHeader({
  data,
  research_confidence,
  onExport,
  generatedAt,
  dataAsOf,
}: ReportHeaderProps) {
  const staleDays = dataAsOf ? daysSince(dataAsOf) : null;
  const staleHint = staleDays !== null && staleDays > 5 ? `（距今 ${staleDays} 天，可能滞后）` : '';
  // 头部只放置信度结论的首句；完整说明（可达 100+ 字）放进 title，
  // 否则右侧面板会被长句撑宽、反过来把左侧股票信息压成一条。
  const confidenceSummary = research_confidence?.split('。')[0]?.trim() || research_confidence;
  return (
    <div className="card report-header">
      <div className="report-header-top">
        <div>
          <div>
            <span className="stock-name">{data.stock_name}</span>
            <span className="stock-code">{data.stock_code}</span>
            <span className="stock-industry">{data.industry}</span>
          </div>
          <div className="header-meta">
            {data.valuation?.currentPrice && (
              <div className="header-meta-item">
                当前价格：<span>¥{data.valuation.currentPrice.toFixed(2)}</span>
              </div>
            )}
            {data.valuation?.marketCap && (
              <div className="header-meta-item">
                市值：<span>{formatMarketCap(data.valuation.marketCap)}</span>
              </div>
            )}
            {/* 时间语境：没有时间戳的金融结论无法判断新鲜度，导出后更是完全失去时间锚点 */}
            {dataAsOf && (
              <div className="header-meta-item">
                数据截止：<span>{dataAsOf}</span> 收盘{staleHint}
              </div>
            )}
            {generatedAt && (
              <div className="header-meta-item">
                生成于：<span>{formatDateTime(generatedAt)}</span>
              </div>
            )}
          </div>
        </div>
        {/* 右侧面板：评分 + 评级同一行，附加标签在下，导出 / 打印收在面板底部；
            此前三者分散成三列，评分孤立在中间、按钮浮在右上角 */}
        <div className="report-header-side">
          <div className="score-block">
            <div className="score-main">
              <div className="score-number">{data.total_score}</div>
              <div className="score-unit">综合评分</div>
              <div className={`rating-tag ${getRatingClass(data.rating)}`}>{data.rating}</div>
            </div>
            {data.vs_previous && (
              <VsPreviousTag prev={data.vs_previous} currentRating={data.rating} />
            )}
            {data.degraded_experts && data.degraded_experts.length > 0 && (
              <DegradedTag names={data.degraded_experts} />
            )}
            {data.rating_accuracy && (
              <AccuracyTag
                stat={data.rating_accuracy.stock}
                overall={data.rating_accuracy.overall}
              />
            )}
            {confidenceSummary && (
              <div className="confidence-tag" title={research_confidence}>
                研究置信度：{confidenceSummary}
              </div>
            )}
          </div>
          {/* 导出 / 打印并排：打印样式已在 index.css 的 @media print 里把设计变量整体翻浅色，
            这里只需要一个入口；两个按钮都用 .btn-ghost + .no-print，打印时必定隐藏
            （.no-print 是通用钩子，不依赖 @media print 里那份按类名列举的清单）。 */}
          <div className="report-actions no-print">
            {onExport && (
              <button
                className="btn-ghost report-export-btn no-print"
                onClick={onExport}
                title="导出为 Markdown"
              >
                导出报告
              </button>
            )}
            <button
              className="btn-ghost report-export-btn no-print"
              onClick={() => window.print()}
              title="打印或另存为 PDF"
            >
              打印
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

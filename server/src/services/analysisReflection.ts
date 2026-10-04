import type { ExpertOpinion } from '../types.js';
import type { RatingAccuracy } from '../types.js';

/**
 * 分析结论的「双层自省 + 逻辑闭环」文案生成。
 *
 * 为什么要抽出来：这段逻辑编码的是**研判可信度的业务规则**——现金流/利润一致性
 * 阈值 0.5 / 0.9、毛利率波动 10 个百分点、PE 历史分位 20 / 80 分位、营收增速 5%、
 * 以及「最可能的看错场景」取自专家反对论点的置信度门槛 65。原先它们全部内联在
 * `analysisPipeline.executeAnalysis`（一个 780+ 行的函数）里，只能通过跑完整条
 * 流水线来间接覆盖：改一个阈值无法写断言，也无法在不触网的前提下枚举边界。
 *
 * 抽成纯函数后，阈值本身就是可单测的契约。**本文件不含任何 IO、时钟或随机性**，
 * 输出只由入参决定，因此断点续跑重放会得到逐字相同的文案（与既有行为一致）。
 */

/** 事后校准统计（与 outcomeTracker.getRatingAccuracy 的返回一致，此处只取用到的字段） */
export interface ReflectionAccuracy {
  stock: Pick<RatingAccuracy, 'sampleCount' | 'judgedCount' | 'hitCount' | 'accuracyPct'>;
}

export interface ReflectionInput {
  /** 财务数据跨度（年），用于"历史数据外推"那条自省 */
  yearCount: number;
  /** 财务年份标签序列，用于拼出 "2022-2024" 这样的跨度区间 */
  years: string[];
  /** 最新营收增速（%）；不足两年数据时为 0 */
  revenueGrowthLatest: number;
  /** 经营现金流 / 净利润；分母为 0 或非有限数时为 0 */
  cashFlowRatio: number;
  /** 毛利率极差（百分点） */
  grossMarginRange: number;
  /** 当前 PE 在历史区间中的分位（0~100） */
  pePercentile: number;
  /** 完全失败被剔除的专家名（与"部分降级"不是一回事） */
  degradedExperts: string[];
  /** 事后校准统计；null 或无样本时不披露 */
  accuracySummary: ReflectionAccuracy | null;
  /** 参与研判的专家总数（用于覆盖度分母） */
  expertTotal: number;
  /** 取某位专家的整体情绪；缺失时返回 undefined */
  sentimentOf: (expertKey: string) => ExpertOpinion['overallSentiment'] | undefined;
  /** 本轮全部专家意见（用于提取"最可能的看错场景"） */
  allOpinions: ExpertOpinion[];
}

/** 取反对论点里置信度够高的前若干条，作为"最可能看错"的候选 */
const RISK_MIN_CONFIDENCE = 65;
const MAX_RISKS = 6;
const RISK_TEXT_MAX = 60;

/**
 * 从专家意见里提取动态风险条目：只看**反对**论点且置信度达标的，超长截断。
 *
 * 单独导出是因为这段逻辑原先在 analysisPipeline 里被**复制了两份**——一份喂给
 * 自省文案的「逻辑闭环②」，一份喂给报告的 `risk_list`。两份的阈值与截断规则
 * 必须逐字一致，否则报告正文说的风险和 risk_list 列的就对不上。收到这里后只有
 * 一处实现，两处调用。
 */
export function extractOpposeRisks(allOpinions: ExpertOpinion[]): string[] {
  return allOpinions
    .flatMap((o) =>
      o.arguments
        .filter((a) => a.type === 'oppose' && a.confidence >= RISK_MIN_CONFIDENCE)
        .map((a) =>
          a.text.length > RISK_TEXT_MAX ? a.text.slice(0, RISK_TEXT_MAX - 3) + '...' : a.text,
        ),
    )
    .slice(0, MAX_RISKS);
}

export function buildReflectionNotes(input: ReflectionInput): string[] {
  const {
    yearCount,
    years,
    revenueGrowthLatest,
    cashFlowRatio,
    grossMarginRange,
    pePercentile,
    degradedExperts,
    accuracySummary,
    expertTotal,
    sentimentOf,
    allOpinions,
  } = input;

  const notes: string[] = [];

  // 专家覆盖度披露：有专家降级时如实说明，避免读者按满员研判理解置信度
  if (degradedExperts.length > 0) {
    notes.push(
      `【自省·覆盖度】本次 ${expertTotal - degradedExperts.length}/${expertTotal} 位专家参与研判，${degradedExperts.join('、')}未能返回结果，已自动降级剔除，结论置信度相应下调。`,
    );
  }

  // 事后校准披露：让报告读者知道这套评级在该股上的历史兑现情况
  if (accuracySummary && accuracySummary.stock.sampleCount > 0) {
    const s = accuracySummary.stock;
    const calibration =
      s.accuracyPct !== null
        ? `该股历史评级命中率 ${s.accuracyPct}%（${s.hitCount}/${s.judgedCount} 次方向判断兑现）`
        : `该股已累积 ${s.sampleCount} 次评级样本，样本量尚不足以统计命中率`;
    notes.push(`【自省·事后校准】${calibration}，本次结论请结合该历史表现审慎采信。`);
  }

  // 第一层：事实自省 - 基于数据阈值触发
  // 营收增速与专家情绪矛盾检查
  if (revenueGrowthLatest < 5 && sentimentOf('fundamental') === 'bullish') {
    notes.push(
      `【自省】营收增速仅${revenueGrowthLatest.toFixed(1)}%，基本面专家仍看多，可能存在乐观偏差。`,
    );
  }

  // 现金流/利润一致性检查
  if (cashFlowRatio < 0.5) {
    notes.push(`【自省·警告】经营现金流/净利润仅${cashFlowRatio.toFixed(2)}，盈利质量存疑。`);
  } else if (cashFlowRatio > 0.9) {
    notes.push(`【自省·验证通过】经营现金流/净利润=${cashFlowRatio.toFixed(2)}，盈利质量可靠。`);
  }

  // 毛利率稳定性检查
  if (grossMarginRange > 10) {
    notes.push(`【自省·警告】毛利率波动${grossMarginRange.toFixed(1)}个百分点，盈利稳定性较差。`);
  } else if (grossMarginRange < 3) {
    notes.push(`【自省·验证通过】毛利率波动仅${grossMarginRange.toFixed(1)}个百分点，稳定性高。`);
  }

  // 第二层：逻辑闭环 - 通用化 4 个自问
  // 逻辑闭环①：历史数据外推的局限性
  notes.push(
    `【逻辑闭环①】分析基于${yearCount}年财务数据外推，历史趋势在行业拐点可能失效。数据跨度${yearCount}年（${years[0]}-${years[yearCount - 1]}）。`,
  );

  // 逻辑闭环②：最可能的看错场景（从动态风险列表取第一条）
  const preComputedRisks = extractOpposeRisks(allOpinions);
  const topRisk = preComputedRisks[0] || '未知风险';
  notes.push(`【逻辑闭环②】最可能的"看错"场景：${topRisk}。`);

  // 逻辑闭环③：市场是否已 price in（基于 PE 历史分位）
  if (pePercentile <= 20) {
    notes.push(
      `【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，市场可能已充分反映悲观预期。`,
    );
  } else if (pePercentile >= 80) {
    notes.push(
      `【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，乐观预期可能已充分定价。`,
    );
  } else {
    notes.push(`【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，估值处于合理区间。`);
  }

  // 逻辑闭环④：关键跟踪指标（基于专家情绪动态判断）
  const topConcern =
    sentimentOf('industry') === 'bearish'
      ? '行业景气度下行'
      : sentimentOf('valuation') === 'bearish'
        ? '估值压力'
        : '基本面变化';
  notes.push(`【逻辑闭环④】如果只能跟踪一个方向，应重点关注：${topConcern}。`);

  return notes;
}

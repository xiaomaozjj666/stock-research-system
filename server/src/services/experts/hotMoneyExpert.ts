/**
 * 游资分析师（A 股特色角色）
 * ----------------------------------------------------------------------------
 * A 股散户占比高、游资活跃，本专家专门评估游资/投机资金关注度与风险：
 *   - 游资偏好特征（小市值 + 高换手 + 题材概念 + 价格弹性大）
 *   - 筹码集中度推断（市值/股东户数代理指标）
 *   - 短期资金博弈风险（追高被套、龙虎榜特征、连板后回落风险）
 *   - 机构 vs 游资博弈格局（机构持仓占比代理）
 *
 * 规则降级：按市值 + PE + 价格分级判断游资关注度，LLM 不可用时给出方向性判断。
 */
import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';
import { runExpertWithLLM } from '../../llm/expertRunner.js';
import { formatContext } from '../../llm/prompts.js';

const EXPERT_NAME = '游资分析师';

const SYSTEM_PROMPT = `你是资深 A 股游资博弈分析师，专注短线资金流向与游资行为模式研究，拥有 10 年实战经验。
分析维度：
- 游资偏好：小市值（<200亿）、高换手、题材概念股更容易吸引游资关注
- 筹码结构：股东户数变化、户均持股金额、筹码集中或分散趋势
- 龙虎榜特征：是否有知名游资席位反复出现，机构买卖力量对比
- 题材催化：是否有短期事件驱动（业绩超预期/政策利好/行业风口）引发资金追捧
- 博弈风险：连板后获利盘抛压、游资撤退时的流动性枯竭风险、追高被套概率
- 机构 vs 游资：机构持仓占比高则游资影响力有限，反之游资主导则波动加剧
要求：
- 明确区分"游资主导"与"机构主导"的博弈格局
- evidenceType 标注：fact=可观测数据，inference=行为模式推断，hypothesis=假设性判断
- 游资高度活跃的标的须标注"短期波动风险极高"
- overallSentiment 反映游资博弈格局下的短期方向倾向（非长期价值判断）`;

/** 小市值阈值（亿元）：< 200 亿视为游资可操作标的 */
const SMALL_CAP_THRESHOLD = 200;

/** 微盘股阈值（亿元）：< 50 亿 */
const MICRO_CAP_THRESHOLD = 50;

/** 高 PE 阈值：> 60 视为高估值/题材驱动 */
const HIGH_PE_THRESHOLD = 60;

/**
 * 规则引擎研判（LLM 不可用时降级）
 */
function hotMoneyExpertRule(
  _financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): ExpertOpinion {
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];
  const marketCap = valuation.marketCap || 0;
  const pe = valuation.pe || 0;
  const price = valuation.currentPrice || 0;

  // === 市值分级 → 游资偏好判断 ===
  let capCategory: 'micro' | 'small' | 'mid' | 'large';
  if (marketCap < MICRO_CAP_THRESHOLD) {
    capCategory = 'micro';
  } else if (marketCap < SMALL_CAP_THRESHOLD) {
    capCategory = 'small';
  } else if (marketCap < 1000) {
    capCategory = 'mid';
  } else {
    capCategory = 'large';
  }

  if (capCategory === 'micro' || capCategory === 'small') {
    arguments_.push({
      text: `市值${marketCap.toFixed(0)}亿（${capCategory === 'micro' ? '微盘' : '小盘'}股），属于游资偏好标的，易被短线资金拉升，但也面临流动性枯竭风险`,
      confidence: 80,
      type: 'support',
      evidenceType: 'fact',
    });
    keyPoints.push(`市值${marketCap.toFixed(0)}亿，游资偏好标的`);
  } else if (capCategory === 'large') {
    arguments_.push({
      text: `市值${marketCap.toFixed(0)}亿属于大盘股，游资难以单独推动，走势更依赖基本面与机构资金，游资博弈特征弱`,
      confidence: 78,
      type: 'oppose',
      evidenceType: 'fact',
    });
    keyPoints.push(`大盘股，游资影响力有限`);
  } else {
    arguments_.push({
      text: `市值${marketCap.toFixed(0)}亿属中盘股，游资与机构博弈并存，需结合题材催化判断短期方向`,
      confidence: 65,
      type: 'support',
      evidenceType: 'inference',
    });
    keyPoints.push(`中盘股，游资机构博弈并存`);
  }

  // === PE 与估值泡沫判断 ===
  if (pe > HIGH_PE_THRESHOLD && (capCategory === 'micro' || capCategory === 'small')) {
    arguments_.push({
      text: `PE高达${pe.toFixed(0)}倍且市值偏小，典型题材驱动估值泡沫，游资撤离后估值回归风险极大`,
      confidence: 85,
      type: 'oppose',
      evidenceType: 'fact',
    });
    keyPoints.push(`PE ${pe.toFixed(0)}倍 + 小市值 = 题材泡沫风险`);
  } else if (pe > 0 && pe < 20 && capCategory === 'large') {
    arguments_.push({
      text: `PE仅${pe.toFixed(0)}倍的大盘股，估值合理，以机构长线资金为主，游资短线博弈空间小`,
      confidence: 70,
      type: 'oppose',
      evidenceType: 'fact',
    });
    keyPoints.push(`低PE大盘股，机构主导`);
  }

  // === 价格绝对值 → 参与门槛 ===
  if (price > 0 && price < 10) {
    arguments_.push({
      text: `股价仅¥${price.toFixed(2)}，参与门槛极低，散户/游资参与度高，短期波动加剧`,
      confidence: 72,
      type: 'support',
      evidenceType: 'fact',
    });
    keyPoints.push(`低价股，散户游资参与度高`);
  } else if (price > 100) {
    arguments_.push({
      text: `股价¥${price.toFixed(2)}属高价股，散户参与门槛高，以机构或高净值投资者为主，游资影响力相对有限`,
      confidence: 68,
      type: 'oppose',
      evidenceType: 'fact',
    });
    keyPoints.push(`高价股，机构为主`);
  }

  // === 短期博弈风险提示 ===
  if (capCategory === 'micro' || capCategory === 'small') {
    arguments_.push({
      text: '游资主导标的短期波动极大，追高被套风险高，建议设置严格止损纪律，不宜重仓',
      confidence: 75,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push('短期波动极大，严格止损');
  }

  // === 综合情绪 ===
  const supportCount = arguments_.filter((a) => a.type === 'support').length;
  const opposeCount = arguments_.filter((a) => a.type === 'oppose').length;

  let overallSentiment: 'bullish' | 'neutral' | 'bearish';
  if (capCategory === 'large') {
    overallSentiment = 'neutral';
  } else if (pe > HIGH_PE_THRESHOLD) {
    overallSentiment = 'bearish';
  } else if (supportCount > opposeCount) {
    overallSentiment = 'bullish';
  } else {
    overallSentiment = 'neutral';
  }

  const avgConfidence = Math.round(
    arguments_.reduce((s, a) => s + a.confidence, 0) / arguments_.length,
  );

  return {
    expert: EXPERT_NAME,
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: keyPoints.slice(0, 6),
  };
}

/**
 * 游资分析师
 * LLM 可用时调用 LLM 进行深度研判；不可用或失败时降级规则引擎。
 */
export async function hotMoneyExpert(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): Promise<ExpertOpinion> {
  return runExpertWithLLM({
    expertName: EXPERT_NAME,
    systemPrompt: SYSTEM_PROMPT,
    context: formatContext(financial, valuation, info),
    ruleFallback: () => hotMoneyExpertRule(financial, valuation, info),
  });
}

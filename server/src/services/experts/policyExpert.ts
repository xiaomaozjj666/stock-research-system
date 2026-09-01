/**
 * 政策分析师（A 股特色角色）
 * ----------------------------------------------------------------------------
 * A 股受政策驱动显著（"政策市"特征），本专家专门评估政策面影响：
 *   - 产业政策方向（支持/中立/限制）与行业契合度
 *   - 监管风险（行业专项整治、合规收紧）
 *   - 补贴/退税依赖度（政府补助占净利比）
 *   - 资本市场政策（再融资新规、减持新规、注册制影响）
 *
 * 规则降级：按行业关键词匹配政策敏感度分级，LLM 不可用时给出方向性判断。
 */
import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';
import { safeDiv } from '../safeDiv.js';
import { runExpertWithLLM } from '../../llm/expertRunner.js';
import { formatContext } from '../../llm/prompts.js';

const EXPERT_NAME = '政策分析师';

const SYSTEM_PROMPT = `你是资深 A 股政策分析师，专注产业政策与监管环境对上市公司的影响评估，拥有 12 年政策研究经验。
分析维度：
- 产业政策方向：所在行业是否属于国家重点支持（新能源/半导体/人工智能/高端制造/生物医药），或受限制（房地产/教培/游戏）
- 监管风险：行业是否处于专项整治期，合规要求是否趋严，有无突发监管事件风险
- 补贴依赖：政府补助/净利润比例，补助退坡对盈利的冲击程度
- 资本市场政策：再融资/减持/回购新规对公司的影响，注册制下同行业供给增加的竞争压力
- 区域政策：公司注册地/主要经营地的区域性政策红利或风险
要求：
- 政策判断需标注依据来源（公开政策文件/行业指导目录/新闻）
- evidenceType 标注：fact=已出台政策文件，inference=政策趋势推断，hypothesis=假设性判断
- 补贴依赖度超过 30% 须标记为高风险（补助可持续性存疑）
- overallSentiment 综合政策利好与利空加权判断`;

/** 政策支持行业关键词 */
const POLICY_SUPPORT_KEYWORDS = [
  '新能源',
  '光伏',
  '风电',
  '储能',
  '锂电',
  '半导体',
  '芯片',
  '集成电路',
  '人工智能',
  'AI',
  '机器人',
  '智能制造',
  '高端制造',
  '军工',
  '国防',
  '生物医药',
  '创新药',
  '医疗器械',
  '数字经济',
  '信创',
  '数据中心',
  '新材料',
  '碳纤维',
  '稀土',
  '节能环保',
  '氢能',
  '核电',
];

/** 政策限制/高风险行业关键词 */
const POLICY_RISK_KEYWORDS = [
  '房地产',
  '地产',
  '教培',
  '教育',
  '游戏',
  '电竞',
  '直播',
  '网红',
  '网贷',
  'P2P',
  '小额贷款',
  '电子烟',
  '高耗能',
  '钢铁',
  '煤炭',
];

/**
 * 规则引擎研判（LLM 不可用时降级）
 */
function policyExpertRule(
  financial: FinancialData,
  _valuation: ValuationData,
  info: StockInfo,
): ExpertOpinion {
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];
  const industry = info.industry || '';

  // === 产业政策方向匹配 ===
  const isSupported = POLICY_SUPPORT_KEYWORDS.some((k) => industry.includes(k));
  const isRestricted = POLICY_RISK_KEYWORDS.some((k) => industry.includes(k));

  if (isSupported) {
    arguments_.push({
      text: `${industry}属于国家重点支持产业方向，享受产业政策红利（税收优惠/补贴/采购倾斜），长期成长确定性较高`,
      confidence: 78,
      type: 'support',
      evidenceType: 'inference',
    });
    keyPoints.push(`${industry}属政策支持方向，享受产业红利`);
  } else if (isRestricted) {
    arguments_.push({
      text: `${industry}处于政策管控/限制区间，监管不确定性高，突发政策风险可能导致估值中枢下移`,
      confidence: 82,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`${industry}属政策限制方向，监管风险高`);
  } else {
    arguments_.push({
      text: `${industry}暂无明显政策方向性，政策面影响偏中性，需关注细分领域监管动态`,
      confidence: 60,
      type: 'support',
      evidenceType: 'inference',
    });
    keyPoints.push(`${industry}政策面中性`);
  }

  // === 补贴依赖度评估（无补贴数据时用经营现金流/净利比近似） ===
  const n = financial.years.length;
  if (n >= 1) {
    const latestCashFlowRatio =
      safeDiv(financial.operatingCashFlow[n - 1], financial.netProfit[n - 1]) * 100;
    // 经营现金流远低于净利时，可能存在补贴/非经常性损益支撑
    if (latestCashFlowRatio > 0 && latestCashFlowRatio < 50) {
      arguments_.push({
        text: `经营现金流/净利润仅${(latestCashFlowRatio / 100).toFixed(2)}，盈利可能依赖非经常性损益或政府补助，可持续性存疑`,
        confidence: 72,
        type: 'oppose',
        evidenceType: 'inference',
      });
      keyPoints.push('现金流/净利偏低，补贴依赖风险');
    } else if (latestCashFlowRatio >= 90) {
      arguments_.push({
        text: `经营现金流/净利润达${(latestCashFlowRatio / 100).toFixed(2)}，主营盈利质量高，对补贴依赖度低`,
        confidence: 70,
        type: 'support',
        evidenceType: 'fact',
      });
      keyPoints.push('现金流充裕，补贴依赖度低');
    }
  }

  // === 资本市场政策（基于市值规模判断） ===
  arguments_.push({
    text: '需关注资本市场政策动态：减持新规/再融资政策/行业IPO节奏对供需格局的影响',
    confidence: 55,
    type: 'oppose',
    evidenceType: 'hypothesis',
  });

  // === 综合情绪 ===
  const supportCount = arguments_.filter((a) => a.type === 'support').length;
  const opposeCount = arguments_.filter((a) => a.type === 'oppose').length;
  const totalArgs = arguments_.length || 1;

  let overallSentiment: 'bullish' | 'neutral' | 'bearish';
  if (isRestricted) {
    overallSentiment = 'bearish';
  } else if (isSupported && opposeCount <= 1) {
    overallSentiment = 'bullish';
  } else if (supportCount > opposeCount) {
    overallSentiment = 'neutral';
  } else {
    overallSentiment = 'neutral';
  }

  const avgConfidence = Math.round(
    arguments_.reduce((s, a) => s + a.confidence, 0) / totalArgs,
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
 * 政策分析师
 * LLM 可用时调用 LLM 进行深度研判；不可用或失败时降级规则引擎。
 */
export async function policyExpert(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): Promise<ExpertOpinion> {
  return runExpertWithLLM({
    expertName: EXPERT_NAME,
    systemPrompt: SYSTEM_PROMPT,
    context: formatContext(financial, valuation, info),
    ruleFallback: () => policyExpertRule(financial, valuation, info),
  });
}

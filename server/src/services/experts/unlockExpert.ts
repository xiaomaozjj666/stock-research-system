/**
 * 解禁分析师（A 股特色角色）
 * ----------------------------------------------------------------------------
 * A 股限售股解禁对股价有显著压制效应，本专家专门评估解禁风险：
 *   - 解禁时间窗口（IPO 锁定期：控股东 3 年、战投 1 年、Pre-IPO 1 年）
 *   - 解禁规模/市值比（解禁量占总股本比 → 减持压力）
 *   - 解禁方类型（创投/PE 减持意愿强，实控人减持信号负面）
 *   - 历史解禁后股价表现（解禁前 1 个月跑输概率）
 *
 * 规则降级：按上市年限推断解禁窗口，结合市值估算减持压力，LLM 不可用时给出方向性判断。
 */
import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';
import { runExpertWithLLM } from '../../llm/expertRunner.js';
import { formatContext } from '../../llm/prompts.js';

const EXPERT_NAME = '解禁分析师';

const SYSTEM_PROMPT = `你是资深 A 股解禁压力分析师，专注限售股解禁对股价的冲击评估，拥有 10 年实证研究经验。
分析维度：
- 解禁时间窗口：IPO 锁定期结构（控股股东 36 个月、战略投资者 18 个月、Pre-IPR 12 个月）
- 解禁规模：本次解禁股数/总股本比例，解禁市值/流通市值比例（>10% 视为高压）
- 解禁方类型：创投/PE 机构减持意愿最强（回报退出需求），实控人减持信号最负面（信心不足）
- 历史规律：解禁前 1 个月平均跑输基准 2-3%，解禁后 1 个月逐渐修复
- 减持预案：是否有预披露减持计划，减持节奏与比例
- 对冲因素：是否有回购/增持计划对冲解禁压力
要求：
- 解禁规模 > 流通市值 20% 须标记为"极端高压"
- evidenceType 标注：fact=已公告解禁安排，inference=基于规则的推断，hypothesis=假设性判断
- 区分"解禁高峰已过"与"解禁高峰临近"两种截然不同的风险等级
- overallSentiment 反映解禁压力下的短期股价风险倾向`;

/** 上市年限阈值（年） */
const LISTING_YEAR_THRESHOLDS = {
  firstUnlock: 1,    // 首次解禁窗口（战投/Pre-IPO 到期）
  secondUnlock: 3,   // 二次解禁窗口（控股股东到期）
  mature: 5,         // 解禁基本完毕
};

/**
 * 规则引擎研判（LLM 不可用时降级）
 */
function unlockExpertRule(_financial: FinancialData, valuation: ValuationData, info: StockInfo): ExpertOpinion {
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];

  // === 上市年限 → 解禁窗口推断 ===
  const listingDate = info.listingDate || '';
  let yearsSinceIPO = 0;
  if (listingDate) {
    const listingYear = parseInt(listingDate.slice(0, 4));
    if (!isNaN(listingYear)) {
      yearsSinceIPO = new Date().getFullYear() - listingYear;
    }
  }

  const marketCap = valuation.marketCap || 0;
  let unlockPhase: 'pre_first' | 'first_window' | 'between' | 'second_window' | 'post_mature';

  if (yearsSinceIPO < LISTING_YEAR_THRESHOLDS.firstUnlock) {
    unlockPhase = 'pre_first';
    arguments_.push({
      text: `上市仅${yearsSinceIPO}年，首次解禁窗口（战投/Pre-IPO 12 个月锁定期）尚未到来，需密切关注解禁公告`,
      confidence: 75,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`上市${yearsSinceIPO}年，首次解禁临近`);
  } else if (yearsSinceIPO < LISTING_YEAR_THRESHOLDS.secondUnlock) {
    unlockPhase = 'first_window';
    arguments_.push({
      text: `上市${yearsSinceIPO}年处于首次解禁窗口期，战投/Pre-IPR 股份已解禁，创投/PE 机构减持意愿较强`,
      confidence: 80,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`首次解禁窗口期，创投减持风险`);
  } else if (yearsSinceIPO < LISTING_YEAR_THRESHOLDS.mature) {
    unlockPhase = 'between';
    arguments_.push({
      text: `上市${yearsSinceIPO}年，战投已解禁但控股股东 36 个月锁定期可能刚过，大股东减持解禁压力仍在`,
      confidence: 72,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`控股股东解禁窗口，大股东减持风险`);
  } else {
    unlockPhase = 'post_mature';
    arguments_.push({
      text: `上市${yearsSinceIPO}年，主要限售股解禁期已过，解禁压力大幅缓解，后续解禁风险较低`,
      confidence: 78,
      type: 'support',
      evidenceType: 'inference',
    });
    keyPoints.push(`上市${yearsSinceIPO}年，解禁压力已释放`);
  }

  // === 市值 → 减持绝对规模压力 ===
  if (marketCap > 0) {
    if (marketCap < 100) {
      arguments_.push({
        text: `市值仅${marketCap.toFixed(0)}亿，即便解禁比例不高，绝对减持金额也容易对流动性造成冲击`,
        confidence: 70,
        type: 'oppose',
        evidenceType: 'inference',
      });
      keyPoints.push(`小市值，减持流动性冲击大`);
    } else if (marketCap > 2000) {
      arguments_.push({
        text: `市值${marketCap.toFixed(0)}亿属于大盘股，市场承接力强，解禁减持的流动性冲击相对可控`,
        confidence: 68,
        type: 'support',
        evidenceType: 'fact',
      });
      keyPoints.push(`大盘股，解禁冲击可控`);
    }
  }

  // === 历史解禁效应提示 ===
  if (unlockPhase !== 'post_mature') {
    arguments_.push({
      text: '实证数据显示解禁前 1 个月平均跑输基准 2-3%，若已有解禁公告预披露，需警惕短期价格压力',
      confidence: 65,
      type: 'oppose',
      evidenceType: 'hypothesis',
    });
    keyPoints.push('解禁前1个月大概率跑输');
  }

  // === 对冲因素 ===
  arguments_.push({
    text: '需关注公司是否有回购/增持计划对冲解禁压力，若有则风险等级可下调',
    confidence: 50,
    type: 'support',
    evidenceType: 'hypothesis',
  });

  // === 综合情绪 ===
  const opposeCount = arguments_.filter((a) => a.type === 'oppose').length;
  const supportCount = arguments_.filter((a) => a.type === 'support').length;

  let overallSentiment: 'bullish' | 'neutral' | 'bearish';
  if (unlockPhase === 'post_mature' && supportCount >= opposeCount) {
    overallSentiment = 'neutral';
  } else if (unlockPhase === 'first_window' || unlockPhase === 'pre_first') {
    overallSentiment = 'bearish';
  } else if (opposeCount > supportCount + 1) {
    overallSentiment = 'bearish';
  } else {
    overallSentiment = 'neutral';
  }

  const avgConfidence = Math.round(arguments_.reduce((s, a) => s + a.confidence, 0) / arguments_.length);

  return {
    expert: EXPERT_NAME,
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: keyPoints.slice(0, 6),
  };
}

/**
 * 解禁分析师
 * LLM 可用时调用 LLM 进行深度研判；不可用或失败时降级规则引擎。
 */
export async function unlockExpert(financial: FinancialData, valuation: ValuationData, info: StockInfo): Promise<ExpertOpinion> {
  return runExpertWithLLM({
    expertName: EXPERT_NAME,
    systemPrompt: SYSTEM_PROMPT,
    context: formatContext(financial, valuation, info),
    ruleFallback: () => unlockExpertRule(financial, valuation, info),
  });
}

/**
 * LLM Prompt 工具
 * 把结构化财务/估值数据压缩为 LLM 可读摘要，并定义统一的专家输出 schema。
 */
import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../types.js';

/** 将财务数据格式化为 LLM 易读的多年序列摘要 */
export function formatFinancialBrief(financial: FinancialData): string {
  const n = financial.years.length;
  const latest = (arr: number[]) => arr[n - 1];
  const fmtArr = (arr: number[]) =>
    arr.map((v) => (typeof v === 'number' ? v.toFixed(2) : String(v))).join('、');

  const lines: string[] = [];
  lines.push(`【财务数据（${n}年）】`);
  lines.push(`年份: ${financial.years.join('、')}`);
  lines.push(`营业收入(亿): ${fmtArr(financial.revenue)}`);
  lines.push(`净利润(亿): ${fmtArr(financial.netProfit)}`);
  lines.push(`毛利率(%): ${fmtArr(financial.grossMargin)}`);
  lines.push(`净利率(%): ${fmtArr(financial.netMargin)}`);
  lines.push(`ROE(%): ${fmtArr(financial.roe)}`);
  lines.push(`经营现金流(亿): ${fmtArr(financial.operatingCashFlow)}`);
  lines.push(`EPS(元): ${fmtArr(financial.eps)}`);
  if (financial.equity && financial.equity.length === n)
    lines.push(`净资产(亿): ${fmtArr(financial.equity)}`);
  if (financial.totalAssets && financial.totalAssets.length === n)
    lines.push(`总资产(亿): ${fmtArr(financial.totalAssets)}`);
  if (financial.debtRatio && financial.debtRatio.length === n)
    lines.push(`资产负债率(%): ${fmtArr(financial.debtRatio)}`);
  if (financial.accountsReceivable && financial.accountsReceivable.every((v) => v !== 0)) {
    lines.push(`应收账款(亿): ${fmtArr(financial.accountsReceivable)}`);
  } else {
    lines.push(`应收账款: 数据缺失`);
  }
  if (financial.goodwill && financial.goodwill.some((v) => v !== 0)) {
    lines.push(`商誉(亿): ${fmtArr(financial.goodwill)}`);
  }

  // 增长速算
  if (n >= 2 && financial.revenue[n - 2] !== 0) {
    const revG =
      ((latest(financial.revenue) - financial.revenue[n - 2]) /
        Math.abs(financial.revenue[n - 2])) *
      100;
    const profG =
      financial.netProfit[n - 2] !== 0
        ? ((latest(financial.netProfit) - financial.netProfit[n - 2]) /
            Math.abs(financial.netProfit[n - 2])) *
          100
        : 0;
    lines.push(`最新营收增速: ${revG.toFixed(1)}%`);
    lines.push(`最新净利润增速: ${profG.toFixed(1)}%`);
  }
  return lines.join('\n');
}

/** 估值数据摘要 */
export function formatValuationBrief(valuation: ValuationData): string {
  const lines: string[] = [];
  lines.push(`【估值数据】`);
  lines.push(`当前价格: ¥${valuation.currentPrice.toFixed(2)}`);
  lines.push(`PE: ${valuation.pe}, PB: ${valuation.pb}, PS: ${valuation.ps}`);
  lines.push(`总市值(亿): ${valuation.marketCap.toFixed(0)}`);
  if (valuation.historicalPE.length > 0) {
    const peArr = valuation.historicalPE.map((h) => h.pe);
    lines.push(`历史PE(近${peArr.length}年): ${peArr.join('、')}`);
    const sorted = [...peArr].sort((a, b) => a - b);
    const pct = (sorted.filter((p) => p <= valuation.pe).length / sorted.length) * 100;
    lines.push(`当前PE历史分位: ${pct.toFixed(0)}%`);
  }
  if (valuation.peerComparison.length > 0) {
    const peerAvgPE =
      valuation.peerComparison.reduce((s, p) => s + p.pe, 0) / valuation.peerComparison.length;
    lines.push(
      `同业平均PE: ${peerAvgPE.toFixed(1)}, 同业公司: ${valuation.peerComparison.map((p) => `${p.name}(PE${p.pe})`).join('、')}`,
    );
  }
  return lines.join('\n');
}

/** 股票基本信息摘要 */
export function formatInfoBrief(info: StockInfo): string {
  return `【基本信息】股票: ${info.name}(${info.code}), 行业: ${info.industry}, 市场: ${info.market}`;
}

/** 完整上下文摘要 */
export function formatContext(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): string {
  return [
    formatInfoBrief(info),
    formatFinancialBrief(financial),
    formatValuationBrief(valuation),
  ].join('\n\n');
}

/**
 * 专家输出 JSON schema 说明（所有专家共用）
 * LLM 必须严格返回此结构的 JSON。
 */
export const EXPERT_OUTPUT_SCHEMA = `请严格返回如下 JSON 结构（不要输出任何其他内容）：
{
  "arguments": [
    { "text": "论点描述（一句话）", "confidence": 0到100的整数, "type": "support"或"oppose", "evidenceType": "fact"或"inference"或"hypothesis" }
  ],
  "overallSentiment": "bullish"或"neutral"或"bearish",
  "confidence": 0到100的整数,
  "keyPoints": ["关键要点1", "关键要点2", ...]
}
要求：
- arguments 至少4条、至多8条，support与oppose都要有
- confidence 反映该论点的把握程度
- keyPoints 3-6条，简短
- overallSentiment 综合所有论点判断`;

/** 校验并规范化 LLM 返回的专家意见，确保类型安全 */
export function normalizeExpertOpinion(raw: {
  expert: string;
  arguments?: unknown[];
  overallSentiment?: string;
  confidence?: number;
  keyPoints?: unknown[];
}): ExpertOpinion {
  const validSentiments = ['bullish', 'neutral', 'bearish'] as const;
  const sentiment = validSentiments.includes(
    raw.overallSentiment as (typeof validSentiments)[number],
  )
    ? (raw.overallSentiment as 'bullish' | 'neutral' | 'bearish')
    : 'neutral';

  const validTypes = ['support', 'oppose'] as const;
  const validEvidence = ['fact', 'inference', 'hypothesis'] as const;
  const arguments_ = Array.isArray(raw.arguments)
    ? raw.arguments
        .map((a) => {
          const arg = a as Record<string, unknown>;
          const type = validTypes.includes(arg.type as (typeof validTypes)[number])
            ? (arg.type as 'support' | 'oppose')
            : 'support';
          const evidenceType = validEvidence.includes(
            arg.evidenceType as (typeof validEvidence)[number],
          )
            ? (arg.evidenceType as 'fact' | 'inference' | 'hypothesis')
            : 'inference';
          return {
            text: String(arg.text || ''),
            confidence: clampInt(arg.confidence, 0, 100, 50),
            type,
            evidenceType,
          };
        })
        .filter((a) => a.text.length > 0)
    : [];

  const keyPoints = Array.isArray(raw.keyPoints)
    ? raw.keyPoints.map((p) => String(p)).filter((p) => p.length > 0)
    : [];

  // 确保 support 与 oppose 都存在
  const hasSupport = arguments_.some((a) => a.type === 'support');
  const hasOppose = arguments_.some((a) => a.type === 'oppose');

  return {
    expert: raw.expert,
    arguments: arguments_.slice(0, 8),
    overallSentiment: sentiment,
    confidence: clampInt(raw.confidence, 0, 100, 60),
    keyPoints: keyPoints.slice(0, 6),
    // 若缺 support 或 oppose，标注（不强制补充，由下游处理）
    ...(hasSupport && hasOppose ? {} : { _incomplete: true }),
  } as ExpertOpinion;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

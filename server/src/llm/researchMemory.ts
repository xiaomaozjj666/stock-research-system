/**
 * 研究记忆（Research Memory）
 * ------------------------------------------------------------------
 * 借鉴 QuantDinger 的「分析记忆 + 回顾」：这次研究开始前，先把**同一只股票
 * 过去的分析结论**与**已验证有效的因子**取出来作为先验，避免每次都从零开始、
 * 也避免与上次结论自相矛盾却不自知。
 *
 * 数据来源全部是本地已有资产（historyService 的历史分析 + factorLedger 的
 * 实验台账），不引入新的外部依赖；任何一项缺失都只让记忆变短，不报错。
 */
import { getPreviousAnalysis, listHistory } from '../services/historyService.js';
import { listFactorExperiments } from '../quant/factorLedger.js';

export interface ResearchMemory {
  stockCode: string;
  /** 上一次分析（同股票） */
  previous: { createdAt: string; rating: string; totalScore: number } | null;
  /** 该股票历史分析次数 */
  historyCount: number;
  /** 近期评分序列（由旧到新，最多 5 条） */
  scoreTrend: number[];
  /** 台账中被采信的因子（近 5 条），作为"已验证过什么"的先验 */
  validatedFactors: { name: string; horizon: number; icMean: number }[];
  /** 拼好的一段可注入提示词的中文摘要；无记忆时为 null */
  summary: string | null;
}

export function buildResearchMemory(stockCode: string): ResearchMemory {
  const code = String(stockCode ?? '').trim();
  const previousRaw = code ? getPreviousAnalysis(code) : null;
  const history = code ? listHistory(200) : [];
  const own = history.filter((h) => h.stockCode === code);
  const scoreTrend = own
    .slice(0, 5)
    .map((h) => h.totalScore)
    .reverse();
  const validated = listFactorExperiments({ kept: true, limit: 5 }).map((e) => ({
    name: e.name,
    horizon: e.horizon,
    icMean: e.icMean,
  }));

  const previous = previousRaw
    ? {
        createdAt: previousRaw.createdAt,
        rating: previousRaw.rating,
        totalScore: previousRaw.totalScore,
      }
    : null;

  const parts: string[] = [];
  if (previous) {
    parts.push(
      `上次分析（${previous.createdAt.slice(0, 10)}）评级 ${previous.rating}、总分 ${previous.totalScore}。`,
    );
  }
  if (scoreTrend.length > 1) {
    parts.push(`近 ${scoreTrend.length} 次评分：${scoreTrend.join(' → ')}。`);
  }
  if (validated.length > 0) {
    parts.push(
      `已通过验证的因子：${validated
        .map((f) => `${f.name}(${f.horizon}日 IC ${f.icMean.toFixed(3)})`)
        .join('、')}。`,
    );
  }

  return {
    stockCode: code,
    previous,
    historyCount: own.length,
    scoreTrend,
    validatedFactors: validated,
    summary: parts.length > 0 ? parts.join('') : null,
  };
}

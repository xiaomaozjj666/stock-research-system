/**
 * 文档洞察抽取（研报 / 财报 / 公告）
 * ----------------------------------------------------------------------------
 * 用 LLM 从长文本中抽取结构化要点（LLM 优先 + 词典法兜底），降低幻觉。
 * 这是"PDF 抽取"流水线的价值核心：无论文本来自 PDF 还是用户粘贴，都走同一抽取逻辑。
 */
import { isLLMAvailable, chatJSON, type LLMOptions } from '../llm/index.js';

export interface DocumentInsight {
  summary: string;
  positives: string[];
  risks: string[];
  catalysts: string[];
  confidence: 'high' | 'medium' | 'low';
  source: 'llm' | 'heuristic';
}

const SYSTEM_PROMPT =
  '你是金融文档分析助手。从给定文本中抽取结构化要点，只基于原文、不得编造。' +
  '输出严格 JSON：{summary:string, positives:string[], risks:string[], catalysts:string[], confidence:"high"|"medium"|"low"}。';

function normalizeConfidence(c: unknown): 'high' | 'medium' | 'low' {
  const s = String(c || '').toLowerCase();
  if (s.includes('high') || s.includes('高')) return 'high';
  if (s.includes('low') || s.includes('低')) return 'low';
  return 'medium';
}

/** 词典法兜底：关键词扫描 */
function heuristicInsights(text: string): DocumentInsight {
  const positives: string[] = [];
  const risks: string[] = [];
  const catalysts: string[] = [];
  const posKw = ['增长', '提升', '盈利', '超预期', '扩产', '签约', '中标', '回购', '分红', '利好'];
  const riskKw = ['下滑', '亏损', '减值', '诉讼', '监管', '退市', '质押', '商誉', '风险', '下调'];
  const catKw = ['新品', '发布会', '产能释放', '政策', '订单', '并购', '定增'];
  for (const k of posKw) if (text.includes(k)) positives.push(`提及「${k}」`);
  for (const k of riskKw) if (text.includes(k)) risks.push(`提及「${k}」`);
  for (const k of catKw) if (text.includes(k)) catalysts.push(`提及「${k}」`);
  return {
    summary: text.slice(0, 200),
    positives: positives.slice(0, 5),
    risks: risks.slice(0, 5),
    catalysts: catalysts.slice(0, 5),
    confidence: 'low',
    source: 'heuristic',
  };
}

export async function extractDocumentInsights(
  text: string,
  options: LLMOptions = {},
): Promise<DocumentInsight> {
  const clean = text.slice(0, 6000);
  if (isLLMAvailable()) {
    try {
      const r = await chatJSON<{
        summary: string;
        positives: string[];
        risks: string[];
        catalysts: string[];
        confidence: string;
      }>(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: clean },
        ],
        {
          ...options,
          task: 'extract',
          maxTokens: 1200,
          timeout: 45000,
        },
      );
      return {
        summary: r.summary || clean.slice(0, 200),
        positives: Array.isArray(r.positives) ? r.positives.slice(0, 8) : [],
        risks: Array.isArray(r.risks) ? r.risks.slice(0, 8) : [],
        catalysts: Array.isArray(r.catalysts) ? r.catalysts.slice(0, 8) : [],
        confidence: normalizeConfidence(r.confidence),
        source: 'llm',
      };
    } catch {
      // 落到词典法
    }
  }
  return heuristicInsights(clean);
}

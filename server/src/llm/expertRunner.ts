/**
 * 专家 LLM 运行器
 * 统一封装"LLM 优先 + 规则降级"模式，所有专家共用。
 * LLM 可用时调用 LLM 生成结构化研判；不可用或失败时降级到规则引擎。
 */
import type { ExpertOpinion } from '../types.js';
import { isLLMAvailable, chatJSON, type ChatMessage } from './index.js';
import { normalizeExpertOpinion, EXPERT_OUTPUT_SCHEMA } from './prompts.js';
import logger from '../utils/logger.js';

export interface ExpertRunOptions {
  /** 专家名称（写入 ExpertOpinion.expert） */
  expertName: string;
  /** system prompt：专家人设与分析维度 */
  systemPrompt: string;
  /** user 上下文：格式化后的财务/估值数据 */
  context: string;
  /** 规则引擎 fallback（LLM 不可用或失败时调用） */
  ruleFallback: () => ExpertOpinion;
  /** 采样温度，默认 0.4（兼顾多样性与稳定） */
  temperature?: number;
  /** 最大 token，默认 1500 */
  maxTokens?: number;
}

/** LLM 返回的原始结构 */
interface RawExpertOutput {
  arguments?: unknown[];
  overallSentiment?: string;
  confidence?: number;
  keyPoints?: unknown[];
}

/**
 * 运行专家研判：LLM 优先，规则降级。
 * 始终返回合法 ExpertOpinion，绝不抛错（保证管道稳定）。
 */
export async function runExpertWithLLM(options: ExpertRunOptions): Promise<ExpertOpinion> {
  if (!isLLMAvailable()) {
    return options.ruleFallback();
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: `${options.context}\n\n${EXPERT_OUTPUT_SCHEMA}` },
  ];

  try {
    const raw = await chatJSON<RawExpertOutput>(messages, {
      temperature: options.temperature ?? 0.4,
      maxTokens: options.maxTokens ?? 1500,
      timeout: 45000,
    });
    return normalizeExpertOpinion({ expert: options.expertName, ...raw });
  } catch (err) {
    logger.warn('[LLM] 降级规则引擎', { expertName: options.expertName, err: err as Error });
    return options.ruleFallback();
  }
}

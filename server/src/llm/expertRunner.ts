/**
 * 专家 LLM 运行器
 * 统一封装"LLM 优先 + 规则降级"模式，所有专家共用。
 * LLM 可用时调用 LLM 生成结构化研判；不可用或失败时降级到规则引擎。
 *
 * 降级必须**可被上层看见**：本模块绝不抛错（保证管道稳定），但降级返回的 opinion 会带
 * `_degraded` / `_degradeReason` 标记，报告层据此如实披露"哪些结论出自本地规则引擎"。
 * 否则会出现两个后果：① 排队超时（QueueTimeoutError，429 语义）在专家层被抹平，
 * 路由层再也看不到"系统繁忙"；② 规则引擎结论被当成"专家研判"呈现给用户。
 */
import type { ExpertOpinion, ExpertDegradeReason } from '../types.js';
import { isLLMAvailable, chatJSON, type ChatMessage } from './index.js';
import { normalizeExpertOpinion, EXPERT_OUTPUT_SCHEMA } from './prompts.js';
import { isQueueTimeoutError } from '../utils/limitGate.js';
import logger from '../utils/logger.js';

export type { ExpertDegradeReason };

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
 * 给降级产物打内部标记（不修改传入对象，避免调用方共享的常量被污染）。
 * 字段名沿用本仓库既有约定：下划线前缀表示内部字段（见 prompts.ts 的 `_incomplete`）。
 */
export function markDegraded(opinion: ExpertOpinion, reason: ExpertDegradeReason): ExpertOpinion {
  return { ...opinion, _degraded: true, _degradeReason: reason };
}

/** 该 opinion 是否为规则引擎降级产物 */
export function isDegradedOpinion(opinion: ExpertOpinion): boolean {
  return opinion._degraded === true;
}

/** 取降级原因；非降级产物返回 undefined */
export function getDegradeReason(opinion: ExpertOpinion): ExpertDegradeReason | undefined {
  return opinion._degraded === true ? opinion._degradeReason : undefined;
}

/**
 * 运行专家研判：LLM 优先，规则降级。
 * 始终返回合法 ExpertOpinion，绝不抛错（保证管道稳定）；
 * 降级时返回的 opinion 会带 `_degraded: true` 与 `_degradeReason`，供报告层如实披露。
 */
export async function runExpertWithLLM(options: ExpertRunOptions): Promise<ExpertOpinion> {
  if (!isLLMAvailable()) {
    // 未配置 LLM：确定性降级，标记原因（此前无标记，报告里与 LLM 研判无从分辨）
    return markDegraded(options.ruleFallback(), 'llm_unavailable');
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
    // 排队超时（闸门 429 语义）与"LLM 调用出错"分开标记：
    // 前者是系统繁忙、可退避重试，后者是上游/返回内容的问题，处置方式不同。
    const reason: ExpertDegradeReason = isQueueTimeoutError(err) ? 'queue_timeout' : 'llm_error';
    logger.warn('[LLM] 降级规则引擎', {
      expertName: options.expertName,
      reason,
      err: err as Error,
    });
    return markDegraded(options.ruleFallback(), reason);
  }
}

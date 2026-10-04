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
 * 结构化响应是否「退化」——即 JSON 本身合法，但没有任何可用的研判内容。
 *
 * 为什么需要单独识别：`chatJSON<T>` 的泛型只是编译期断言，运行期并不校验，
 * `JSON.parse` 成功就原样返回。于是模型完全可能回一个合法但空的壳
 * （如 `{"arguments":[],"keyPoints":[]}`，或用 prose 回答导致 extractJSON 只捞到片段）。
 * 这类响应**不会**抛错，原先会一路流进 normalizeExpertOpinion，被补默认值后
 * 变成一条「自信度 60、情绪 neutral、零论点」的伪研判——比明确降级更糟：
 * 用户看到的是一份看起来正常、实则没有内容的专家意见，且报告不会标注降级。
 *
 * 判据取「论点与要点同时为空」：二者任一非空都说明模型确实给出了内容，
 * 交由 normalizeExpertOpinion 做枚举/数值归一即可，不必浪费一次重问。
 */
function isDegenerateResponse(raw: RawExpertOutput | undefined): boolean {
  if (!raw || typeof raw !== 'object') return true;
  const hasArgs =
    Array.isArray(raw.arguments) &&
    raw.arguments.some((a) => {
      const arg = a as Record<string, unknown> | null;
      return arg && typeof arg === 'object' && String(arg.text ?? '').trim().length > 0;
    });
  const hasPoints =
    Array.isArray(raw.keyPoints) && raw.keyPoints.some((p) => String(p ?? '').trim().length > 0);
  return !hasArgs && !hasPoints;
}

/** 构造一次「把问题说清楚再问一遍」的纠正提示（只重问一次，避免无上限烧 token） */
function buildRepairTurn(userContent: string, raw: RawExpertOutput | undefined): ChatMessage {
  return {
    role: 'user',
    content:
      '你上一次的回复无法解析成研判结果：' +
      `实际收到的是 ${JSON.stringify(raw ?? null).slice(0, 500)}\n` +
      '请重新只输出符合下列结构的 JSON，不要输出任何解释文字、Markdown 代码块或额外字段：\n' +
      EXPERT_OUTPUT_SCHEMA +
      `\n（原始任务上下文重申：${userContent.slice(0, 400)}）`,
  };
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

  const callOptions = {
    temperature: options.temperature ?? 0.4,
    maxTokens: options.maxTokens ?? 1500,
    timeout: 45000,
  };

  try {
    let raw = await chatJSON<RawExpertOutput>(messages, callOptions);

    // 结构合法但内容为空的重问回路：只补一次，且把失败原因与原文回灌给模型，
    // 让它带着「上次哪里不对」重新作答。第二次仍退化就走原有降级路径，
    // 行为与修复前一致（不会因为多问一次而变得更糟）。
    if (isDegenerateResponse(raw)) {
      logger.warn('[LLM] 结构化响应为空，重问一次', { expertName: options.expertName });
      const repairMessages: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(raw ?? null).slice(0, 1000) },
        buildRepairTurn(`${options.context}\n\n${EXPERT_OUTPUT_SCHEMA}`, raw),
      ];
      try {
        const retried = await chatJSON<RawExpertOutput>(repairMessages, callOptions);
        if (!isDegenerateResponse(retried)) {
          logger.info('[LLM] 重问后取得有效研判', { expertName: options.expertName });
          raw = retried;
        } else {
          logger.warn('[LLM] 重问后仍为空，按降级处理', { expertName: options.expertName });
        }
      } catch (retryErr) {
        // 重问本身失败（网络/闸门）不影响首轮结果的处理，落到下面的降级
        logger.warn('[LLM] 重问失败', { expertName: options.expertName, err: retryErr as Error });
      }
    }

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

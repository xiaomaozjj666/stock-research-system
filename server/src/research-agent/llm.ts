/**
 * LLM 适配器与结构化输出门禁
 * ------------------------------------------------------------------
 * 规划层不绑定任何模型供应商：编排器只依赖 LLMAdapter 接口，
 * 生产环境注入 OpenAI 兼容客户端，测试注入脚本化 Fake。
 *
 * completeJson 是各阶段消费 LLM 的唯一通道：
 *   调用 -> 宽松解析 -> Schema 校验 ->（不合规则带错误反馈重试）
 * 由此落实「LLM 输出不合规 -> 修复重试」的异常处理策略。
 */
import type { MiniSchema } from './utils.js';
import { parseJsonLoose, validateSchema } from './utils.js';

export interface LLMRequest {
  system?: string;
  prompt: string;
  temperature?: number;
}

export interface LLMAdapter {
  readonly name: string;
  complete(req: LLMRequest): Promise<string>;
}

export class LLMOutputError extends Error {
  constructor(
    message: string,
    public readonly attempts: string[],
  ) {
    super(message);
    this.name = 'LLMOutputError';
  }
}

export interface CompleteJsonOptions {
  system?: string;
  prompt: string;
  schema: MiniSchema;
  /** 用于事件日志与错误信息 */
  label: string;
  /** 不合规重试次数上限（不含首次），默认 2 */
  maxRetries?: number;
}

/**
 * 调用 LLM 并强制返回通过 Schema 校验的结构化结果。
 * 每次校验失败会把错误清单反馈进提示词，引导模型自我修复。
 */
export async function completeJson<T>(llm: LLMAdapter, opts: CompleteJsonOptions): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const attempts: string[] = [];
  let prompt = opts.prompt;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await llm.complete({
      system: opts.system,
      prompt,
      temperature: attempt === 0 ? 0.2 : 0,
    });
    try {
      const value = parseJsonLoose(raw);
      const errors = validateSchema(value, opts.schema);
      if (errors.length === 0) {
        return value as T;
      }
      attempts.push(`第 ${attempt + 1} 次输出 Schema 校验失败: ${errors.join('; ')}`);
    } catch (err) {
      attempts.push(`第 ${attempt + 1} 次输出无法解析为 JSON: ${(err as Error).message}`);
    }
    prompt =
      `${opts.prompt}\n\n【重要】你上一次的输出不合规，请修正后重新只输出 JSON：\n` +
      attempts[attempts.length - 1];
  }
  throw new LLMOutputError(`LLM 多次输出均不合规（${opts.label}）`, attempts);
}

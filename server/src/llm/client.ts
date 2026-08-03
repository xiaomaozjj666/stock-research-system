/**
 * LLM 客户端
 * 支持 DeepSeek / OpenAI 兼容接口，提供非流式、流式、JSON 结构化输出三种调用方式。
 */
import {
  getLLMConfig,
  isLLMAvailable,
  selectModel,
  modelSpec,
  getEmbedModel,
  getEmbedBaseUrl,
  isEmbeddingConfigured,
  type LLMTask,
} from './config.js';
import { recordUsage } from './cost.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 助手消息携带的工具调用（function-calling 回灌时必须保留） */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /** 工具结果消息必须回指对应的 tool_call_id */
  tool_call_id?: string;
  /** 工具结果消息对应的函数名 */
  name?: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  /** 单次请求超时（毫秒），默认 60s */
  timeout?: number;
  /** 显式指定模型（覆盖按任务路由的选择） */
  model?: string;
  /** 任务标签，用于多模型路由（chat/analysis/debate/extract/reasoning/embedding） */
  task?: LLMTask;
}

/**
 * 非流式对话，返回完整文本
 */
export async function chat(messages: ChatMessage[], options: LLMOptions = {}): Promise<string> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，请设置 DEEPSEEK_API_KEY');
  const config = getLLMConfig();
  const model = options.model ?? selectModel(options.task ?? 'chat');
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 2048,
    stream: false,
  };
  if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 60000);
  // 若外部传入 signal，联动取消
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${response.status}): ${errText.slice(0, 300)}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    recordUsageFromResponse(model, data, options.task);
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式对话，逐 token 通过 onToken 回调推送，同时返回完整文本
 */
export async function chatStream(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  options: LLMOptions = {}
): Promise<string> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，请设置 DEEPSEEK_API_KEY');
  const config = getLLMConfig();
  const model = options.model ?? selectModel(options.task ?? 'chat');
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 2048,
    stream: true,
  };
  if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`LLM 流式请求失败 (${response.status}): ${errText.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const token = json.choices?.[0]?.delta?.content || '';
        if (token) {
          full += token;
          onToken(token);
        }
      } catch {
        // 忽略心跳/不完整行
      }
    }
  }
  return full;
}

/**
 * 调用 LLM 获取 JSON 对象。
 * 自动剥离 ```json``` 代码块包裹，解析失败时抛出带原文的错误。
 */
export async function chatJSON<T>(messages: ChatMessage[], options: LLMOptions = {}): Promise<T> {
  const content = await chat(messages, { ...options, jsonMode: true });
  const jsonStr = extractJSON(content);
  try {
    return JSON.parse(jsonStr) as T;
  } catch (err) {
    throw new Error(`LLM JSON 解析失败: ${(err as Error).message}\n原文: ${content.slice(0, 500)}`);
  }
}

/**
 * 函数调用（function-calling）对话。
 * 传入工具定义与一个执行回调；模型若返回 tool_calls，则执行并把结果回灌，循环最多 5 轮，
 * 直到模型给出最终文本。返回最终回答与本次用到的工具调用。
 * 注意：带 tools 时不允许同时设置 response_format=json_object（OpenAI 限制），故此处不启用 jsonMode。
 */
export interface ToolCallResult {
  name: string;
  args: Record<string, unknown>;
}
export async function chatWithTools(
  messages: ChatMessage[],
  tools: unknown[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  options: LLMOptions = {},
): Promise<{ content: string; toolCalls: ToolCallResult[] }> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，请设置 DEEPSEEK_API_KEY');
  const config = getLLMConfig();
  const model = options.model ?? selectModel(options.task ?? 'analysis');
  const conv: ChatMessage[] = messages.map((m) => ({ ...m }));
  const used: ToolCallResult[] = [];

  for (let iter = 0; iter < 5; iter++) {
    const body: Record<string, unknown> = {
      model,
      messages: conv,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 1500,
      stream: false,
      tools,
      tool_choice: 'auto',
    };

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM 工具调用失败 (${response.status}): ${errText.slice(0, 300)}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    recordUsageFromResponse(model, data, options.task);
    const msg = data.choices?.[0]?.message;
    if (!msg) return { content: '', toolCalls: used };

    // 把助手消息（含 tool_calls）原样回灌，保持对话结构
    // 注意：带 tool_calls 的助手消息必须保留 tool_calls 字段（含 type:'function'），
    // 否则下一轮请求里工具结果消息无法与助手调用对应，API 会报 missing field `tool_call_id`。
    const assistantToolCalls = (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    conv.push({ role: 'assistant', content: msg.content || '', tool_calls: assistantToolCalls });

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(tc.function.arguments || '{}'); } catch { parsed = {}; }
        used.push({ name: tc.function.name, args: parsed });
        let result: string;
        try {
          result = await executeTool(tc.function.name, parsed);
        } catch (err) {
          result = `工具执行出错: ${(err as Error).message}`;
        }
        // 工具结果消息必须回指 tool_call_id 并带上函数名
        conv.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }
      continue; // 让模型基于工具结果继续
    }
    return { content: msg.content || '', toolCalls: used };
  }
  return { content: conv[conv.length - 1]?.content || '', toolCalls: used };
}

/**
 * 生成文本嵌入向量（OpenAI 兼容 /embeddings）。
 * 用于轻量向量检索；嵌入端点不可用时抛出错误，调用方应回退 BM25。
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，无法生成嵌入');
  // 未显式配置嵌入能力（如仅配了 DeepSeek 文本模型）→ 直接返回空，由检索层回退 BM25
  if (!isEmbeddingConfigured()) return [];
  if (texts.length === 0) return [];
  const config = getLLMConfig();
  const body = { model: getEmbedModel(), input: texts };
  const response = await fetch(`${getEmbedBaseUrl()}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`LLM 嵌入失败 (${response.status}): ${errText.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    data?: { embedding: number[] }[];
  };
  if (!data.data || data.data.length !== texts.length) {
    throw new Error('LLM 嵌入返回数量与输入不一致');
  }
  // 估算嵌入 token 成本（约 4 字符/token），仅作成本治理参考
  const approxTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
  recordUsage(getEmbedModel(), approxTokens, 0, { task: 'embedding' });
  return data.data.map((d) => d.embedding);
}

/** 从响应 usage 记录成本（无 usage 或未知模型时安全跳过） */
function recordUsageFromResponse(
  model: string,
  data: { usage?: { prompt_tokens?: number; completion_tokens?: number } },
  task?: LLMTask,
): void {
  const usage = data.usage;
  if (!usage) return;
  const spec = modelSpec(model);
  const cost =
    ((usage.prompt_tokens ?? 0) / 1000) * spec.costPer1kInput +
    ((usage.completion_tokens ?? 0) / 1000) * spec.costPer1kOutput;
  recordUsage(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, { cost, task });
}

/** 从可能被 markdown 包裹的文本中提取 JSON */
function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return text.trim();
  return text.slice(start).trim();
}

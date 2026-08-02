/**
 * LLM 客户端
 * 支持 DeepSeek / OpenAI 兼容接口，提供非流式、流式、JSON 结构化输出三种调用方式。
 */
import { getLLMConfig, isLLMAvailable } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  /** 单次请求超时（毫秒），默认 60s */
  timeout?: number;
}

/**
 * 非流式对话，返回完整文本
 */
export async function chat(messages: ChatMessage[], options: LLMOptions = {}): Promise<string> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，请设置 DEEPSEEK_API_KEY');
  const config = getLLMConfig();
  const body: Record<string, unknown> = {
    model: config.model,
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
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
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
  const body: Record<string, unknown> = {
    model: config.model,
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

/** 从可能被 markdown 包裹的文本中提取 JSON */
function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return text.trim();
  return text.slice(start).trim();
}

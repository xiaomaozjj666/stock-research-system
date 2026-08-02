/**
 * LLM 配置
 * 通过环境变量配置，兼容 DeepSeek 与任意 OpenAI 兼容接口。
 * 未配置 API key 时 isLLMAvailable() 返回 false，专家自动降级到规则引擎。
 */
export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function getLLMConfig(): LLMConfig {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat',
  };
}

/** LLM 是否可用（已配置 API key） */
export function isLLMAvailable(): boolean {
  return getLLMConfig().apiKey.length > 0;
}

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getLLMConfig, isLLMAvailable } from '../config.js';

describe('llm/config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('未配置 key 时返回默认值且不可用', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const cfg = getLLMConfig();
    expect(cfg.apiKey).toBe('');
    expect(cfg.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(cfg.model).toBe('deepseek-chat');
    expect(isLLMAvailable()).toBe(false);
  });

  it('读取 DEEPSEEK_API_KEY 并判定可用', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test-123');
    expect(getLLMConfig().apiKey).toBe('sk-test-123');
    expect(isLLMAvailable()).toBe(true);
  });

  it('OPENAI 变量作为回退', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1');
    vi.stubEnv('OPENAI_MODEL', 'gpt-4o');
    const cfg = getLLMConfig();
    expect(cfg.apiKey).toBe('sk-openai');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.model).toBe('gpt-4o');
  });

  it('baseUrl 末尾斜杠被去除', () => {
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1///');
    expect(getLLMConfig().baseUrl).toBe('https://api.deepseek.com/v1');
  });
});

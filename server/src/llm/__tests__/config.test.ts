// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isEmbeddingConfigured, getEmbedBaseUrl } from '../config.js';

const ENV_KEYS = [
  'LLM_EMBED_MODEL',
  'OPENAI_EMBED_MODEL',
  'LLM_EMBED_BASE_URL',
  'OPENAI_EMBED_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'OPENAI_BASE_URL',
] as const;

// beforeEach 快照 + afterEach 恢复：此前只 delete 不恢复，会污染宿主环境变量
// （宿主若已设 LLM_EMBED_MODEL，首用例"默认 false"会环境相关失败）
const originalEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe('isEmbeddingConfigured', () => {
  it('默认（仅文本模型）为 false', () => {
    expect(isEmbeddingConfigured()).toBe(false);
  });
  it('设置 LLM_EMBED_MODEL 后为 true', () => {
    process.env.LLM_EMBED_MODEL = 'text-embedding-3-small';
    expect(isEmbeddingConfigured()).toBe(true);
  });
  it('设置独立嵌入端点 LLM_EMBED_BASE_URL 后为 true', () => {
    process.env.LLM_EMBED_BASE_URL = 'https://embed.example.com/v1';
    expect(isEmbeddingConfigured()).toBe(true);
  });
});

describe('getEmbedBaseUrl', () => {
  it('未设置时回退主模型 baseUrl', () => {
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
    expect(getEmbedBaseUrl()).toBe('https://api.deepseek.com/v1');
  });
  it('优先使用独立嵌入端点并去掉尾斜杠', () => {
    process.env.LLM_EMBED_BASE_URL = 'https://embed.example.com/v1/';
    expect(getEmbedBaseUrl()).toBe('https://embed.example.com/v1');
  });
});

// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { isEmbeddingConfigured, getEmbedBaseUrl } from '../config.js';

afterEach(() => {
  delete process.env.LLM_EMBED_MODEL;
  delete process.env.OPENAI_EMBED_MODEL;
  delete process.env.LLM_EMBED_BASE_URL;
  delete process.env.OPENAI_EMBED_BASE_URL;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadEnv, getEnv, _resetEnvCache } from '../env.js';
import { setLogLevel } from '../logger.js';

describe('env 环境变量校验', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    _resetEnvCache();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetEnvCache();
  });

  it('开发环境零配置即可启动，使用默认值', () => {
    delete process.env.PORT;
    delete process.env.NODE_ENV;

    const env = loadEnv();

    expect(env.nodeEnv).toBe('development');
    expect(env.port).toBe(3001);
    expect(env.cacheTtlHours).toBe(24);
    expect(env.rateLimitWindowMs).toBe(60000);
    expect(env.allowedOrigins).toBeNull();
  });

  it('test 环境使用默认值', () => {
    process.env.NODE_ENV = 'test';

    const env = loadEnv();

    expect(env.nodeEnv).toBe('test');
    expect(env.port).toBe(3001);
  });

  it('自定义 PORT 正常解析', () => {
    process.env.PORT = '8080';

    const env = loadEnv();

    expect(env.port).toBe(8080);
  });

  it('PORT 非整数时抛出错误', () => {
    process.env.PORT = 'abc';

    expect(() => loadEnv()).toThrow('PORT 必须是 1-65535 的整数');
  });

  it('PORT 超出范围时抛出错误', () => {
    process.env.PORT = '99999';

    expect(() => loadEnv()).toThrow('PORT 必须是 1-65535 的整数');
  });

  it('PORT 为 0 时抛出错误', () => {
    process.env.PORT = '0';

    expect(() => loadEnv()).toThrow('PORT 必须是 1-65535 的整数');
  });

  it('ALLOWED_ORIGINS 解析为数组', () => {
    process.env.ALLOWED_ORIGINS = 'https://example.com, https://app.example.com';

    const env = loadEnv();

    expect(env.allowedOrigins).toEqual(['https://example.com', 'https://app.example.com']);
  });

  it('ALLOWED_ORIGINS 空字符串时为 null', () => {
    process.env.ALLOWED_ORIGINS = '   ';

    const env = loadEnv();

    expect(env.allowedOrigins).toBeNull();
  });

  it('CACHE_TTL_HOURS 自定义值', () => {
    process.env.CACHE_TTL_HOURS = '48';

    const env = loadEnv();

    expect(env.cacheTtlHours).toBe(48);
  });

  it('CACHE_TTL_HOURS 为 0 时抛出错误', () => {
    process.env.CACHE_TTL_HOURS = '0';

    expect(() => loadEnv()).toThrow('CACHE_TTL_HOURS 必须大于 0');
  });

  it('ENABLE_HSTS 默认关闭', () => {
    const env = loadEnv();

    expect(env.enableHsts).toBe(false);
  });

  it('ENABLE_HSTS=true 时启用', () => {
    process.env.ENABLE_HSTS = 'true';

    const env = loadEnv();

    expect(env.enableHsts).toBe(true);
  });

  it('LLM API Key 从 DEEPSEEK_API_KEY 读取', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-123';

    const env = loadEnv();

    expect(env.llm.apiKey).toBe('sk-deepseek-123');
  });

  it('LLM API Key 优先 DEEPSEEK，回退 OPENAI', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-123';
    process.env.OPENAI_API_KEY = 'sk-openai-456';

    const env = loadEnv();

    expect(env.llm.apiKey).toBe('sk-deepseek-123');
  });

  it('LLM API Key 未配置时为 undefined', () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const env = loadEnv();

    expect(env.llm.apiKey).toBeUndefined();
  });

  it('LLM baseUrl 和 model 可配置', () => {
    process.env.LLM_BASE_URL = 'https://api.example.com';
    process.env.LLM_MODEL = 'gpt-4';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const env = loadEnv();

    expect(env.llm.baseUrl).toBe('https://api.example.com');
    expect(env.llm.model).toBe('gpt-4');
    expect(env.llm.embeddingModel).toBe('text-embedding-3-small');
  });

  it('东方财富搜索 Token 有默认值', () => {
    const env = loadEnv();

    expect(env.eastmoneySearchToken).toBeTruthy();
    expect(typeof env.eastmoneySearchToken).toBe('string');
  });

  it('东方财富搜索 Token 可配置', () => {
    process.env.EASTMONEY_SEARCH_TOKEN = 'custom-token-123';

    const env = loadEnv();

    expect(env.eastmoneySearchToken).toBe('custom-token-123');
  });

  it('getEnv 在未初始化时返回 null', () => {
    expect(getEnv()).toBeNull();
  });

  it('getEnv 在初始化后返回配置', () => {
    loadEnv();

    const env = getEnv();

    expect(env).not.toBeNull();
    expect(env?.port).toBe(3001);
  });

  it('多次调用 loadEnv 返回缓存的同一对象', () => {
    const env1 = loadEnv();
    const env2 = loadEnv();

    expect(env1).toBe(env2);
  });

  it('生产环境缺少 ALLOWED_ORIGINS 时给出警告但不崩溃', () => {
    // 全局测试 setup 会把日志级别静音到 error；本用例断言 warn 输出，需显式恢复（仅放行 warn，info 仍过滤）
    setLogLevel('warn');
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOWED_ORIGINS;

    // loadEnv 的警告现经结构化 logger（logger.warn → process.stdout.write）输出，原 console.warn
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const env = loadEnv();

      expect(env.nodeEnv).toBe('production');
      expect(env.allowedOrigins).toBeNull();
      const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('"level":"warn"');
      expect(output).toContain('生产环境未设置 ALLOWED_ORIGINS');
    } finally {
      // 断言失败也要恢复 spy，避免残留吞掉后续用例的 stdout
      writeSpy.mockRestore();
    }
  });

  it('生产环境配置 ALLOWED_ORIGINS 时正常', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';

    const env = loadEnv();

    expect(env.allowedOrigins).toEqual(['https://app.example.com']);
  });
});

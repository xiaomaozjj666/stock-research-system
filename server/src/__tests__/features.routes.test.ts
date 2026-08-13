import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';

// 隔离真实 LLM 与网络依赖
vi.mock('../services/chatAgent.js', () => ({
  chatAgent: {
    run: vi.fn(async () => ({ answer: 'ok', toolsUsed: [], evidence: [], degraded: false })),
  },
}));
vi.mock('../services/watchlistBacktest.js', () => ({
  runWatchlistNewsBacktest: vi.fn(async (codes: string[]) => ({
    generatedAt: new Date().toISOString(),
    count: codes.length,
    withNewsCount: 0,
    results: codes.map((c) => ({
      code: c,
      name: null,
      newsSentiment: { polarity: 0.9, weightedImpact: 0.7, hasNews: true },
    })),
  })),
}));

// 必须在 mock 之后导入 app
import { app } from '../index.js';

// 确保测试环境不走真实 LLM（避免网络/长连接导致 vitest 无法干净退出）
const origDeepSeekKey = process.env.DEEPSEEK_API_KEY;
const origOpenaiKey = process.env.OPENAI_API_KEY;
beforeAll(() => {
  process.env.DEEPSEEK_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
});
afterAll(() => {
  if (origDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = origDeepSeekKey;
  if (origOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = origOpenaiKey;
});

// embeddingEnabled 用例依赖"宿主未配置任何嵌入类 env"：统一清空，避免开发者环境导出
// LLM_EMBED_MODEL/OPENAI_EMBED_MODEL 等导致首用例环境相关失败
beforeEach(() => {
  delete process.env.LLM_EMBED_MODEL;
  delete process.env.OPENAI_EMBED_MODEL;
  delete process.env.LLM_EMBED_BASE_URL;
  delete process.env.OPENAI_EMBED_BASE_URL;
});

describe('文档入库与 RAG', () => {
  it('POST /api/ingest 解析文本并入库', async () => {
    const r = await request(app)
      .post('/api/ingest')
      .send({ title: '测试研报', text: '公司营收增长，但面临监管风险' });
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(true);
    expect(r.body.insight.source).toBe('heuristic'); // 测试环境无 LLM key
  });

  it('缺少 title 返回 400', async () => {
    const r = await request(app).post('/api/ingest').send({ text: 'x' });
    expect(r.status).toBe(400);
  });

  it('GET /api/documents 返回已入库列表', async () => {
    await request(app).post('/api/ingest').send({ title: 'd2', text: '新能源 扩产' });
    const r = await request(app).get('/api/documents');
    expect(r.status).toBe(200);
    // 精确断言 d2 真正入库（count>0 过弱：前一用例已入库一条，POST 静默失败也会过）
    expect(r.body.docs.some((d: { source: string }) => d.source === 'doc:d2')).toBe(true);
  });
});

describe('多模型路由 / 成本治理', () => {
  it('GET /api/models 返回注册表与路由', async () => {
    const r = await request(app).get('/api/models');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.registry)).toBe(true);
    expect(r.body.routing).toHaveProperty('chat');
    // 未配置嵌入模型（如仅 DeepSeek 文本模型）时 embeddingEnabled 应为 false
    expect(r.body.embeddingEnabled).toBe(false);
  });

  it('配置 LLM_EMBED_MODEL 后 embeddingEnabled 为 true', async () => {
    process.env.LLM_EMBED_MODEL = 'text-embedding-3-small';
    try {
      const r = await request(app).get('/api/models');
      expect(r.body.embeddingEnabled).toBe(true);
    } finally {
      // 断言失败也要还原，避免 env 泄漏影响后续用例
      delete process.env.LLM_EMBED_MODEL;
    }
  });

  it('GET /api/cost 返回成本报告', async () => {
    const r = await request(app).get('/api/cost');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('callCount');
  });
});

describe('autonomous 长程循环', () => {
  it('start / status / stop 生命周期', async () => {
    const start = await request(app).post('/api/autonomous/start').send({ intervalMs: 1000 });
    expect(start.status).toBe(200);
    expect(start.body.running).toBe(true);

    const status = await request(app).get('/api/autonomous/status');
    expect(status.body.running).toBe(true);

    const stop = await request(app).post('/api/autonomous/stop');
    expect(stop.status).toBe(200);
    expect(stop.body.stopped).toBe(true);
  });
});

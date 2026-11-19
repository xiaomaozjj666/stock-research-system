import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 限流器在 middleware.ts 模块加载时就固定了 max，必须早于 import 设置环境变量，
// 否则本文件十余个用例会撞上默认的 10 次/分钟限流，把断言变成 429。
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX_ANALYZE = '200';
});

import { app as rawApp } from '../index.js';
import { saveResearchRun } from '../services/researchLibrary.js';
import { makeRunResult } from '../test/researchFixture.js';
import { withContract } from '../test/contractSupertest.js';

/**
 * /api/research/deep 的入参护栏
 * ----------------------------------------------------------------------------
 * 深度研究一次会扇出数十次 LLM 调用，参数校验是成本控制的第一道闸门：
 * 问题过短（模型无从下手）、轮次过大（成本爆炸）都必须在进编排器之前拒掉。
 *
 * 这些用例不需要任何 LLM 与网络：非法入参走 400，合法入参在本测试环境下
 * （无 API key）走 503。两者都不会真正发起研究。
 */

const app = withContract(rawApp);

beforeEach(() => {
  // 确保走"未配置 LLM"分支，令合法入参稳定返回 503 而不是真的去跑研究
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

describe('POST /api/research/deep 入参校验', () => {
  it('缺少问题时返回 400', async () => {
    const res = await request(app).post('/api/research/deep').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('请提供研究问题');
  });

  it('问题过短时返回 400', async () => {
    const res = await request(app).post('/api/research/deep').send({ question: '白酒' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('过短');
  });

  it('问题超长时返回 400', async () => {
    const res = await request(app)
      .post('/api/research/deep')
      .send({ question: '白'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('过长');
  });

  it('轮次越界时返回 400（不静默夹紧，否则用户会以为参数已生效）', async () => {
    const res = await request(app)
      .post('/api/research/deep')
      .send({ question: '白酒行业竞争格局', config: { maxRounds: 9 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('研究参数非法');
  });

  it('子问题数越界时返回 400', async () => {
    const res = await request(app)
      .post('/api/research/deep')
      .send({ question: '白酒行业竞争格局', config: { maxSubQuestions: 1 } });
    expect(res.status).toBe(400);
  });

  it('附加要求超过 5 条时返回 400', async () => {
    const res = await request(app)
      .post('/api/research/deep')
      .send({
        question: '白酒行业竞争格局',
        scope: { extraRequirements: ['1', '2', '3', '4', '5', '6'] },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('研究范围参数非法');
  });

  it('scope 不是对象时返回 400', async () => {
    const res = await request(app)
      .post('/api/research/deep')
      .send({ question: '白酒行业竞争格局', scope: 'industry=白酒' });
    expect(res.status).toBe(400);
  });

  it('合法入参在未配置 LLM 时返回 503 并说明原因', async () => {
    const res = await request(app)
      .post('/api/research/deep')
      .send({ question: '白酒行业竞争格局与主要风险' });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('深度研究依赖 LLM');
  });
});

describe('GET /api/research/deep/stream 入参校验', () => {
  it('缺少 question 时返回 400', async () => {
    const res = await request(app).get('/api/research/deep/stream');
    expect(res.status).toBe(400);
  });

  it('重复 query 参数（数组形态）显式 400，不静默当未传', async () => {
    const res = await request(app).get(
      '/api/research/deep/stream?question=白酒行业竞争格局&scope=a&scope=b',
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('JSON');
  });

  it('config 不是合法 JSON 时返回 400', async () => {
    const res = await request(app)
      .get('/api/research/deep/stream')
      .query({ question: '白酒行业竞争格局', config: '{bad json' });
    expect(res.status).toBe(400);
  });

  it('合法入参在未配置 LLM 时返回 503', async () => {
    const res = await request(app)
      .get('/api/research/deep/stream')
      .query({ question: '白酒行业竞争格局与主要风险' });
    expect(res.status).toBe(503);
  });
});

describe('研究库接口（/api/research/runs）', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-research-runs-route-'));
    process.env.RESEARCH_LIBRARY_DIR = dir;
  });

  afterEach(() => {
    delete process.env.RESEARCH_LIBRARY_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('空库返回空列表', async () => {
    const res = await request(app).get('/api/research/runs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('列表返回摘要，且按 id 能取到完整结果', async () => {
    const saved = saveResearchRun({
      question: '白酒行业竞争格局',
      scope: { industry: '白酒' },
      result: makeRunResult(),
    })!;

    const list = await request(app).get('/api/research/runs');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(saved.id);
    expect(list.body.items[0].question).toBe('白酒行业竞争格局');

    const detail = await request(app).get(`/api/research/runs/${saved.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(saved.id);
    expect(detail.body.scope).toEqual({ industry: '白酒' });
    expect(detail.body.result.report.title).toBe('白酒行业竞争格局研究');
  });

  it('limit 越界返回 400', async () => {
    const res = await request(app).get('/api/research/runs').query({ limit: 0 });
    expect(res.status).toBe(400);
  });

  it('不存在的 id 返回 404', async () => {
    const res = await request(app).get('/api/research/runs/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('删除后再次读取返回 404', async () => {
    const saved = saveResearchRun({ question: '问题一', scope: {}, result: makeRunResult() })!;
    const del = await request(app).delete(`/api/research/runs/${saved.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const detail = await request(app).get(`/api/research/runs/${saved.id}`);
    expect(detail.status).toBe(404);
  });
});

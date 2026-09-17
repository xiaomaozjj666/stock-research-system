/**
 * ============================================================================
 * /api/analyze 与 /api/analyze/stream 的「在途分析语义冲突」契约测试。
 *
 * 缺陷背景：single-flight 只按 stockCode 去重，`{resume:true}` 在途时另一个
 * `{resume:false}` 的请求会**静默复用**续跑结果——调用方以为是自己要的全新分析，
 * 实际数据可能来自过期断点。流水线侧已改为显式拒绝（ANALYSIS_IN_FLIGHT），
 * 本文件钉住路由侧的映射：POST → 409 + 可读中文；SSE → error 事件带 code + 同一文案。
 *
 * 隔离：analysisPipeline 以 importActual 部分打桩（保留 ANALYSIS_IN_FLIGHT 常量，
 * 它是本契约的稳定标识），不触发任何真实 LLM / 行情调用。错误码常量从 routes/analysis.js
 * 取（与流水线同值）——避免对被打桩模块做具名导入。
 * ============================================================================
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { runAnalysisMock } = vi.hoisted(() => ({ runAnalysisMock: vi.fn() }));

vi.mock('../services/analysisPipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/analysisPipeline.js')>();
  return { ...actual, runAnalysis: runAnalysisMock };
});

import { app } from '../index.js';
import { ANALYSIS_IN_FLIGHT } from '../routes/analysis.js';

const sampleResult = {
  stock_pool: [
    { stock_code: '600519', stock_name: '贵州茅台', rating: '持续观察', total_score: 70 },
  ],
} as never;

/** 与流水线抛出的错误同构：code + message（生产环境 SSE 只回 message） */
function inFlightError(): Error {
  const err = new Error(`该标的已有一次分析在进行中，请稍后重试（${ANALYSIS_IN_FLIGHT}）`);
  (err as Error & { code?: string }).code = ANALYSIS_IN_FLIGHT;
  return err;
}

/** 从 SSE 文本里取出最后一个事件的数据体 */
function lastSseEvent(text: string): Record<string, unknown> {
  const chunks = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  return JSON.parse(chunks[chunks.length - 1]) as Record<string, unknown>;
}

beforeEach(() => {
  runAnalysisMock.mockReset();
});

describe('POST /api/analyze — 在途轮次语义冲突', () => {
  it('runAnalysis 抛 ANALYSIS_IN_FLIGHT → 409 + 可读中文（而不是 500/静默复用）', async () => {
    runAnalysisMock.mockImplementation(() => {
      throw inFlightError();
    });

    const res = await request(app).post('/api/analyze').send({ stockCode: '600519' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('该标的已有一次分析在进行中，请稍后重试');
    expect(res.body.code).toBe(ANALYSIS_IN_FLIGHT);
    // 冲突请求不得拿到任何分析结果
    expect(res.body.stock_pool).toBeUndefined();
  });

  it('正常路径不受影响：resume 一致时照常 200', async () => {
    runAnalysisMock.mockResolvedValue(sampleResult);

    const res = await request(app).post('/api/analyze').send({ stockCode: '600519' });

    expect(res.status).toBe(200);
    expect(runAnalysisMock.mock.calls[0][2]).toEqual({ resume: false });
  });

  it('与其他失败区分：非冲突错误仍回 500', async () => {
    runAnalysisMock.mockRejectedValue(new Error('专家研判全部失败'));

    const res = await request(app).post('/api/analyze').send({ stockCode: '600519' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('分析过程出错');
  });
});

describe('GET /api/analyze/stream — 在途轮次语义冲突', () => {
  it('冲突 → error 事件带 code 与同一句中文，前端仍可读', async () => {
    runAnalysisMock.mockImplementation(() => {
      throw inFlightError();
    });

    const res = await request(app).get('/api/analyze/stream').query({ stockCode: '600519' });

    // SSE 已 flushHeaders：状态码固定 200，语义由 error 事件承载
    expect(res.status).toBe(200);
    const event = lastSseEvent(res.text);
    expect(event.phase).toBe('error');
    expect(event.code).toBe(ANALYSIS_IN_FLIGHT);
    expect(event.message).toBe('该标的已有一次分析在进行中，请稍后重试');
    expect(event.result).toBeUndefined();
  });

  it('正常路径不受影响：done 事件携带结果', async () => {
    runAnalysisMock.mockResolvedValue(sampleResult);

    const res = await request(app)
      .get('/api/analyze/stream')
      .query({ stockCode: '600519', resume: '1' });

    expect(res.status).toBe(200);
    const event = lastSseEvent(res.text);
    expect(event.phase).toBe('done');
    expect(event.code).toBeUndefined();
    expect(runAnalysisMock.mock.calls[0][2]).toEqual({ resume: true });
  });
});

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ============================================================================
// /api/analyze/stream（SSE 流式分析）路由级测试。
// 背景：这是产品的旗舰链路（1~3 分钟多专家分析，前端靠它渲染进度），
// 但此前全库只有 3 处提及它（路由定义、OpenAPI 契约字符串、前端 URL），
// 没有任何一次真实 HTTP 请求打过它——多事件分帧、done/error 收尾、
// resume 断点续跑契约都处于无回归保护状态。本文件补齐这三处。
// runAnalysis 被打桩，因此不触发任何真实 LLM/行情调用。
// ============================================================================

const { runAnalysisMock } = vi.hoisted(() => ({ runAnalysisMock: vi.fn() }));

vi.mock('../services/analysisPipeline.js', () => ({
  runAnalysis: runAnalysisMock,
}));

// 运行时数据隔离：分析完成会写研究历史与评级台账，全部重定向到临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-stream-'));
process.env.HISTORY_FILE = path.join(tmpDir, 'history.json');
process.env.OUTCOME_FILE = path.join(tmpDir, 'outcomes.json');
process.env.AUDIT_LOG_FILE = path.join(tmpDir, 'audit.log');

const { app } = await import('../index.js');

/** 从 SSE 文本里解析出所有 data 帧 */
function parseFrames(body: string): unknown[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as unknown);
}

const sampleResult = {
  generatedAt: '2026-09-16T12:00:00.000Z',
  dataAsOf: '2026-09-15',
  stock_pool: [
    {
      stock_code: '600519',
      stock_name: '贵州茅台',
      industry: '白酒',
      total_score: 82,
      rating: '优先跟踪',
    },
  ],
  research_confidence: '测试置信度',
  limitation_explain: '测试局限性',
};

describe('/api/analyze/stream（SSE 流式分析）', () => {
  beforeAll(() => {
    delete process.env.PAPER_TRADING_FILE;
  });

  afterAll(() => {
    for (const key of ['HISTORY_FILE', 'OUTCOME_FILE', 'AUDIT_LOG_FILE']) delete process.env[key];
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响用例 */
    }
  });

  beforeEach(() => {
    runAnalysisMock.mockReset();
  });

  it('股票代码非法 → 400 且返回 JSON（不建立 SSE 流）', async () => {
    const res = await request(app).get('/api/analyze/stream').query({ stockCode: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(res.headers['content-type']).toContain('application/json');
    expect(runAnalysisMock).not.toHaveBeenCalled();
  });

  it('正常分析：逐条推送阶段事件，并以 phase=done 携带完整结果收尾', async () => {
    runAnalysisMock.mockImplementation(
      async (
        _code: string,
        onEvent: (stage: { phase: string; message: string }) => void,
      ): Promise<unknown> => {
        onEvent({ phase: 'data', message: '数据获取完成' });
        onEvent({ phase: 'experts', message: '专家研判中' });
        return sampleResult;
      },
    );

    const res = await request(app).get('/api/analyze/stream').query({ stockCode: '600519' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // 反代缓冲必须关闭，否则进度事件会被攒着一起下发（前端表现为"卡住不动"）
    expect(res.headers['x-accel-buffering']).toBe('no');

    const frames = parseFrames(res.text) as Array<Record<string, unknown>>;
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ phase: 'data', message: '数据获取完成' });
    expect(frames[1]).toMatchObject({ phase: 'experts', message: '专家研判中' });
    expect(frames[2].phase).toBe('done');
    expect(frames[2].result).toMatchObject({
      dataAsOf: '2026-09-15',
      stock_pool: [{ stock_code: '600519' }],
    });
    // 每条帧都必须是完整的 data: ...\n\n（被客户端按事件流解析）
    expect(res.text.trimEnd().endsWith('}')).toBe(true);
  });

  it('分析失败：推送 phase=error 帧并给出原因，不推送 done', async () => {
    runAnalysisMock.mockImplementation(async () => {
      throw new Error('上游行情源不可用');
    });

    const res = await request(app).get('/api/analyze/stream').query({ stockCode: '600519' });

    const frames = parseFrames(res.text) as Array<Record<string, unknown>>;
    expect(frames).toHaveLength(1);
    expect(frames[0].phase).toBe('error');
    expect(String(frames[0].message)).toContain('上游行情源不可用');
    expect(frames.some((f) => f.phase === 'done')).toBe(false);
  });

  it('resume=1 时透传断点续跑选项（避免重复支付已完成的 LLM 成本）', async () => {
    runAnalysisMock.mockResolvedValue(sampleResult);

    await request(app).get('/api/analyze/stream').query({ stockCode: '600519', resume: '1' });
    expect(runAnalysisMock).toHaveBeenCalledTimes(1);
    expect(runAnalysisMock.mock.calls[0][0]).toBe('600519');
    expect(runAnalysisMock.mock.calls[0][2]).toEqual({ resume: true });

    runAnalysisMock.mockClear();

    // 未传/传其他值时为全新分析
    await request(app).get('/api/analyze/stream').query({ stockCode: '600519' });
    expect(runAnalysisMock.mock.calls[0][2]).toEqual({ resume: false });
  });

  it('分析完成后写入研究历史（含生成时间戳，供报告时间语境使用）', async () => {
    runAnalysisMock.mockResolvedValue(sampleResult);

    await request(app).get('/api/analyze/stream').query({ stockCode: '600519' });

    const raw = fs.readFileSync(path.join(tmpDir, 'history.json'), 'utf-8');
    const store = JSON.parse(raw) as { items?: Array<Record<string, unknown>> };
    expect(Array.isArray(store.items)).toBe(true);
    expect(store.items?.[0]).toMatchObject({ stockCode: '600519' });
  });
});

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/chatMemory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chatMemory.js')>();
  return {
    ...actual,
    // clearHistory 异步化后路由必须 await；用 spy 断言确实被调用与完成
    clearHistory: vi.fn(async () => {}),
  };
});

vi.mock('../services/chatAgent.js', () => ({
  chatAgent: {
    run: vi.fn(async () => ({ answer: 'ok', toolsUsed: [], evidence: [], degraded: false })),
    // 此前缺 runStream：/api/chat/stream 有效消息会 500（runStream is not a function），
    // 流式 happy path 完全无覆盖
    runStream: vi.fn(async (_opts: unknown, onEvent: (e: unknown) => void) => {
      onEvent({ phase: 'done', message: '完成', response: { answer: 'ok' } });
    }),
  },
}));

// 必须在 mock 之后导入 app
// app 经 withContract 包装：所有 2xx JSON 响应自动接受契约校验（见 test/contractSupertest.ts）
import { app as rawApp } from '../index.js';
import { chatAgent } from '../services/chatAgent.js';
import { withContract } from '../test/contractSupertest.js';
const app = withContract(rawApp);

describe('POST /api/chat', () => {
  it('空内容返回 400', async () => {
    const r = await request(app).post('/api/chat').send({});
    expect(r.status).toBe(400);
  });

  it('超长内容返回 400', async () => {
    const r = await request(app)
      .post('/api/chat')
      .send({ message: 'x'.repeat(2001) });
    expect(r.status).toBe(400);
  });

  it('正常对话返回 200 与回答', async () => {
    const r = await request(app).post('/api/chat').send({ message: '分析 600519' });
    expect(r.status).toBe(200);
    expect(r.body.answer).toBe('ok');
  });
});

describe('GET /api/chat/stream', () => {
  it('空内容返回 400', async () => {
    const r = await request(app).get('/api/chat/stream').query({});
    expect(r.status).toBe(400);
  });

  it('有效消息返回 SSE 流且含 done 事件', async () => {
    const r = await request(app).get('/api/chat/stream').query({ message: '分析 600519' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.text).toContain('data: ');
    expect(r.text).toContain('"phase":"done"');
    // 路由把 message 正确透传给 runStream，并透传 M-5 的 AbortSignal
    // （res close → abort 进行中的 LLM 调用；此处仅断言信号确实被传入 runStream）
    expect(chatAgent.runStream).toHaveBeenCalledWith(
      expect.objectContaining({ message: '分析 600519' }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });
});

describe('POST /api/chat/history/clear', () => {
  it('合法 sessionId → 200 且 await 清空（异步落盘完成后才响应）', async () => {
    const r = await request(app).post('/api/chat/history/clear').send({ sessionId: 'sess-abc' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const { clearHistory } = await import('../services/chatMemory.js');
    expect(vi.mocked(clearHistory)).toHaveBeenCalledWith('sess-abc');
  });

  it('缺少 sessionId → 400', async () => {
    const r = await request(app).post('/api/chat/history/clear').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('sessionId');
  });

  it('非法 sessionId（原型链键）→ 400，不触达存储层', async () => {
    const r = await request(app).post('/api/chat/history/clear').send({ sessionId: '__proto__' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('格式无效');
    const { clearHistory } = await import('../services/chatMemory.js');
    expect(vi.mocked(clearHistory)).not.toHaveBeenCalled();
  });
});

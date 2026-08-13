import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

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
import { app } from '../index.js';
import { chatAgent } from '../services/chatAgent.js';

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
    // 路由把 message 正确透传给 runStream
    expect(chatAgent.runStream).toHaveBeenCalledWith(
      expect.objectContaining({ message: '分析 600519' }),
      expect.any(Function),
    );
  });
});

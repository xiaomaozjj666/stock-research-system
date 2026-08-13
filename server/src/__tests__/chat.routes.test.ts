import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/chatAgent.js', () => ({
  chatAgent: {
    run: vi.fn(async () => ({ answer: 'ok', toolsUsed: [], evidence: [], degraded: false })),
  },
}));

// 必须在 mock 之后导入 app
import { app } from '../index.js';

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
});

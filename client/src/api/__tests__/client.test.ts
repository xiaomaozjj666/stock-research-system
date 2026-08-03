// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeApiError,
  chatWithAgent,
  ingestDocument,
  getModels,
  startAutonomous,
  clearChatHistory,
} from '../client.js';

const axiosInst = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => axiosInst } }));

describe('normalizeApiError', () => {
  it('ERR_CANCELED -> 请求已取消', () => {
    const e = { code: 'ERR_CANCELED', message: 'canceled' };
    expect(normalizeApiError(e).message).toBe('请求已取消');
  });

  it('超时（ECONNABORTED/timeout）提示分析耗时', () => {
    const e = { code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' };
    expect(normalizeApiError(e).message).toContain('超时');
  });

  it('网络不可达（无 response）提示启动后端', () => {
    const e = { code: 'ERR_NETWORK', message: 'Network Error' };
    expect(normalizeApiError(e).message).toContain('localhost:3001');
  });

  it('404 提示版本不一致', () => {
    const e = { response: { status: 404, data: {} } };
    expect(normalizeApiError(e).message).toContain('404');
  });

  it('429 提示频繁', () => {
    const e = { response: { status: 429, data: {} } };
    expect(normalizeApiError(e).message).toContain('频繁');
  });

  it('5xx 提示后端异常', () => {
    const e = { response: { status: 500, data: { error: '内部错误' } } };
    expect(normalizeApiError(e).message).toBe('内部错误');
  });

  it('优先使用服务端返回的业务错误文案', () => {
    const e = { response: { status: 400, data: { error: '请提供有效的6位股票代码' } } };
    expect(normalizeApiError(e).message).toBe('请提供有效的6位股票代码');
  });

  it('有 response 但无业务文案且非特定状态码时回退到默认文案', () => {
    const e = { response: { status: 418, data: {} } };
    expect(normalizeApiError(e, '兜底文案').message).toBe('兜底文案');
  });
});

describe('研究增强接口（前端 API 层）', () => {
  beforeEach(() => {
    axiosInst.post.mockReset();
    axiosInst.get.mockReset();
  });

  it('chatWithAgent 透传 sessionId 给后端（记忆生效）', async () => {
    axiosInst.post.mockResolvedValue({
      data: { answer: 'a', toolsUsed: [], evidence: [], degraded: false },
    });
    await chatWithAgent({ message: 'hi', sessionId: 's1' });
    expect(axiosInst.post).toHaveBeenCalledWith(
      '/chat',
      expect.objectContaining({ sessionId: 's1' }),
      expect.any(Object),
    );
  });

  it('ingestDocument 调 /ingest 并解析返回值', async () => {
    axiosInst.post.mockResolvedValue({
      data: {
        id: 'x',
        title: 't',
        ingested: true,
        insight: { summary: '', positives: [], risks: [], catalysts: [], confidence: 0, source: 'heuristic' },
      },
    });
    const r = await ingestDocument({ title: 't', text: 'x' });
    expect(r.ingested).toBe(true);
    expect(axiosInst.post).toHaveBeenCalledWith(
      '/ingest',
      expect.objectContaining({ title: 't' }),
      expect.any(Object),
    );
  });

  it('getModels 返回 embeddingEnabled 字段', async () => {
    axiosInst.get.mockResolvedValue({
      data: { available: true, embeddingEnabled: false, registry: [], routing: {} },
    });
    const r = await getModels();
    expect(r.embeddingEnabled).toBe(false);
  });

  it('startAutonomous 调 /autonomous/start 并带 intervalMs', async () => {
    axiosInst.post.mockResolvedValue({ data: { started: true, running: true } });
    await startAutonomous(60000);
    expect(axiosInst.post).toHaveBeenCalledWith(
      '/autonomous/start',
      expect.objectContaining({ intervalMs: 60000 }),
      expect.any(Object),
    );
  });

  it('clearChatHistory 调 /chat/history/clear 并带 sessionId', async () => {
    axiosInst.post.mockResolvedValue({ data: { ok: true } });
    await clearChatHistory('s1');
    expect(axiosInst.post).toHaveBeenCalledWith('/chat/history/clear', { sessionId: 's1' }, expect.any(Object));
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeApiError,
  chatWithAgent,
  ingestDocument,
  getModels,
  startAutonomous,
  clearChatHistory,
} from '../client.js';

// 注：桩必须带 interceptors —— client.ts 在模块加载时就注册了 request/response
// 拦截器（鉴权头注入 + 401 广播）。这里内联而非抽公共 helper：vi.hoisted 的回调
// 在 ESM import 之前执行，抽成 import 的 helper 会撞 "Cannot access before
// initialization"（已实测）。桩只需调用不报错，无需断言，故用 no-op。

const httpInst = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  interceptors: {
    request: { use: () => {} },
    response: { use: () => {} },
  },
}));
vi.mock('../http.js', () => ({
  default: { create: () => httpInst },
  isCancelled: (v: unknown) => !!(v && (v as { code?: string }).code === 'ERR_CANCELED'),
}));

describe('normalizeApiError', () => {
  it('ERR_CANCELED -> 请求已取消', () => {
    const e = { code: 'ERR_CANCELED', message: 'canceled' };
    expect(normalizeApiError(e).message).toBe('请求已取消');
  });

  it('超时（ECONNABORTED/timeout）给出通用超时提示', () => {
    const e = { code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' };
    const msg = normalizeApiError(e).message;
    expect(msg).toContain('超时');
    // 共用出口：短请求（自选股 / 模拟盘）超时不能提示「换一只标的」
    expect(msg).not.toContain('标的');
  });

  it('网络不可达（无 response）提示启动后端', () => {
    const e = { code: 'ERR_NETWORK', message: 'Network Error' };
    const msg = normalizeApiError(e).message;
    expect(msg).toContain('无法连接后端服务');
    // 不写死地址：部署环境下 localhost:3001 是错误指引
    expect(msg).not.toContain('localhost');
  });

  it('无 response 且非网络错误码时回落到传入文案，不误报“后端没启动”', () => {
    // 例：前端自身 TypeError。此前一律提示后端不可达，会把代码错误误导成运维问题。
    const e = { message: 'x is not a function' };
    expect(normalizeApiError(e, '兜底文案').message).toBe('兜底文案');
  });

  it('Vite 代理的 502 + PROXY_ECONNREFUSED 走统一文案（不被 body 里的地址绕过）', () => {
    const e = {
      response: { status: 502, data: { code: 'PROXY_ECONNREFUSED' } },
    };
    const msg = normalizeApiError(e).message;
    expect(msg).toContain('无法连接后端服务');
    expect(msg).not.toContain('3001');
  });

  it('404 提示版本不一致', () => {
    const e = { response: { status: 404, data: {} } };
    expect(normalizeApiError(e).message).toContain('404');
  });

  it('429 提示频繁', () => {
    const e = { response: { status: 429, data: {} } };
    expect(normalizeApiError(e).message).toContain('频繁');
  });

  it('401 指向解锁条（且不写死方位，避免文案过期）', () => {
    const e = { response: { status: 401, data: {} } };
    const msg = normalizeApiError(e).message;
    expect(msg).toContain('解锁条');
    expect(msg).toContain('API_AUTH_TOKEN');
  });

  it('服务端给了 error 文案时优先用它（而非本地兜底提示）', () => {
    // 服务端文案区分了"缺令牌"与"令牌无效"，比前端泛化提示更有信息量
    const e = { response: { status: 401, data: { error: '访问令牌无效' } } };
    expect(normalizeApiError(e).message).toBe('访问令牌无效');
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
    httpInst.post.mockReset();
    httpInst.get.mockReset();
  });

  it('chatWithAgent 透传 sessionId 给后端（记忆生效）', async () => {
    httpInst.post.mockResolvedValue({
      data: { answer: 'a', toolsUsed: [], evidence: [], degraded: false },
    });
    await chatWithAgent({ message: 'hi', sessionId: 's1' });
    expect(httpInst.post).toHaveBeenCalledWith(
      '/chat',
      expect.objectContaining({ sessionId: 's1' }),
      expect.any(Object),
    );
  });

  it('ingestDocument 调 /ingest 并解析返回值', async () => {
    httpInst.post.mockResolvedValue({
      data: {
        id: 'x',
        title: 't',
        ingested: true,
        insight: {
          summary: '',
          positives: [],
          risks: [],
          catalysts: [],
          confidence: 0,
          source: 'heuristic',
        },
      },
    });
    const r = await ingestDocument({ title: 't', text: 'x' });
    expect(r.ingested).toBe(true);
    expect(httpInst.post).toHaveBeenCalledWith(
      '/ingest',
      expect.objectContaining({ title: 't' }),
      expect.any(Object),
    );
  });

  it('getModels 返回 embeddingEnabled 字段', async () => {
    httpInst.get.mockResolvedValue({
      data: { available: true, embeddingEnabled: false, registry: [], routing: {} },
    });
    const r = await getModels();
    expect(r.embeddingEnabled).toBe(false);
  });

  it('startAutonomous 调 /autonomous/start 并带 intervalMs', async () => {
    httpInst.post.mockResolvedValue({ data: { started: true, running: true } });
    await startAutonomous(60000);
    expect(httpInst.post).toHaveBeenCalledWith(
      '/autonomous/start',
      expect.objectContaining({ intervalMs: 60000 }),
      expect.any(Object),
    );
  });

  it('clearChatHistory 调 /chat/history/clear 并带 sessionId', async () => {
    httpInst.post.mockResolvedValue({ data: { ok: true } });
    await clearChatHistory('s1');
    expect(httpInst.post).toHaveBeenCalledWith(
      '/chat/history/clear',
      { sessionId: 's1' },
      expect.any(Object),
    );
  });
});

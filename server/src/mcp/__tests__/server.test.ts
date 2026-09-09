import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MCP_TOOLS, handleJsonRpc, executeTool } from '../server.js';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 造一个最小 JSON 响应 */
function jsonResponse(data: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

describe('MCP 协议握手', () => {
  it('initialize 返回协议版本与能力', async () => {
    const res = (await handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      result: { protocolVersion: string; capabilities: { tools: unknown } };
    };
    expect(res.result.protocolVersion).toBeTruthy();
    expect(res.result.capabilities).toHaveProperty('tools');
  });

  it('tools/list 列出全部工具且 schema 完整', async () => {
    const res = (await handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: { name: string; inputSchema: { type: string } }[] };
    };
    expect(res.result.tools.length).toBe(MCP_TOOLS.length);
    for (const t of res.result.tools) {
      expect(t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('未知方法 → -32601；通知类请求不回复', async () => {
    const err = (await handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'nope' })) as {
      error: { code: number };
    };
    expect(err.error.code).toBe(-32601);
    expect(await handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull();
  });
});

describe('工具转发', () => {
  it('quant_health → GET /api/quant/health', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const data = await executeTool('quant_health');
    expect(data).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/quant/health');
  });

  it('quant_cross_section → POST 且透传参数', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ factors: [] }));
    await executeTool('quant_cross_section', { board: 'BK0475', topN: 6 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/quant/factor/cross-section');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ board: 'BK0475', topN: 6 });
  });

  it('缺 board/codes → 明确报错（不外发无效请求）', async () => {
    await expect(executeTool('quant_cross_section', {})).rejects.toThrow(/board 或 codes/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('quant_factor_expression 缺表达式 → 明确报错', async () => {
    await expect(executeTool('quant_factor_expression', {})).rejects.toThrow(/expression/);
  });

  it('quant_factor_experiments 拼查询串', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    await executeTool('quant_factor_experiments', { kept: true, limit: 5 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('kept=true');
    expect(String(fetchMock.mock.calls[0][0])).toContain('limit=5');
  });

  it('未知工具 → 报错', async () => {
    await expect(executeTool('nope')).rejects.toThrow(/未知工具/);
  });
});

describe('tools/call 错误处理', () => {
  it('工具抛错 → 返回 isError 内容而非协议错误（客户端可展示）', async () => {
    const res = (await handleJsonRpc({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'quant_cross_section', arguments: {} },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('工具执行失败');
  });

  it('HTTP 非 2xx → 带状态码报错', async () => {
    fetchMock.mockResolvedValue(jsonResponse('boom', false));
    const res = (await handleJsonRpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'quant_health', arguments: {} },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('HTTP 500');
  });
});

/**
 * MCP server 工具层单测
 * ----------------------------------------------------------------------------
 * 覆盖：工具注册表结构 / executeTool 全部 9 个工具的分发与参数装配（GET、POST、
 * query string、白名单过滤）/ 参数校验失败路径 / callApi 的 HTTP 与解析降级路径 /
 * handleJsonRpc 的协议分支（initialize、tools/list、tools/call、未知方法、通知）/
 * startMcpServer 的行读循环（node:readline 用替身，不触碰真实 stdin/stdout）。
 *
 * 全程不发起真实网络请求：全局 fetch 一律替换为 vi.fn()。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// node:readline 替身：只捕获 'line' 回调，由用例手动投喂行，绝不真的创建 stdio 接口
const rlMock = vi.hoisted(() => {
  const handlers: Record<string, (line: string) => unknown> = {};
  const rl = {
    on: vi.fn((event: string, cb: (line: string) => unknown) => {
      handlers[event] = cb;
      return rl;
    }),
  };
  return { handlers, rl, createInterface: vi.fn(() => rl) };
});

vi.mock('node:readline', () => ({
  createInterface: rlMock.createInterface,
  default: { createInterface: rlMock.createInterface },
}));

import { MCP_TOOLS, executeTool, handleJsonRpc, startMcpServer } from '../server.js';

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  rlMock.handlers.line = undefined as unknown as (line: string) => unknown;
  rlMock.createInterface.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 造一个最小 JSON 响应替身 */
function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  } as unknown as Response;
}

/** 取第 index 次 fetch 调用的 [url, init] */
function fetchCall(index = 0): [string, FetchInit] {
  return fetchMock.mock.calls[index] as unknown as [string, FetchInit];
}

/** 解析第 index 次 fetch 调用的请求体 */
function postedBody(index = 0): unknown {
  return JSON.parse(String(fetchCall(index)[1].body));
}

describe('工具注册表 MCP_TOOLS', () => {
  const EXPECTED_NAMES = [
    'quant_health',
    'quant_universe_boards',
    'quant_cross_section',
    'quant_factor_expression',
    'quant_factor_expression_batch',
    'quant_factor_experiments',
    'quant_screener_run',
    'quant_screener_latest',
    'quant_timeseries_analyze',
    'quant_improvement_status',
    'quant_improvement_run',
    'quant_improvement_history',
  ];

  it('按固定顺序注册 12 个工具，名称与预期完全一致', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(EXPECTED_NAMES);
  });

  it('工具名唯一，描述非空，inputSchema 均为 object 且含 properties', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(tool.inputSchema.properties).not.toBeNull();
    }
  });

  it('required 只在确实需要入参的工具上声明，且为字符串数组', () => {
    const requiredMap = Object.fromEntries(
      MCP_TOOLS.map((t) => [t.name, t.inputSchema.required ?? null]),
    );
    expect(requiredMap).toEqual({
      quant_health: null,
      quant_universe_boards: null,
      quant_cross_section: null,
      quant_factor_expression: ['expression'],
      quant_factor_expression_batch: ['expressions'],
      quant_factor_experiments: null,
      quant_screener_run: null,
      quant_screener_latest: null,
      quant_timeseries_analyze: ['test', 'code'],
      // 改进闭环三个工具都无必填项：状态与历史无入参，跑一轮的 dryRun 可选
      quant_improvement_status: null,
      quant_improvement_run: null,
      quant_improvement_history: null,
    });
  });

  it('批量表达式声明 maxItems=50，且 properties 中提到 ≤50 的限制', () => {
    const batch = MCP_TOOLS.find((t) => t.name === 'quant_factor_expression_batch');
    const expressions = batch?.inputSchema.properties.expressions as {
      type: string;
      maxItems: number;
    };
    expect(expressions.type).toBe('array');
    expect(expressions.maxItems).toBe(50);
    expect(batch?.description).toContain('≤50');
  });

  it('三个因子工具的 schema 都声明了 indexUniverse（文档承诺）', () => {
    for (const name of [
      'quant_cross_section',
      'quant_factor_expression',
      'quant_factor_expression_batch',
    ]) {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty('indexUniverse');
    }
  });
});

describe('executeTool：GET 类工具分发', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
  });

  it.each([
    ['quant_health', '/api/quant/health'],
    ['quant_universe_boards', '/api/quant/universe/boards'],
    ['quant_screener_latest', '/api/quant/screener/latest'],
  ])('%s → GET %s，不带 body/headers', async (toolName, route) => {
    const data = await executeTool(toolName);
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchCall();
    expect(url).toBe(`http://127.0.0.1:3001${route}`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it('args 默认值为空对象（不传第二参数也能调用）', async () => {
    await expect(executeTool('quant_health')).resolves.toEqual({ ok: true });
  });

  it('请求带 AbortSignal 超时（避免大面板冷启动永久挂起）', async () => {
    await executeTool('quant_health');
    expect(fetchCall()[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('executeTool：POST 类工具分发与参数白名单', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse({ factors: [] }));
  });

  it('quant_cross_section 只透传白名单字段，丢弃未知字段', async () => {
    await executeTool('quant_cross_section', {
      board: 'BK0475',
      topN: 6,
      horizons: [21, 63],
      includeFundamental: true,
      includeEvents: false,
      includeMargin: false,
      bogus: 'drop-me',
    });
    const [url, init] = fetchCall();
    expect(url).toBe('http://127.0.0.1:3001/api/quant/factor/cross-section');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(postedBody()).toEqual({
      board: 'BK0475',
      topN: 6,
      horizons: [21, 63],
      includeFundamental: true,
      includeEvents: false,
      includeMargin: false,
    });
  });

  it('布尔 false 会被当作显式入参保留（不被 undefined 过滤误删）', async () => {
    await executeTool('quant_cross_section', { codes: ['600519'], includeMargin: false });
    expect(postedBody()).toEqual({ codes: ['600519'], includeMargin: false });
  });

  it('quant_factor_expression 仅传 expression 时 body 只有 expression', async () => {
    await executeTool('quant_factor_expression', { expression: 'close / mean(close, 20) - 1' });
    const [url, init] = fetchCall();
    expect(url).toBe('http://127.0.0.1:3001/api/quant/factor/expression');
    expect(init.method).toBe('POST');
    expect(postedBody()).toEqual({ expression: 'close / mean(close, 20) - 1' });
  });

  it('quant_factor_expression 透传 name/portfolio 并剔除白名单外字段', async () => {
    await executeTool('quant_factor_expression', {
      expression: 'ret',
      board: 'BK0475',
      codes: ['000001'],
      topN: 20,
      horizons: [5],
      name: 'mom20',
      portfolio: { holdDays: 10, topN: 5, costBps: 30 },
      unknownKey: 1,
    });
    expect(postedBody()).toEqual({
      expression: 'ret',
      board: 'BK0475',
      codes: ['000001'],
      topN: 20,
      horizons: [5],
      name: 'mom20',
      portfolio: { holdDays: 10, topN: 5, costBps: 30 },
    });
  });

  it('quant_factor_expression 对 expression 做 trim', async () => {
    await executeTool('quant_factor_expression', { expression: '  close/volume  ' });
    expect(postedBody()).toEqual({ expression: 'close/volume' });
  });

  it('quant_factor_expression_batch 数组元素统一转字符串并透传 source', async () => {
    await executeTool('quant_factor_expression_batch', {
      expressions: ['close / mean(close, 20) - 1', 42 as unknown as string],
      source: 'hypothesis',
      name: 'batchA',
    });
    const [url, init] = fetchCall();
    expect(url).toBe('http://127.0.0.1:3001/api/quant/factor/expression/batch');
    expect(init.method).toBe('POST');
    expect(postedBody()).toEqual({
      expressions: ['close / mean(close, 20) - 1', '42'],
      source: 'hypothesis',
      name: 'batchA',
    });
  });

  it('quant_screener_run 透传 maxStocks；缺省时提交空 body', async () => {
    await executeTool('quant_screener_run', { maxStocks: 300 });
    expect(fetchCall()[0]).toBe('http://127.0.0.1:3001/api/quant/screener/run');
    expect(postedBody()).toEqual({ maxStocks: 300 });

    fetchMock.mockClear();
    await executeTool('quant_screener_run', {});
    expect(postedBody()).toEqual({});
  });

  it('quant_timeseries_analyze 透传全部六个字段', async () => {
    await executeTool('quant_timeseries_analyze', {
      test: 'coint',
      code: '600519',
      code2: '000858',
      startDate: '2022-01-01',
      endDate: '2025-01-01',
      options: { qRatio: 0.5 },
    });
    const [url, init] = fetchCall();
    expect(url).toBe('http://127.0.0.1:3001/api/quant/timeseries/analyze');
    expect(init.method).toBe('POST');
    expect(postedBody()).toEqual({
      test: 'coint',
      code: '600519',
      code2: '000858',
      startDate: '2022-01-01',
      endDate: '2025-01-01',
      options: { qRatio: 0.5 },
    });
  });

  it('indexUniverse 被白名单静默丢弃（照现状断言，疑似缺陷）', async () => {
    await executeTool('quant_cross_section', {
      board: 'BK0475',
      indexUniverse: { index: 'hs300', date: '2024-06-30' },
      topN: 10,
    });
    expect(postedBody()).toEqual({ board: 'BK0475', topN: 10 });

    fetchMock.mockClear();
    await executeTool('quant_factor_expression', {
      expression: 'ret',
      indexUniverse: { index: 'zz500' },
    });
    expect(postedBody()).toEqual({ expression: 'ret' });

    fetchMock.mockClear();
    await executeTool('quant_factor_expression_batch', {
      expressions: ['ret'],
      indexUniverse: { index: 'sz50' },
    });
    expect(postedBody()).toEqual({ expressions: ['ret'] });
  });

  it('只给 indexUniverse（schema 允许）时被拒为「需要 board 或 codes」（照现状断言）', async () => {
    await expect(
      executeTool('quant_cross_section', { indexUniverse: { index: 'hs300' } }),
    ).rejects.toThrow('需要 board 或 codes');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('executeTool：query string 拼接（quant_factor_experiments）', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
  });

  it('无参数时不带问号', async () => {
    await executeTool('quant_factor_experiments', {});
    const [url, init] = fetchCall();
    expect(url).toBe('http://127.0.0.1:3001/api/quant/factor/experiments');
    expect(init.method).toBe('GET');
  });

  it('布尔 false 与数值 0 都会被写进查询串（按 undefined 判定而非真值）', async () => {
    await executeTool('quant_factor_experiments', { kept: false, limit: 0 });
    expect(fetchCall()[0]).toBe(
      'http://127.0.0.1:3001/api/quant/factor/experiments?kept=false&limit=0',
    );
  });

  it('三个字段按 source/kept/limit 顺序拼接', async () => {
    await executeTool('quant_factor_experiments', { source: 'expression', kept: true, limit: 5 });
    expect(fetchCall()[0]).toBe(
      'http://127.0.0.1:3001/api/quant/factor/experiments?source=expression&kept=true&limit=5',
    );
  });

  it('查询串参数不会被 URL 编码破坏（对象值退化为 [object Object]）', async () => {
    await executeTool('quant_factor_experiments', { source: { a: 1 } as unknown as string });
    expect(fetchCall()[0]).toContain('source=%5Bobject+Object%5D');
  });
});

describe('executeTool：参数校验失败路径', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
  });

  it('quant_cross_section 既无 board 也无 codes → 报错且不外发请求', async () => {
    await expect(executeTool('quant_cross_section', {})).rejects.toThrow('需要 board 或 codes');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('quant_cross_section board 为空字符串 → 视为缺失', async () => {
    await expect(executeTool('quant_cross_section', { board: '' })).rejects.toThrow(
      '需要 board 或 codes',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('quant_cross_section codes 为空数组仍会外发请求（照现状断言，疑似缺陷）', async () => {
    await executeTool('quant_cross_section', { codes: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedBody()).toEqual({ codes: [] });
  });

  it('quant_factor_expression 缺 expression / 空白串 / null → 报错且不外发请求', async () => {
    await expect(executeTool('quant_factor_expression', {})).rejects.toThrow('需要 expression');
    await expect(executeTool('quant_factor_expression', { expression: '   ' })).rejects.toThrow(
      '需要 expression',
    );
    await expect(
      executeTool('quant_factor_expression', { expression: null as unknown as string }),
    ).rejects.toThrow('需要 expression');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('quant_factor_expression 数字 0 被强制转成字符串 "0"（并非判为缺失）', async () => {
    await executeTool('quant_factor_expression', { expression: 0 as unknown as string });
    expect(postedBody()).toEqual({ expression: '0' });
  });

  it('quant_factor_expression_batch 非数组 / 空数组 → 报错且不外发请求', async () => {
    await expect(
      executeTool('quant_factor_expression_batch', {
        expressions: 'close' as unknown as string[],
      }),
    ).rejects.toThrow('需要 expressions 数组');
    await expect(executeTool('quant_factor_expression_batch', { expressions: [] })).rejects.toThrow(
      '需要 expressions 数组',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('quant_factor_expression_batch 超过 50 条不本地拦截（照现状断言，疑似缺陷）', async () => {
    const expressions = Array.from({ length: 51 }, (_, i) => `expr${i}`);
    await executeTool('quant_factor_expression_batch', { expressions });
    expect((postedBody() as { expressions: string[] }).expressions).toHaveLength(51);
  });

  it('quant_timeseries_analyze 缺 test/code 不本地拦截（schema 声明 required，照现状断言）', async () => {
    await executeTool('quant_timeseries_analyze', {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedBody()).toEqual({});
  });

  it('未知工具名 → 报错文案含工具名', async () => {
    await expect(executeTool('quant_nope')).rejects.toThrow('未知工具：quant_nope');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('callApi 的 HTTP 与解析降级路径', () => {
  it('非 2xx → 抛 HTTP 状态码 + 响应体前 300 字符', async () => {
    const body = 'x'.repeat(400);
    fetchMock.mockResolvedValue(jsonResponse(body, false, 404));
    await expect(executeTool('quant_health')).rejects.toThrow(`HTTP 404: ${'x'.repeat(300)}`);
    await expect(executeTool('quant_health')).rejects.toThrow(
      new Error(`HTTP 404: ${body.slice(0, 300)}`),
    );
  });

  it('2xx 但响应体不是 JSON → 退化为 { raw: 前 2000 字符 }', async () => {
    fetchMock.mockResolvedValue(jsonResponse('y'.repeat(2500), true));
    const data = (await executeTool('quant_health')) as { raw: string };
    expect(Object.keys(data)).toEqual(['raw']);
    expect(data.raw).toHaveLength(2000);
    expect(data.raw).toBe('y'.repeat(2000));
  });

  it('2xx 且 JSON 是原始字面量（null/数字）→ 原样返回', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('null', true));
    await expect(executeTool('quant_health')).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse('123', true));
    await expect(executeTool('quant_health')).resolves.toBe(123);
  });

  it('fetch 网络失败 → 原样向上抛，不含本地兜底数据', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(executeTool('quant_health')).rejects.toThrow('fetch failed');
  });
});

describe('handleJsonRpc：协议分支', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));
  });

  it('initialize 返回固定协议版本、服务信息与 tools 能力，并回显 id', async () => {
    const res = (await handleJsonRpc({ jsonrpc: '2.0', id: 'abc', method: 'initialize' })) as {
      jsonrpc: string;
      id: string;
      result: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: { tools: unknown };
      };
    };
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe('abc');
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.serverInfo).toEqual({
      name: 'stock-research-system',
      version: '1.0.0',
    });
    expect(res.result.capabilities).toEqual({ tools: {} });
  });

  it('tools/list 直接返回注册表引用', async () => {
    const res = (await handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: unknown };
    };
    expect(res.result.tools).toBe(MCP_TOOLS);
  });

  it('未知方法 → -32601 且文案带方法名', async () => {
    const res = (await handleJsonRpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' })) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(res.id).toBe(7);
    expect(res.error).toEqual({ code: -32601, message: '不支持的方法：resources/list' });
  });

  it('未知方法缺 method 字段 → 文案为空占位', async () => {
    const res = (await handleJsonRpc({ jsonrpc: '2.0', id: 8 })) as {
      error: { code: number; message: string };
    };
    expect(res.error.message).toBe('不支持的方法：');
  });

  it('id 为 null 或 undefined 的未知方法 → 视为通知，不回复', async () => {
    expect(await handleJsonRpc({ jsonrpc: '2.0', id: null, method: 'nope' })).toBeNull();
    expect(await handleJsonRpc({ jsonrpc: '2.0', method: 'nope' })).toBeNull();
    expect(await handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('id 为 0 时仍按请求回复（0 不是通知）', async () => {
    const res = (await handleJsonRpc({ jsonrpc: '2.0', id: 0, method: 'nope' })) as {
      id: number;
      error: { code: number };
    };
    expect(res.id).toBe(0);
    expect(res.error.code).toBe(-32601);
  });

  it('tools/call 成功 → content 为缩进 JSON 文本，无 isError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ score: 88 }));
    const res = (await handleJsonRpc({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'quant_health', arguments: {} },
    })) as { result: { content: { type: string; text: string }[]; isError?: boolean } };
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content).toEqual([{ type: 'text', text: '{\n  "score": 88\n}' }]);
  });

  it('tools/call 缺 params/name → 按空工具名处理并返回 isError', async () => {
    const res = (await handleJsonRpc({ jsonrpc: '2.0', id: 12, method: 'tools/call' })) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe('工具执行失败：未知工具：');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tools/call 抛非 Error 值 → String(error) 兜底', async () => {
    fetchMock.mockRejectedValue('boom-string');
    const res = (await handleJsonRpc({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'quant_health' },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.content[0].text).toBe('工具执行失败：boom-string');
  });

  it('tools/call 结果超过 20000 字符 → 截断到 20000', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ big: 'z'.repeat(30000) }));
    const res = (await handleJsonRpc({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'quant_health' },
    })) as { result: { content: { text: string }[] } };
    expect(res.result.content[0].text).toHaveLength(20000);
    expect(res.result.content[0].text.startsWith('{\n  "big": "zzz')).toBe(true);
  });

  it('tools/call 无 id 仍会回复（照现状断言：通知语义只对未知方法生效）', async () => {
    const res = await handleJsonRpc({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'quant_health' },
    });
    expect(res).not.toBeNull();
  });
});

describe('startMcpServer：行读循环（readline 替身，不起真进程）', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));
    await startMcpServer();
  });

  /** 已注册的 'line' 回调 */
  function lineHandler(): (line: string) => Promise<unknown> {
    return rlMock.handlers.line as (line: string) => Promise<unknown>;
  }

  /** 已写入 stdout 的原始文本 */
  function written(): string {
    return writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  it('以 process.stdin 与无限 crlfDelay 创建接口并注册 line 监听', () => {
    expect(rlMock.createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    expect(rlMock.rl.on).toHaveBeenCalledWith('line', expect.any(Function));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('空行/纯空白行被忽略', async () => {
    await lineHandler()('');
    await lineHandler()('   ');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('非法 JSON → 回 -32700 解析失败（id 为 null）', async () => {
    await lineHandler()('{ not-json');
    expect(written()).toBe(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"解析失败"}}\n',
    );
  });

  it('合法请求 → 单行 JSON 响应（含换行）', async () => {
    await lineHandler()(JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list' }));
    const text = written();
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    const parsed = JSON.parse(text) as { id: number; result: { tools: unknown[] } };
    expect(parsed.id).toBe(21);
    expect(parsed.result.tools).toHaveLength(MCP_TOOLS.length);
  });

  it('通知类请求 → 不写任何响应', async () => {
    await lineHandler()(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    );
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('JSON 字面量 null → handleJsonRpc 解构抛错（照现状断言，疑似缺陷）', async () => {
    await expect(lineHandler()('null')).rejects.toThrow(TypeError);
  });
});

describe('API_BASE 环境变量覆盖', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('MCP_API_BASE 优先于默认 http://127.0.0.1:3001', async () => {
    vi.stubEnv('MCP_API_BASE', 'http://api.internal:8899/');
    vi.resetModules();
    const fresh = await import('../server.js');
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await fresh.executeTool('quant_health');
    expect(fetchCall()[0]).toBe('http://api.internal:8899//api/quant/health');
  });
});

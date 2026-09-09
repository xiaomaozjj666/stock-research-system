/**
 * MCP server（stdio · JSON-RPC 2.0）
 * ------------------------------------------------------------------
 * 借鉴 QuantDinger：把研究能力对外暴露成 MCP 工具，让 Cursor / Claude Code /
 * Cline 直接在编辑器里调用「跑一次截面因子评估」，而不是人肉切到 web 界面。
 *
 * 设计取舍：本文件是**薄适配器**——工具实现转发到本地已启动的 HTTP API
 * （MCP_API_BASE，默认 http://127.0.0.1:3001），不复制任何业务逻辑。
 * 好处是零逻辑重复、行为与 API 完全一致；代价是要求 API 服务已在运行，
 * 这一点在工具描述里如实写明。
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const API_BASE = process.env.MCP_API_BASE ?? 'http://127.0.0.1:3001';

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'quant_health',
    description: '上游预检：行情源 / LLM / 本地缓存是否可用（需 API 服务已启动）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'quant_universe_boards',
    description: '列出可选行业板块（已过滤旧体系子级板块），供截面评估选 universe',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'quant_cross_section',
    description:
      '截面因子评估：按行业板块或股票代码评估量价/基本面/事件因子的截面 IC、显著性与样本外稳定性',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: '行业板块代码，如 BK0475' },
        codes: { type: 'array', items: { type: 'string' }, description: '显式股票代码列表' },
        topN: { type: 'number', description: '成分股数量（3-300，默认 10）' },
        horizons: { type: 'array', items: { type: 'number' }, description: '持有期，默认 [21,63]' },
        includeFundamental: { type: 'boolean' },
        includeEvents: { type: 'boolean' },
      },
    },
  },
  {
    name: 'quant_factor_expression',
    description:
      '受限 DSL 因子表达式评估：在白名单语法内（close/volume/ret、mean/std/delay/corr 等）验证一个因子假设',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '因子表达式，如 close / mean(close, 20) - 1' },
        board: { type: 'string' },
        codes: { type: 'array', items: { type: 'string' } },
        topN: { type: 'number' },
        horizons: { type: 'array', items: { type: 'number' } },
        name: { type: 'string' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'quant_factor_experiments',
    description: '查询因子实验台账：试过哪些因子、IC/显著性/样本外是否稳定、是否采信',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'cross-section | expression | hypothesis' },
        kept: { type: 'boolean', description: '只看被采信的实验' },
        limit: { type: 'number' },
      },
    },
  },
];

async function callApi(
  route: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const url = `${API_BASE}${route}`;
  const res = await fetch(url, {
    ...(init?.method && init.method !== 'GET'
      ? {
          method: init.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(init.body ?? {}),
        }
      : { method: 'GET' }),
    signal: AbortSignal.timeout(600_000), // 大面板冷启动可能数分钟
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

/** 单个工具的转发实现 */
export async function executeTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  switch (name) {
    case 'quant_health':
      return callApi('/api/quant/health');
    case 'quant_universe_boards':
      return callApi('/api/quant/universe/boards');
    case 'quant_cross_section': {
      const body: Record<string, unknown> = {};
      for (const k of [
        'board',
        'codes',
        'topN',
        'horizons',
        'includeFundamental',
        'includeEvents',
      ]) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      if (!body.board && !body.codes) throw new Error('需要 board 或 codes');
      return callApi('/api/quant/factor/cross-section', { method: 'POST', body });
    }
    case 'quant_factor_expression': {
      const expression = String(args.expression ?? '').trim();
      if (!expression) throw new Error('需要 expression');
      const body: Record<string, unknown> = { expression };
      for (const k of ['board', 'codes', 'topN', 'horizons', 'name']) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      return callApi('/api/quant/factor/expression', { method: 'POST', body });
    }
    case 'quant_factor_experiments': {
      const qs = new URLSearchParams();
      for (const k of ['source', 'kept', 'limit']) {
        if (args[k] !== undefined) qs.set(k, String(args[k]));
      }
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return callApi(`/api/quant/factor/experiments${suffix}`);
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** 处理一条 JSON-RPC 请求；通知类（无 id）返回 null（不回复） */
export async function handleJsonRpc(req: JsonRpcRequest): Promise<unknown | null> {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'stock-research-system', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }
  if (method === 'tools/call') {
    const name = String((params as { name?: string })?.name ?? '');
    const args = ((params as { arguments?: Record<string, unknown> })?.arguments ?? {}) as Record<
      string,
      unknown
    >;
    try {
      const data = await executeTool(name, args);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2).slice(0, 20000) }],
        },
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        },
      };
    }
  }
  if (id === undefined || id === null) return null; // 通知
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `不支持的方法：${method ?? ''}` },
  };
}

/** 启动 stdio MCP 服务（仅作为独立进程运行时调用） */
export async function startMcpServer(): Promise<void> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败' } })}\n`,
      );
      return;
    }
    const res = await handleJsonRpc(req);
    if (res !== null) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
}

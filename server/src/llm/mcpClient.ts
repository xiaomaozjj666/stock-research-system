/**
 * MCP（Model Context Protocol）客户端
 * ----------------------------------------------------------------------------
 * 让 Chat Agent 能够调用外部 MCP server 暴露的工具，与本地 TOOL_DEFINITIONS 一并
 * 拼成 OpenAI function-calling 工具表。支持两种连接方式：
 *   - stdio：spawn 子进程，按 JSON-RPC 2.0 over stdin/stdout 通信；
 *   - sse  ：通过 SSE 通道接收响应，HTTP POST 发送请求。
 *
 * 设计原则：
 * - 连接失败优雅降级：listTools 返回空数组、callTool 返回错误字符串，绝不抛出
 *   阻断主对话流程的异常；
 * - 优先复用 @modelcontextprotocol/sdk（动态 import，缺失则降级为本地实现）；
 * - 不引入任何外部 npm 依赖，仅使用 Node.js 内置能力（child_process / fetch）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDefinition } from './tools.js';

/** MCP 工具元信息（与 MCP 协议 tools/list 返回项一致） */
export interface MCPTool {
  name: string;
  description: string;
  /** JSON Schema 描述的入参结构，直接透传给 OpenAI parameters */
  inputSchema: Record<string, unknown>;
}

/** MCP server 连接配置 */
export type MCPServerConfig =
  | {
      /** stdio 模式：要 spawn 的可执行命令 */
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      /** SSE 模式：SSE 事件流端点 */
      transport: 'sse';
      url: string;
      headers?: Record<string, string>;
    };

/** MCP 工具调用结果（内容块数组，与协议 tools/call 返回结构一致） */
export interface MCPToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** SDK 客户端最小接口（仅声明实际使用的方法子集） */
interface SdkClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: unknown[] }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close?(): Promise<void>;
}

/** @modelcontextprotocol/sdk 模块结构（兼容命名导出与 default 两种形式） */
interface SdkLike {
  Client?: new (info: unknown, opts: unknown) => SdkClientLike;
  StdioClientTransport?: new (opts: unknown) => unknown;
  SSEClientTransport?: new (opts: unknown) => unknown;
  default?: {
    Client?: SdkLike['Client'];
    StdioClientTransport?: SdkLike['StdioClientTransport'];
    SSEClientTransport?: SdkLike['SSEClientTransport'];
  };
}

const JSON_RPC_VERSION = '2.0';
const DEFAULT_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * 尝试动态加载 @modelcontextprotocol/sdk。
 * 用变量引用 specifier 避免 tsc 在编译期解析模块（运行环境可能未安装该包）。
 */
async function tryLoadSdk(): Promise<SdkLike | null> {
  const specifier: string = '@modelcontextprotocol/sdk';
  try {
    const mod = (await import(specifier)) as SdkLike;
    return mod;
  } catch {
    return null;
  }
}

/** 把协议返回的原始工具数组归一化为 MCPTool[] */
function normalizeTools(tools: unknown[]): MCPTool[] {
  const result: MCPTool[] = [];
  for (const t of tools) {
    if (typeof t !== 'object' || t === null) continue;
    const obj = t as Record<string, unknown>;
    const name = String(obj.name ?? '');
    if (!name) continue;
    const rawSchema = obj.inputSchema;
    const inputSchema: Record<string, unknown> =
      typeof rawSchema === 'object' && rawSchema !== null
        ? (rawSchema as Record<string, unknown>)
        : {};
    result.push({
      name,
      description: String(obj.description ?? ''),
      inputSchema,
    });
  }
  return result;
}

/** 把 tools/call 的原始返回序列化为 LLM 可消费的字符串 */
function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (typeof result !== 'object' || result === null) return String(result ?? '');
  const r = result as MCPToolResult;
  if (Array.isArray(r.content)) {
    const texts: string[] = [];
    for (const c of r.content) {
      if (c && typeof c === 'object' && typeof c.text === 'string' && c.text.length > 0) {
        texts.push(c.text);
      }
    }
    if (texts.length > 0) return texts.join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * 单个 MCP server 客户端。
 * 优先复用 @modelcontextprotocol/sdk；缺失或失败时降级为本地 child_process / fetch 实现。
 * 所有对外方法（listTools / callTool）在连接异常时优雅降级，永不抛出。
 */
export class MCPClient {
  readonly name: string;
  private config: MCPServerConfig;
  private sdkClient: SdkClientLike | null = null;
  private child: ChildProcess | null = null;
  private sseController: AbortController | null = null;
  private postEndpoint: string | null = null;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private toolsCache: MCPTool[] | null = null;
  private stdoutBuffer = '';
  private sseBuffer = '';
  private idCounter = 0;
  private endpointPromise: Promise<void> | null = null;
  private endpointResolve: ((v: void | PromiseLike<void>) => void) | null = null;

  constructor(name: string, config: MCPServerConfig) {
    this.name = name;
    this.config = config;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  /** 建立连接并完成 initialize 握手；失败时抛出由上层 registry 捕获降级。 */
  async connect(): Promise<void> {
    if (this.initialized) return;
    const sdk = await tryLoadSdk();
    if (sdk) {
      try {
        await this.connectWithSdk(sdk);
        this.initialized = true;
        return;
      } catch {
        // SDK 不可用或握手失败 → 清理后降级到本地实现
        await this.cleanup();
      }
    }
    if (this.config.transport === 'stdio') {
      this.connectStdio();
    } else {
      await this.connectSse();
    }
    await this.initialize();
    this.initialized = true;
  }

  private async connectWithSdk(sdk: SdkLike): Promise<void> {
    const ClientCtor = sdk.Client ?? sdk.default?.Client;
    if (!ClientCtor) throw new Error('SDK 缺少 Client 导出');
    const client = new ClientCtor({ name: this.name, version: '1.0.0' }, { capabilities: {} });
    let transport: unknown;
    if (this.config.transport === 'stdio') {
      const StdioCtor = sdk.StdioClientTransport ?? sdk.default?.StdioClientTransport;
      if (!StdioCtor) throw new Error('SDK 缺少 StdioClientTransport');
      transport = new StdioCtor({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
      });
    } else {
      const SseCtor = sdk.SSEClientTransport ?? sdk.default?.SSEClientTransport;
      if (!SseCtor) throw new Error('SDK 缺少 SSEClientTransport');
      transport = new SseCtor({
        url: this.config.url,
        requestInit: { headers: this.config.headers },
      });
    }
    await client.connect(transport);
    this.sdkClient = client;
  }

  private connectStdio(): void {
    const cfg = this.config as Extract<MCPServerConfig, { transport: 'stdio' }>;
    const child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => this.onStdoutData(chunk));
    child.on('error', (err) => this.failAll(err));
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        this.failAll(new Error(`MCP 子进程退出，code=${code}`));
      }
    });
  }

  private async connectSse(): Promise<void> {
    const cfg = this.config as Extract<MCPServerConfig, { transport: 'sse' }>;
    this.sseController = new AbortController();
    this.endpointPromise = new Promise<void>((resolve) => {
      this.endpointResolve = resolve;
    });
    const resp = await fetch(cfg.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...(cfg.headers ?? {}) },
      signal: this.sseController.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`SSE 连接失败: HTTP ${resp.status}`);
    }
    // 后台读取 SSE 流（不 await，让 endpoint 事件能触发 resolve）
    this.readSseStream(resp.body).catch((err) => this.failAll(err as Error));
    // 等待服务端推送 endpoint 事件，带超时兜底
    await Promise.race([
      this.endpointPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('SSE 等待 endpoint 超时')), DEFAULT_TIMEOUT_MS),
      ),
    ]);
  }

  private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.sseBuffer += decoder.decode(value, { stream: true });
      this.processSseBuffer();
    }
  }

  private processSseBuffer(): void {
    let idx = this.sseBuffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = this.sseBuffer.slice(0, idx);
      this.sseBuffer = this.sseBuffer.slice(idx + 2);
      this.handleSseEvent(raw);
      idx = this.sseBuffer.indexOf('\n\n');
    }
  }

  private handleSseEvent(raw: string): void {
    const lines = raw.split('\n');
    let event = 'message';
    const dataParts: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataParts.push(line.slice(5).replace(/^ /, ''));
      }
    }
    const data = dataParts.join('\n');
    if (event === 'endpoint') {
      // 服务端告知请求 POST 端点（可能是相对路径，需基于 SSE URL 解析）
      try {
        const base = this.config.transport === 'sse' ? this.config.url : undefined;
        this.postEndpoint = new URL(data, base).toString();
      } catch {
        this.postEndpoint = data;
      }
      this.endpointResolve?.();
      this.endpointResolve = null;
      return;
    }
    if (event !== 'message') return;
    try {
      const msg = JSON.parse(data);
      this.handleJsonRpcMessage(msg);
    } catch {
      // 忽略非 JSON 心跳/注释
    }
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx = this.stdoutBuffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line) this.handleJsonRpcLine(line);
      idx = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleJsonRpcLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      this.handleJsonRpcMessage(msg);
    } catch {
      // 非 JSON 行（日志输出）忽略
    }
  }

  private handleJsonRpcMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { id?: unknown; result?: unknown; error?: { message?: string } };
    // 通知（无 id）不需要响应，直接忽略
    if (typeof m.id !== 'number') return;
    const pending = this.pending.get(m.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(m.id);
    if (m.error) {
      pending.reject(new Error(m.error.message ?? 'MCP 调用失败'));
    } else {
      pending.resolve(m.result);
    }
  }

  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.name, version: '1.0.0' },
    });
    // initialize 完成后发送 notifications/initialized 通知（无 id，无需等待响应）
    this.sendNotification('notifications/initialized', {});
  }

  private sendNotification(method: string, params: unknown): void {
    const msg = { jsonrpc: JSON_RPC_VERSION, method, params };
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    } else if (this.postEndpoint) {
      const headers = this.config.transport === 'sse' ? this.config.headers : undefined;
      void fetch(this.postEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify(msg),
      }).catch(() => {
        // 通知无响应，失败忽略
      });
    }
  }

  private sendRequest<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const id = this.nextId();
    const msg = { jsonrpc: JSON_RPC_VERSION, id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.writeRequest(msg).catch((err: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async writeRequest(msg: unknown): Promise<void> {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(JSON.stringify(msg) + '\n');
      return;
    }
    if (this.postEndpoint) {
      const headers = this.config.transport === 'sse' ? this.config.headers : undefined;
      const resp = await fetch(this.postEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify(msg),
      });
      if (!resp.ok) throw new Error(`MCP POST 失败: HTTP ${resp.status}`);
      return;
    }
    throw new Error('MCP 连接未就绪');
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** 列出该 server 暴露的工具；连接异常时返回空数组，永不抛出。 */
  async listTools(): Promise<MCPTool[]> {
    if (this.toolsCache) return this.toolsCache;
    if (this.sdkClient) {
      try {
        const result = await this.sdkClient.listTools();
        this.toolsCache = normalizeTools(result?.tools ?? []);
        return this.toolsCache;
      } catch {
        return [];
      }
    }
    if (!this.initialized) return [];
    try {
      const result = await this.sendRequest<{ tools?: unknown[] }>('tools/list', {});
      this.toolsCache = normalizeTools(result?.tools ?? []);
      return this.toolsCache;
    } catch {
      return [];
    }
  }

  /** 调用工具；连接异常或工具不存在时返回错误字符串，永不抛出。 */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (this.sdkClient) {
      try {
        const result = await this.sdkClient.callTool({ name, arguments: args });
        return serializeToolResult(result);
      } catch (err) {
        return `MCP 工具调用失败: ${(err as Error).message}`;
      }
    }
    if (!this.initialized) return `MCP server ${this.name} 未连接`;
    try {
      const result = await this.sendRequest<MCPToolResult>('tools/call', { name, arguments: args });
      return serializeToolResult(result);
    } catch (err) {
      return `MCP 工具调用失败: ${(err as Error).message}`;
    }
  }

  /** 关闭连接并释放子进程/网络资源。 */
  async disconnect(): Promise<void> {
    await this.cleanup();
    this.initialized = false;
    this.toolsCache = null;
  }

  private async cleanup(): Promise<void> {
    if (this.sdkClient) {
      try {
        await this.sdkClient.close?.();
      } catch {
        // 关闭失败忽略
      }
      this.sdkClient = null;
    }
    this.failAll(new Error('MCP 连接已关闭'));
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // 忽略
      }
      this.child = null;
    }
    if (this.sseController) {
      this.sseController.abort();
      this.sseController = null;
    }
    this.postEndpoint = null;
    this.endpointResolve = null;
    this.endpointPromise = null;
    this.stdoutBuffer = '';
    this.sseBuffer = '';
  }
}

/**
 * 多 MCP server 注册表。集中管理多个 MCPClient，按工具名路由调用。
 * 连接失败的 server 会被静默跳过，不影响其它 server 与主对话流程。
 */
export class MCPRegistry {
  private clients = new Map<string, MCPClient>();
  private toolIndex = new Map<string, MCPClient>();
  private connecting: Promise<void> | null = null;

  /** 注册一个 MCP server，返回对应的客户端实例。同名注册覆盖旧实例。 */
  register(name: string, config: MCPServerConfig): MCPClient {
    const existing = this.clients.get(name);
    if (existing) {
      this.unregister(name);
    }
    const client = new MCPClient(name, config);
    this.clients.set(name, client);
    return client;
  }

  /** 注销并断开指定 server，同时清理其工具索引。 */
  unregister(name: string): void {
    const client = this.clients.get(name);
    if (!client) return;
    this.clients.delete(name);
    for (const [toolName, c] of this.toolIndex) {
      if (c === client) this.toolIndex.delete(toolName);
    }
    void client.disconnect();
  }

  /** 是否已注册指定名称的 server。 */
  has(name: string): boolean {
    return this.clients.has(name);
  }

  /** 获取指定名称的客户端实例。 */
  get(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  /** 列出所有已注册的客户端。 */
  list(): MCPClient[] {
    return Array.from(this.clients.values());
  }

  /** 并发连接所有已注册的 server，刷新工具索引；任何 server 失败都只跳过、不抛出。 */
  async connectAll(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const entries = Array.from(this.clients.values());
        await Promise.all(
          entries.map(async (client) => {
            try {
              await client.connect();
              const tools = await client.listTools();
              for (const t of tools) this.toolIndex.set(t.name, client);
            } catch {
              // 单个 server 连接失败不影响其它
            }
          }),
        );
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  /** 聚合所有已连接 server 的工具列表。 */
  async listAllTools(): Promise<MCPTool[]> {
    const all: MCPTool[] = [];
    for (const client of this.clients.values()) {
      const tools = await client.listTools();
      all.push(...tools);
    }
    return all;
  }

  /** 按工具名路由到对应 server 调用；找不到时返回错误字符串，永不抛出。 */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const client = this.toolIndex.get(name);
    if (!client) return `未找到 MCP 工具: ${name}`;
    return client.callTool(name, args);
  }

  /** 关闭所有 server 连接并清空索引。 */
  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((c) => c.disconnect()));
    this.toolIndex.clear();
  }
}

/**
 * 把单个 MCP 工具转换为 OpenAI function-calling 兼容的工具定义。
 * 与 tools.ts 的 ToolDefinition 结构对齐，可直接拼进 chat completions 的 tools 字段。
 */
export function mcpToolToOpenAI(tool: MCPTool): ToolDefinition {
  const schema = tool.inputSchema;
  const properties = (schema['properties'] as Record<string, unknown> | undefined) ?? {};
  const requiredRaw = schema['required'];
  const required = Array.isArray(requiredRaw) ? (requiredRaw as string[]) : undefined;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        ...(required ? { required } : {}),
      },
    },
  };
}

/**
 * 从 registry 聚合所有 MCP 工具，并转换为 OpenAI 兼容的工具定义数组。
 * 用于把外部工具注入到 chatWithTools 的 tools 参数中。
 */
export async function createMCPToolsFromRegistry(registry: MCPRegistry): Promise<ToolDefinition[]> {
  const tools = await registry.listAllTools();
  return tools.map(mcpToolToOpenAI);
}

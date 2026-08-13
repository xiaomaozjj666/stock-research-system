import { describe, it, expect, afterEach } from 'vitest';
import {
  MCPClient,
  MCPRegistry,
  mcpToolToOpenAI,
  createMCPToolsFromRegistry,
  type MCPTool,
  type MCPServerConfig,
} from '../mcpClient.js';

/**
 * 生成一个最小可用的 MCP stdio server 脚本（CommonJS，通过 node -e 执行）。
 * 该脚本实现 initialize / notifications/initialized / tools/list / tools/call 四个方法，
 * 暴露一个名为 toolName 的工具，调用时回显参数。
 */
function makeEchoServerScript(toolName: string): string {
  return [
    "let buf='';",
    "process.stdin.setEncoding('utf-8');",
    "process.stdin.on('data',function(chunk){",
    '  buf+=chunk;',
    "  let i=buf.indexOf('\\n');",
    '  while(i!==-1){',
    '    const line=buf.slice(0,i).trim();',
    '    buf=buf.slice(i+1);',
    '    if(line)handle(line);',
    "    i=buf.indexOf('\\n');",
    '  }',
    '});',
    'function handle(line){',
    '  let msg;',
    '  try{msg=JSON.parse(line)}catch{return}',
    "  if(msg.method==='initialize'){",
    "    send(msg.id,{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'test-mcp',version:'1.0'}});",
    "  }else if(msg.method==='notifications/initialized'){",
    '    // 通知，无需响应',
    "  }else if(msg.method==='tools/list'){",
    "    send(msg.id,{tools:[{name:'" +
      toolName +
      "',description:'echo tool: " +
      toolName +
      "',inputSchema:{type:'object',properties:{text:{type:'string',description:'input text'}},required:['text']}}]});",
    "  }else if(msg.method==='tools/call'){",
    '    const args=(msg.params&&msg.params.arguments)||{};',
    "    send(msg.id,{content:[{type:'text',text:'" + toolName + ":'+JSON.stringify(args)}]});",
    '  }',
    '}',
    'function send(id,result){',
    "  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:id,result:result})+'\\n');",
    '}',
  ].join('\n');
}

/** 构造基于 process.execPath 的 stdio 配置，跨平台可靠 */
function stdioConfig(script: string): MCPServerConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', script],
  };
}

// 跟踪所有创建过的 registry，测试结束后统一断开，避免子进程泄漏
const registries: MCPRegistry[] = [];
function newRegistry(): MCPRegistry {
  const r = new MCPRegistry();
  registries.push(r);
  return r;
}

afterEach(async () => {
  for (const r of registries) {
    await r.disconnectAll().catch(() => {});
  }
  registries.length = 0;
});

describe('MCPTool 接口转换', () => {
  it('把 MCP 工具转为 OpenAI function-calling 格式', () => {
    const tool: MCPTool = {
      name: 'get_price',
      description: '获取股票实时价格',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: '6 位股票代码' } },
        required: ['code'],
      },
    };
    const def = mcpToolToOpenAI(tool);
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('get_price');
    expect(def.function.description).toBe('获取股票实时价格');
    expect(def.function.parameters.type).toBe('object');
    expect(def.function.parameters.properties.code).toEqual({
      type: 'string',
      description: '6 位股票代码',
    });
    expect(def.function.parameters.required).toEqual(['code']);
  });

  it('无 required 字段时不输出 required', () => {
    const def = mcpToolToOpenAI({
      name: 'ping',
      description: 'ping',
      inputSchema: { type: 'object', properties: {} },
    });
    expect(def.function.parameters.required).toBeUndefined();
  });

  it('缺少 properties 时回退到空对象', () => {
    const def = mcpToolToOpenAI({
      name: 'noop',
      description: 'no-op',
      inputSchema: { type: 'object' },
    });
    expect(def.function.parameters.properties).toEqual({});
  });

  it('required 非数组时忽略', () => {
    const def = mcpToolToOpenAI({
      name: 'x',
      description: 'x',
      inputSchema: { type: 'object', properties: {}, required: 'not-an-array' },
    });
    expect(def.function.parameters.required).toBeUndefined();
  });
});

describe('MCPRegistry 注册/注销', () => {
  it('注册、查询、注销 server', () => {
    const reg = newRegistry();
    const client = reg.register('srv-a', { transport: 'stdio', command: 'echo' });
    expect(reg.has('srv-a')).toBe(true);
    expect(reg.get('srv-a')).toBe(client);
    expect(reg.list()).toHaveLength(1);

    reg.unregister('srv-a');
    expect(reg.has('srv-a')).toBe(false);
    expect(reg.list()).toHaveLength(0);
  });

  it('重复注册同名 server 覆盖旧实例', () => {
    const reg = newRegistry();
    reg.register('srv', { transport: 'stdio', command: 'echo' });
    const c2 = reg.register('srv', { transport: 'stdio', command: 'echo' });
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('srv')).toBe(c2);
  });

  it('注销不存在的 server 不报错', () => {
    const reg = newRegistry();
    expect(() => reg.unregister('nope')).not.toThrow();
  });
});

describe('连接失败优雅降级', () => {
  it('stdio 命令不存在时 listTools 返回空数组', async () => {
    const client = new MCPClient('bad', {
      transport: 'stdio',
      command: 'this-command-does-not-exist-12345',
    });
    await client.connect().catch(() => {});
    const tools = await client.listTools();
    expect(tools).toEqual([]);
  });

  it('未连接时 callTool 返回错误字符串', async () => {
    const client = new MCPClient('nc', { transport: 'stdio', command: 'echo' });
    const r = await client.callTool('foo', {});
    expect(r).toContain('未连接');
  });

  it('SSE 连接失败时 listTools 返回空数组', async () => {
    const client = new MCPClient('bad-sse', {
      transport: 'sse',
      url: 'http://127.0.0.1:1/nope',
    });
    await client.connect().catch(() => {});
    const tools = await client.listTools();
    expect(tools).toEqual([]);
  });

  it('connectAll 中单个 server 失败不影响其它', async () => {
    const reg = newRegistry();
    reg.register('bad1', { transport: 'stdio', command: 'no-such-cmd-99999' });
    reg.register('bad2', { transport: 'sse', url: 'http://127.0.0.1:1/x' });
    // 不抛出
    await reg.connectAll();
    const tools = await reg.listAllTools();
    expect(tools).toEqual([]);
    // callTool 找不到工具时返回错误字符串
    const r = await reg.callTool('any', {});
    expect(r).toContain('未找到');
  });
});

describe('工具列表转 OpenAI 格式', () => {
  it('从真实 stdio server 聚合工具并转为 OpenAI 定义', async () => {
    const reg = newRegistry();
    reg.register('echo-srv', stdioConfig(makeEchoServerScript('echo')));
    await reg.connectAll();

    const defs = await createMCPToolsFromRegistry(reg);
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBe('function');
    expect(defs[0].function.name).toBe('echo');
    expect(defs[0].function.parameters.type).toBe('object');
    expect(defs[0].function.parameters.required).toEqual(['text']);
    expect(defs[0].function.parameters.properties.text).toEqual({
      type: 'string',
      description: 'input text',
    });
  }, 15000);

  it('空 registry 返回空数组', async () => {
    const reg = newRegistry();
    const defs = await createMCPToolsFromRegistry(reg);
    expect(defs).toEqual([]);
  });
});

describe('callTool 路由', () => {
  it('按工具名路由到正确的 server', async () => {
    const reg = newRegistry();
    reg.register('srv-a', stdioConfig(makeEchoServerScript('echo')));
    reg.register('srv-b', stdioConfig(makeEchoServerScript('calc')));
    await reg.connectAll();

    // echo 工具应路由到 srv-a
    const r1 = await reg.callTool('echo', { text: 'hello' });
    expect(r1).toContain('echo:');
    expect(r1).toContain('hello');

    // calc 工具应路由到 srv-b
    const r2 = await reg.callTool('calc', { text: '1+1' });
    expect(r2).toContain('calc:');

    // 未注册的工具返回错误字符串
    const r3 = await reg.callTool('nonexistent', {});
    expect(r3).toContain('未找到');
  }, 15000);

  it('单个 client 的 callTool 经 JSON-RPC 返回内容', async () => {
    const client = new MCPClient('solo', stdioConfig(makeEchoServerScript('greet')));
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('greet');

    const r = await client.callTool('greet', { text: 'world' });
    expect(r).toContain('greet:');
    expect(r).toContain('world');
    await client.disconnect();
  }, 15000);
});

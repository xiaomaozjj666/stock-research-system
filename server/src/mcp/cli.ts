/**
 * MCP server 启动入口（stdio）。
 * 供 MCP 客户端配置：`command: npx, args: ["tsx", "server/src/mcp/cli.ts"]`。
 */
import { startMcpServer } from './server.js';

void startMcpServer();

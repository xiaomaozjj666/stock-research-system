/**
 * 服务端测试全局隔离
 * ----------------------------------------------------------------------------
 * 把运行时数据文件（审计日志 / 对话历史）默认重定向到 per-worker 系统临时目录，
 * 避免路由级集成测试（import 真实 app 触发全局 auditLogger / chatMemory 落盘）
 * 污染 server/src/data/ 下的真实数据文件。
 *
 * 各测试文件自身管理的 env（WATCHLIST_FILE / PAPER_TRADING_FILE / DATA_CACHE_DIR /
 * AUDIT_LOG_FILE）会在 beforeAll 中覆盖这里的默认值，互不冲突；
 * 临时目录交由操作系统清理，不在此主动删除（避免批量删除被沙箱守卫拦截）。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { setLogLevel } from '../utils/logger.js';

const testDataDir = mkdtempSync(join(tmpdir(), 'srs-test-data-'));
process.env.AUDIT_LOG_FILE = join(testDataDir, 'audit.log');
process.env.CHAT_HISTORY_FILE = join(testDataDir, 'chatHistory.json');
// 路由级测试（security/features 等）会经真实 app 写自选股/模拟盘/缓存：
// 未显式重定向的测试一律落到临时目录，杜绝污染 server/src/data/
process.env.WATCHLIST_FILE = join(testDataDir, 'watchlist.json');
process.env.PAPER_TRADING_FILE = join(testDataDir, 'paperTrading.json');
process.env.DATA_CACHE_DIR = join(testDataDir, 'cache');
// 基本面（年报/季度财报）缓存默认关闭：路由级集成测试逐用例 mock 其返回值，
// 缓存会让后序用例读到前序用例的数据（与 beforeEach 的 mockReset 语义冲突）。
// 需要验证缓存行为的测试在用例内显式把 TTL 设为正数即可。
process.env.QUANT_FINANCIAL_CACHE_TTL_HOURS = '0';
process.env.QUANT_QUARTERLY_CACHE_TTL_HOURS = '0';

// 静音结构化日志（路由级测试 import 真实 app 会产生大量 HTTP request / warn 噪音）。
// 依赖日志输出的测试（env.test.ts / telemetry.test.ts）会在用例内显式 setLogLevel 恢复。
setLogLevel('error');

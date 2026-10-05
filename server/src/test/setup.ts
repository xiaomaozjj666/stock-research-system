/**
 * 服务端测试全局隔离
 * ----------------------------------------------------------------------------
 * 把运行时数据文件（审计日志 / 对话历史）默认重定向到 per-worker 系统临时目录，
 * 避免路由级集成测试（import 真实 app 触发全局 auditLogger / chatMemory 落盘）
 * 污染 server/src/data/ 下的真实数据文件。
 *
 * 各测试文件自身管理的 env（WATCHLIST_FILE / PAPER_TRADING_FILE / DATA_CACHE_DIR /
 * AUDIT_LOG_FILE）会在 beforeAll 中覆盖这里的默认值，互不冲突。
 *
 * ── 为什么改用「固定目录 + 进程号」而不是 mkdtemp ──
 * 此前每个 worker 进程各建一个 `srs-test-data-XXXXXX`，且**从不清理**（注释
 * 说「交由操作系统清理」）。但 Windows 的 %TEMP% 不会自动清理，实测本机
 * 累积到 **1.4 万个**同级目录后：
 *   - `du` 这类遍历命令直接超时；
 *   - 各测试 `afterAll` 里的 `fs.rmSync(tmpDir, {recursive:true})` 变慢，
 *     auditLog.persistence / rag.corpus 相继 `Hook timed out in 60000ms`
 *     —— 表现为「单跑必绿、全量偶发红」的 flaky，且**会随时间越来越频繁**
 *     （累积量单调增长）。
 * 改成 `<固定前缀>-<pid>`：同一 worker 复用同一目录（worker 生命周期内），
 * 目录总数被 pid 数量级约束，而不是「文件数 × 轮数」。pid 复用时先清空重建，
 * 保证拿到干净目录且不与其它 worker 冲突。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { setLogLevel } from '../utils/logger.js';

// pid 作后缀：worker 进程内唯一，并发 worker 之间不冲突。
// Windows 上目录名不能含 ':'，故用 '-' 连接。
const testDataDir = join(tmpdir(), `srs-test-data-${process.pid}`);
// pid 会被复用（进程退出后 pid 可能被新进程接手）。先清空再建，保证拿到干净目录。
try {
  rmSync(testDataDir, { recursive: true, force: true, maxRetries: 0 });
} catch {
  /* 目录不存在或被占用（另一个同名 worker 正在用）——保留原样即可 */
}
mkdirSync(testDataDir, { recursive: true });
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

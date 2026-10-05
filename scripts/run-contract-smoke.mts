/**
 * 契约冒烟门禁的启动器：起服务 → 等就绪 → 跑校验 → 关停。
 *
 * 为什么单独一个启动器而不在 contract-smoke.mts 里自起进程：
 * 本机沙箱会 SIGTERM 掉脚本内部 spawn 出来的子进程（实测 tsx 与 node 都一样），
 * 所以「起进程」必须发生在 shell 层。这里用 shell 负责生命周期，
 * TS 脚本只负责发 HTTP 请求 —— 职责切开，各自都能单独调试。
 *
 * 端口用 3477（避开开发常用的 3001/3100）；PORT 环境变量会被 server 读取。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.SMOKE_PORT ?? 3477);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(import.meta.dirname ?? '.', '..');

function fail(msg: string): never {
  console.error(`[smoke:contract] ${msg}`);
  process.exit(1);
}

// 1) 代理必须绕过：本机设了 HTTP_PROXY 但没有 NO_PROXY，127.0.0.1 走代理会 502
process.env.NO_PROXY = `127.0.0.1,localhost,::1,${process.env.NO_PROXY ?? ''}`;
process.env.no_proxy = process.env.NO_PROXY;

/**
 * 2) **数据文件隔离（必须在起进程之前设好）**。
 *
 * 冒烟里有一批 POST 端点（下单 / 结算 / 改自选股 / 清记忆 / 启停调度…）会**写真实
 * 数据文件**。不隔离的话，跑一次冒烟就会污染用户自己的自选股与模拟盘账户 ——
 * 这不是「测试副作用」，是**改用户数据**，绝不能默认发生。
 *
 * 机制与 `server/src/test/setup.ts` 相同（把路径指到系统临时目录），这里在
 * **进程级**设环境变量，因为冒烟起的是真实 server 进程、不经过 vitest setup。
 * 临时目录交操作系统清理，不主动 rm（避免批量删除撞沙箱守卫）。
 */
const smokeDataDir = mkdtempSync(join(tmpdir(), 'srs-smoke-'));
process.env.WATCHLIST_FILE = join(smokeDataDir, 'watchlist.json');
process.env.PAPER_TRADING_FILE = join(smokeDataDir, 'paperTrading.json');
process.env.AUDIT_LOG_FILE = join(smokeDataDir, 'audit.log');
process.env.CHAT_HISTORY_FILE = join(smokeDataDir, 'chatHistory.json');
process.env.DATA_CACHE_DIR = join(smokeDataDir, 'cache');
// 因子实验台账 / 研究简报也落盘：改进闭环 dryRun 不写，但 scheduler 类可能触发，
// 同样指走临时目录，确保冒烟对真实数据零影响。
process.env.FACTOR_LEDGER_FILE = join(smokeDataDir, 'factorExperiments.json');
process.env.RESEARCH_DIGEST_FILE = join(smokeDataDir, 'researchDigests.json');
// 关闭财务/季度缓存：避免冒烟把抓到的行情写进真实缓存目录。
process.env.QUANT_FINANCIAL_CACHE_TTL_HOURS = '0';
process.env.QUANT_QUARTERLY_CACHE_TTL_HOURS = '0';

// 研究历史：与上面同一套隔离机制。
process.env.HISTORY_FILE = join(smokeDataDir, 'history.json');

/**
 * 3) 播一颗「研究历史」种子。
 *
 * 为什么需要：`GET/DELETE /api/history/{id}` 的响应体同样需要被真实校验，
 * 而 history **只由分析成功时落库**（routes/analysis.ts 的 saveHistoryEntry，
 * 依赖 LLM + 行情），冒烟里既没有 LLM 也没有 id，POST /api/history 并不存在
 * （404）。于是这里直接按 `HistoryStore`（services/historyService.ts）的形状
 * 写一条进临时目录，让 DELETE 端点有确定可删的 id。
 *
 * 写临时目录而非真实数据：这条与删除都只作用于 smokeDataDir。
 */
const SMOKE_HISTORY_ID = 'smoke-history-1';
writeFileSync(
  process.env.HISTORY_FILE,
  JSON.stringify({
    items: [
      {
        id: SMOKE_HISTORY_ID,
        stockCode: '600519',
        stockName: '冒烟样本',
        createdAt: '2026-01-05T10:00:00.000Z',
        rating: '买入',
        totalScore: 80,
        industry: '白酒',
        result: {
          stock_pool: [],
          data_sources: [],
          research_confidence: '高',
          limitation_explain: '契约冒烟种子数据',
        },
      },
    ],
  }),
  'utf8',
);

let server: ReturnType<typeof spawn> | undefined;
let serverLog = '';

function startServer(): void {
  server = spawn('node', ['server/dist/index.js'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => (serverLog += d));
  server.stderr?.on('data', (d) => (serverLog += d));
}

async function waitReady(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 尚未监听 */
    }
    await sleep(500);
  }
  return false;
}

async function main(): Promise<void> {
  if (!(await waitReady())) {
    fail(`服务在 30s 内未就绪。最后日志：\n${serverLog.slice(-1200)}`);
  }

  const smoke = spawn('node', ['--import', 'tsx', 'scripts/contract-smoke.mts'], {
    cwd: repoRoot,
    env: { ...process.env, SMOKE_BASE: BASE, SMOKE_HISTORY_ID },
    stdio: 'inherit',
  });
  const code = await new Promise<number>((r) => smoke.on('exit', (c) => r(c ?? 1)));
  process.exit(code);
}

/**
 * 先构建再冒烟。
 *
 * 关键：**契约与被测响应必须来自同一份 dist**。只校验不构建会漏掉一种假绿灯 ——
 * 改了 src/services/openapi.ts 但没重新 build 时，dist 里的服务返回旧行为，
 * 而若契约从 dist 读就一致（安全）；但若有人从 src 读契约就比的是新契约 vs 旧响应。
 * 这里坚持「先 build、契约也从 dist 读」，从两端堵死这条路。
 *
 * 用 `npm run build --workspace=server`（它自带 dist 清理）。本机删除守卫会对
 * >50 文件的递归删除拦一道，故本脚本不自己 rm dist。
 */
async function buildFirst(): Promise<void> {
  console.log('[smoke:contract] 先构建 server（保证契约与响应同源）…');
  const p = spawn('npm', ['run', 'build', '--workspace=server'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
  const code = await new Promise<number>((r) => p.on('exit', (c) => r(c ?? 1)));
  if (code !== 0) fail('server 构建失败，冒烟中止（避免拿旧产物校验）');
}

try {
  // 顺序很重要：先构建，再起服务。构建会清 dist，所以不能先起进程。
  await buildFirst();
  startServer();
  await main();
} finally {
  server?.kill();
}

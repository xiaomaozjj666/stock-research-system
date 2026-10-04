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
import { resolve } from 'node:path';

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
    env: { ...process.env, SMOKE_BASE: BASE },
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

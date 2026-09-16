#!/usr/bin/env node
/**
 * 零依赖的一键启动器：同时拉起 server (tsx watch, 3001) 与 client (vite, 5173)。
 * 取代 concurrently，避免额外安装；`npm run dev` 即调用本脚本。
 * 退出时杀掉整棵子进程树（Windows 用 taskkill /T /F，POSIX 用进程组 kill），
 * 而不是只对直接子进程发 SIGTERM——否则 tsx watch / vite 会变成孤儿进程占住
 * 3001/5173（实测：只 kill 直接子进程后两个端口仍被 LISTENING 占用）。
 */
import { spawn, spawnSync } from 'node:child_process';

const COLORS = {
  server: '\x1b[36m', // cyan
  client: '\x1b[35m', // magenta
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

const procs = [];
let shuttingDown = false;

/**
 * 杀掉整棵进程树。
 * 背景：spawn('npm', ..., { shell: true }) 的进程链是
 *   node(dev.mjs) → cmd.exe → npm → cmd.exe → tsx watch / vite
 * 只对直接子进程 p.kill('SIGTERM') 在 Windows 下仅终止 cmd 壳，孙进程会残留并继续
 * 占用 3001/5173。因此 Windows 走 `taskkill /PID <pid> /T /F`（/T 连子孙一起杀），
 * POSIX 走进程组 kill(-pid)（子进程以 detached: true 起，自成一个进程组）。
 */
function killTree(p) {
  if (!p || p.pid === undefined || p.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    p.kill('SIGTERM');
    process.kill(-p.pid, 'SIGTERM');
  } catch {
    /* ignore */
  }
}

function start(name, args) {
  const p = spawn('npm', ['run', ...args], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    // POSIX：自成进程组，退出时可整组杀；Windows 无此语义（用 taskkill /T 代替）
    detached: process.platform !== 'win32',
  });
  const tag = `${COLORS[name]}[${name}]${COLORS.reset} `;
  const pipe = (stream, isErr) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        process[isErr ? 'stderr' : 'stdout'].write(tag + line + '\n');
      }
    });
  };
  pipe(p.stdout, false);
  pipe(p.stderr, true);
  p.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // 任一子进程异常退出 → 整体关闭，避免只起了一半
    console.log(`${COLORS[name]}[${name}] exited (code=${code}, signal=${signal})${COLORS.reset}`);
    shutdown(typeof code === 'number' ? code : 1);
  });
  procs.push(p);
  return p;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    killTree(p);
  }
  // 给杀树留一点时间后再硬退（顺序必须是"先杀树、后退出"）
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(
  `${COLORS.dim}启动 dev 环境：server(:3001) + client(:5173)，Ctrl+C 退出${COLORS.reset}`,
);
start('server', ['dev:server']);
start('client', ['dev:client']);

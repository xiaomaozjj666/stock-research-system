#!/usr/bin/env node
/**
 * 零依赖的一键启动器：同时拉起 server (tsx watch, 3001) 与 client (vite, 5173)。
 * 取代 concurrently，避免额外安装；`npm run dev` 即调用本脚本。
 * Ctrl+C 时统一 SIGTERM 杀掉两个子进程。
 */
import { spawn } from 'node:child_process';

const COLORS = {
  server: '\x1b[36m', // cyan
  client: '\x1b[35m', // magenta
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

const procs = [];
let shuttingDown = false;

function start(name, args) {
  const p = spawn('npm', ['run', ...args], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
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
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  // 给子进程一点时间退出
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(
  `${COLORS.dim}启动 dev 环境：server(:3001) + client(:5173)，Ctrl+C 退出${COLORS.reset}`,
);
start('server', ['dev:server']);
start('client', ['dev:client']);

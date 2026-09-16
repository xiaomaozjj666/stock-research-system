import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

/**
 * E2E 全局 setup：
 * 1. 清空并重建 e2e 隔离目录（watchlist/paper/cache/history 重定向目标）；
 * 2. 构建两端产物（server dist + client dist）——webServer 以生产模式运行需要。
 *
 * 注意：Playwright 的 webServer 作为插件在 globalSetup **之前**启动，因此这里的
 * "按需构建"是本地兜底；CI 在 `npx playwright test` 前用 build artifact 提供产物，
 * 并由 workflow 里的 `Verify build artifacts` 步骤确认存在（见 ci.yml e2e job）。
 */
export default function globalSetup() {
  // 本文件位于 e2e/ 目录；项目根为其父目录（ESM 下不用 __dirname）
  const e2eDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.join(e2eDir, '..');

  // 每次运行都**清空**隔离目录：此前只 mkdir，上一次运行残留的 watchlist/history/audit
  // 会让断言依赖"上一次跑到哪"，本地重复执行 e2e 即出现顺序依赖。
  const tmpDir = path.join(e2eDir, '.tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, 'cache'), { recursive: true });

  /** 目录树中最新的 mtime（用于判断产物是否陈旧） */
  function newestMtime(dir: string, accept: (name: string) => boolean): number {
    let newest = 0;
    const walk = (current: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return; // 目录不存在/不可读：视为无源码
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else if (accept(entry.name)) {
          try {
            newest = Math.max(newest, fs.statSync(full).mtimeMs);
          } catch {
            /* 单个文件读不到忽略 */
          }
        }
      }
    };
    walk(dir);
    return newest;
  }

  /**
   * 是否需要重建：产物缺失，或**源码比产物新**。
   * 后者是本地 e2e 最容易踩的坑——dist 存在就不会重建，于是浏览器里跑的是旧代码，
   * 本地"全绿"实际验证的是上一次的构建。CI 走 artifact（下载晚于 checkout）不会触发。
   */
  function needsBuild(
    sourceDir: string,
    outFile: string,
    accept: (name: string) => boolean,
  ): boolean {
    if (process.env.E2E_FORCE_BUILD === '1') return true;
    if (!fs.existsSync(outFile)) return true;
    const outMtime = fs.statSync(outFile).mtimeMs;
    return newestMtime(sourceDir, accept) > outMtime;
  }

  if (
    needsBuild(
      path.join(projectRoot, 'server', 'src'),
      path.join(projectRoot, 'server', 'dist', 'index.js'),
      (n) => n.endsWith('.ts'),
    )
  ) {
    execSync('npm run build --workspace=server', { cwd: projectRoot, stdio: 'inherit' });
  }

  if (
    needsBuild(
      path.join(projectRoot, 'client', 'src'),
      path.join(projectRoot, 'client', 'dist', 'index.html'),
      (n) => /\.(ts|tsx|css)$/.test(n),
    )
  ) {
    execSync('npm run build --workspace=client', { cwd: projectRoot, stdio: 'inherit' });
  }
}

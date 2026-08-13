import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

/**
 * E2E 全局 setup：
 * 1. 构建两端产物（server dist + client dist）——webServer 以生产模式运行需要；
 * 2. 创建 e2e 隔离临时目录（watchlist/paper/cache 重定向目标）。
 * 构建产物已存在时跳过，避免重复构建拖慢 E2E。
 */
export default function globalSetup() {
  // 本文件位于 e2e/ 目录；项目根为其父目录（ESM 下不用 __dirname）
  const e2eDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.join(e2eDir, '..');
  fs.mkdirSync(path.join(e2eDir, '.tmp', 'cache'), { recursive: true });

  const serverDist = path.join(projectRoot, 'server', 'dist', 'index.js');
  if (!fs.existsSync(serverDist)) {
    execSync('npm run build --workspace=server', { cwd: projectRoot, stdio: 'inherit' });
  }

  const clientDist = path.join(projectRoot, 'client', 'dist', 'index.html');
  if (!fs.existsSync(clientDist)) {
    execSync('npm run build --workspace=client', { cwd: projectRoot, stdio: 'inherit' });
  }
}

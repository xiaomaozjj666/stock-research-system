import { defineConfig } from '@playwright/test';
import * as path from 'path';

// E2E 冒烟测试专用配置：
// - 由 globalSetup 先执行 npm run build（server dist + client dist）；
// - webServer 以生产模式启动真实后端（Express 同源托管前端静态产物，见 index.ts SPA 托管段）；
// - 所有运行时数据文件（watchlist/paper/cache）重定向到 e2e/.tmp，不污染真实数据。
const E2E_TMP = path.join(import.meta.dirname, 'e2e', '.tmp');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  retries: 0,
  workers: 1, // 共享单个服务实例，串行执行
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server/dist/index.js',
    // 根路径由 SPA 托管返回 200（/api/health 在外部数据源不可达时为 503，不适合做就绪探针）
    url: 'http://127.0.0.1:3100/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: '3100',
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      // 数据隔离：E2E 不触碰真实自选股/模拟盘/缓存/审计日志数据
      WATCHLIST_FILE: path.join(E2E_TMP, 'watchlist.json'),
      PAPER_TRADING_FILE: path.join(E2E_TMP, 'paperTrading.json'),
      DATA_CACHE_DIR: path.join(E2E_TMP, 'cache'),
      AUDIT_LOG_FILE: path.join(E2E_TMP, 'audit.log'),
    },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React 运行时单独成块。react-is 显式列出：它以前是被 `id.includes('react')`
// 顺带捞进来的，保留在清单里才能保持原有分块形状不变。
const REACT_PKGS = new Set(['react', 'react-dom', 'react-is', 'scheduler']);

// ECharts 及其渲染依赖 zrender 单独成块
const ECHARTS_PKGS = new Set(['echarts', 'zrender']);

/**
 * 研究报告渲染组件：报告页是默认页，这组组件会被 App 静态引用，曾经全部落进
 * 入口 chunk（index 108.88 / 预算 109 kB，只剩 0.12 kB，加任何功能都会先撞这一条）。
 * 单独成块后入口只保留壳层与交互状态，报告组件作为并行预加载的静态依赖，
 * 首屏行为不变，但入口体积余量恢复到 ~45 kB，且只改报告组件时不会让入口 hash 失效。
 * 只列这组组件（不含 EChart/图表组件），避免把 echarts 运行时拖回入口。
 */
const REPORT_COMPONENTS = new Set([
  'ReportHeader',
  'CoreSummary',
  'FinancialSection',
  'ValuationSection',
  'ExpertOpinions',
  'CapitalFlowSection',
  'ScenarioSection',
  'StrategyListSection',
  'NewsSentimentCard',
  'ConsensusCard',
  'ScoringTable',
  'ControversySection',
  'RiskSection',
  'ReflectionSection',
  'FollowUpSection',
  'MobileNav',
  'ChatPanel',
  'ResearchEnhance',
]);

/**
 * 从模块 id 里解析出它所属的 node_modules 包名，非第三方依赖返回 null。
 * 取最后一个 `/node_modules/`，以兼容 pnpm 虚拟 store
 * （<store>/pkg@ver/node_modules/pkg/... 这类嵌套结构）。
 */
function packageNameOf(id: string): string | null {
  // Windows 上 Rollup 的 id 可能是反斜杠，先统一成正斜杠再切
  const normalized = id.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;

  const segments = normalized.slice(index + marker.length).split('/');
  // 带 scope 的包（@scope/name）占两段
  const name = segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
  // 兜底：跳过 .pnpm/.bin 这类虚拟目录
  return name && !name.startsWith('.') ? name : null;
}

// 开发代理的后端地址；报错文案引用同一常量，避免改端口后提示与实际不一致
const API_PROXY_TARGET = 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 端口被占用时直接失败，不要静默换到 5174：启动脚本只轮询/打开 5173，
    // 静默漂移会让脚本打开上一次遗留的旧实例。
    strictPort: true,
    proxy: {
      '/api': {
        // 固定用 127.0.0.1：后端默认只绑回环地址，而 Node 解析 localhost 时可能优先取
        // IPv6 的 ::1，届时代理会 ECONNREFUSED（表现为 502）。
        target: API_PROXY_TARGET,
        changeOrigin: true,
        // SSE 长连接：不能被代理层提前掐断
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          // 后端未启动时，返回结构化 JSON 而不是让浏览器看到裸 ECONNREFUSED
          proxy.on('error', (err, req, res) => {
            const code = (err as NodeJS.ErrnoException).code;
            const msg =
              code === 'ECONNREFUSED'
                ? `无法连接后端服务（${API_PROXY_TARGET}），请确认服务已启动`
                : `代理请求失败：${err.message}`;
            console.error(`[vite-proxy] ${req.method} ${req.url} -> ${msg}`);
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
              // 只回机器码，用户可见文案统一由前端 BACKEND_UNREACHABLE_MESSAGE 渲染：
              // 此前 body 里带 host:port 的 error 会让统一文案永远走不到。
              res.end(
                JSON.stringify(
                  code === 'ECONNREFUSED'
                    ? { code: 'PROXY_ECONNREFUSED' }
                    : { error: msg, code: code ?? 'PROXY_ERROR' },
                ),
              );
            } else if ('end' in res) {
              res.end();
            }
          });
          // SSE 需要关闭 Nagle 缓冲，否则进度事件会被攒着一起下发
          proxy.on('proxyRes', (proxyRes, req) => {
            if (req.url?.includes('/stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    // 面向现代浏览器，减小 polyfill 体积
    target: 'es2020',
    sourcemap: false,
    // 输出目录清理交由外部（CI/脚本）处理：沙箱安全删除守卫会拦截 Vite 的批量清空
    emptyOutDir: true,
    // 只做早期预警：真正的硬上限由 client/scripts/check-bundle-size.mjs 在 CI 里拦截。
    // 原来的 1000 kB 比最大 chunk（echarts-vendor ≈ 626 kB）还大出 60%，永远不可能触发，
    // 等于没有约束。取 650 kB：干净构建不刷屏，但只要 echarts 再涨 4% 就会立刻报警。
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        // 将第三方依赖拆分为独立 chunk，提升长期缓存命中率
        manualChunks(id) {
          const pkg = packageNameOf(id);
          if (pkg) {
            // 按解析出的包名匹配，而不是按 id 子串匹配：
            // `id.includes('react')` 这类写法会把任何路径里恰好带 react 字样的包
            // （例如未来的 react-something）误吞进 react chunk，拆包结果不可预期。
            // 只有下面两张清单里的包名才会被单独分块。
            if (ECHARTS_PKGS.has(pkg)) {
              return 'echarts-vendor';
            }
            if (REACT_PKGS.has(pkg)) {
              return 'react-vendor';
            }
            // 其余第三方依赖
            return 'vendor';
          }
          // 应用内模块（非 node_modules）：报告组件单独成块（见 REPORT_COMPONENTS）
          const normalizedId = id.replace(/\\/g, '/');
          const componentMatch = /\/src\/components\/([^/]+)\.tsx$/.exec(normalizedId);
          if (componentMatch && REPORT_COMPONENTS.has(componentMatch[1])) {
            return 'report';
          }
          return undefined;
        },
      },
    },
  },
});

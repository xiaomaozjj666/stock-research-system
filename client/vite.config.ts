import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React 运行时单独成块。react-is 显式列出：它以前是被 `id.includes('react')`
// 顺带捞进来的，保留在清单里才能保持原有分块形状不变。
const REACT_PKGS = new Set(['react', 'react-dom', 'react-is', 'scheduler']);

// ECharts 及其渲染依赖 zrender 单独成块
const ECHARTS_PKGS = new Set(['echarts', 'zrender']);

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

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // 固定用 127.0.0.1：后端默认只绑回环地址，而 Node 解析 localhost 时可能优先取
        // IPv6 的 ::1，届时代理会 ECONNREFUSED（表现为 502）。
        target: 'http://127.0.0.1:3001',
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
                ? '无法连接后端服务（localhost:3001），请确认服务已启动'
                : `代理请求失败：${err.message}`;
            console.error(`[vite-proxy] ${req.method} ${req.url} -> ${msg}`);
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: msg, code: code ?? 'PROXY_ERROR' }));
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
          if (!pkg) return;
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
        },
      },
    },
  },
});

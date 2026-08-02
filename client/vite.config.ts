import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
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
    emptyOutDir: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // 将第三方依赖拆分为独立 chunk，提升长期缓存命中率
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // ECharts 及其渲染依赖 zrender 单独成块
            if (id.includes('echarts') || id.includes('zrender')) {
              return 'echarts-vendor';
            }
            // React 运行时单独成块
            if (id.includes('react') || id.includes('scheduler')) {
              return 'react-vendor';
            }
            // 其余第三方依赖
            return 'vendor';
          }
        },
      },
    },
  },
});

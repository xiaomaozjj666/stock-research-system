import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/src/**/*.test.ts', 'client/src/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['./client/src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: [
        'server/src/**/*.ts',
        'client/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'server/src/index.ts', // Express 路由/中间件，由集成与手动验证覆盖
        'server/src/llm/**', // 外部 LLM 调用，网络相关，单独集成测试覆盖
        'server/src/quant/**', // K线/回测，重度依赖行情网络，单测价值低
        'client/src/main.tsx',
        'client/src/vite-env.d.ts',
      ],
    },
  },
  resolve: {
    // 允许测试中以 .js 扩展名引用 TS 源文件（与项目 NodeNext 约定一致），
    // 同时支持客户端 extensionless 的 .tsx/.jsx 组件导入
    extensions: ['.ts', '.js', '.mts', '.mjs', '.tsx', '.jsx', '.json'],
  },
});

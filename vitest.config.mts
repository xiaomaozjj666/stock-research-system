import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/src/**/*.test.ts', 'client/src/**/*.test.{ts,tsx}'],
    globals: false,
    // 锁定 NODE_ENV=test：index.ts 在 NODE_ENV!=='test' 时会 app.listen 监听端口，
    // 测试经 supertest 直接引用导出的 app，不应真正监听，否则进程不退出。
    // RATE_LIMIT_MAX_WATCHLIST 在测试中放大，避免批量回测端到端集成测试触发限流（429）。
    env: { NODE_ENV: 'test', RATE_LIMIT_MAX_WATCHLIST: '100' },
    setupFiles: ['./client/src/test/setup.ts', './server/src/test/setup.ts'],
    // 默认 hookTimeout 是 10s。本项目会在 hook 里做文件系统清理（fs.rmSync 递归删临时目录、
    // 重置语料缓存），而 Windows 上 dev 环境一次要 spawn 240+ 个 worker，磁盘 I/O 争抢下
    // 这些 hook 会偶发超过 10s——表现为 auditLog.persistence / rag.corpus 等**与业务无关**的
    // 文件随机红（单独跑必绿）。本地与 CI 都会中招，且因为是随机项很难定位。
    //
    // 这里放宽到 60s：清理类 hook 慢于 10s 属于环境噪声而非卡死。
    hookTimeout: 60000,
    // testTimeout 同理，默认 5s 对本项目偏紧。`npm run test:coverage` 会额外挂 v8
    // 插桩，单测执行普遍变慢一倍以上，磁盘密集的用例（paperTrading 快照往返、
    // fileCachePrune 批量淘汰）因此在全量跑时会顶穿 5s —— 同样是单独跑必绿。
    // 放宽不掩盖真卡死：真死循环的用例不会返回，仍会被整体超时或 CI job timeout 兜住。
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      // json-summary 供 CI 读取整体覆盖率；text-summary 在终端直接打印
      reporter: ['html', 'text-summary', 'json-summary', 'lcov'],
      include: ['server/src/**/*.ts', 'client/src/**/*.{ts,tsx}'],
      // 覆盖率阈值门禁：低于阈值测试失败，防止覆盖率倒退。
      // 基线（2026-08-13，793 tests）：lines 71.99% / statements 70.67% / functions 63.76% / branches 56.55%
      // 基线（2026-09-17，2890 tests / 212 files，routes/ 被排除在分母外）：
      //   lines 94.39% / statements 92.34% / functions 94.32% / branches 82.51%
      // 现基线（2026-09-28，3239+ tests / 235 files，**routes/ 已纳入分母**）：
      //   lines 93.66% / statements 91.76% / functions 93.97% / branches 81.88%
      // 上一版把 server/src/routes/**（13 个文件、3758 行，含 2100+ 行的 quant.ts）
      // 整目录排除在分母外，理由是「由 supertest 集成测试覆盖」——但排除意味着**这些行
      // 不占分母，也就不构成门禁**：体量最大的业务逻辑文件恰好落在门禁盲区里。
      // 实测纳入后仅下降约 1.3 个点且四项阈值仍全部通过，说明该目录本就由
      // server/src/__tests__/*.routes.test.ts 的 supertest 用例真实覆盖。
      // 阈值留约 1.5 个点余量，避免与业务无关的小改动动辄失败。
      thresholds: {
        lines: 92,
        statements: 90,
        functions: 92,
        branches: 80,
      },
      exclude: [
        // 测试文件本身不计入覆盖率：此前只写了 .ts，导致 41 个 .test.tsx 被算进分母
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        'server/src/index.ts', // Express 入口（app 组装 + listen + 优雅关闭），由集成与手动验证覆盖
        'server/src/middleware.ts', // 中间件（限流/熔断/安全头），由集成测试覆盖
        // llm/ 目录中仅排除真实网络/子进程模块；rag/prompts/tools/knowledgeGraph 等
        // 纯逻辑模块已有单测，必须纳入覆盖率统计（整目录排除会让门禁形同虚设）
        'server/src/llm/client.ts',
        'server/src/llm/mcpClient.ts',
        'server/src/llm/expertRunner.ts', // LLM 编排，网络相关
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

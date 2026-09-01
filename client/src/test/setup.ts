import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// 每个测试后清理 jsdom 渲染树，避免多 render 的 DOM 在用例间累积。
// 注意：vitest.config.mts 中 setupFiles 对 server+client 全局生效（单配置覆盖工作区），
// server 测试运行在 environment=node（无 jsdom），此时顶层调用 afterEach() 会因「找不到 suite 上下文」
// 抛错并让 70+ 个 server 测试文件全部加载失败（Test Files N failed / Tests no tests）。
// 防御：仅在存在 DOM 的环境下注册 afterEach。
if (typeof document !== 'undefined') {
  afterEach(() => {
    cleanup();
  });
}

import { afterEach } from 'vitest';

// 每个测试后清理 jsdom 渲染树，避免多 render 的 DOM 在用例间累积
afterEach(async () => {
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});

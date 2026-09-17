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

  // jsdom 没有实现 scrollIntoView，而股票搜索类组件在键盘上下键高亮时会调用它
  // （把高亮项滚进可视区）。缺这个桩会让 ArrowDown 直接抛 TypeError。
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  // jsdom 也没有 ResizeObserver / matchMedia，而 EChart 的 useEffect 会 new ResizeObserver、
  // useReducedMotion 会读 matchMedia。用例内自行 stub 再在 afterEach 里 unstub 时，
  // 若某个被动 effect 被推迟到该 afterEach 之后才冲刷，就会抛
  // "ResizeObserver is not defined"——表现为跨文件的随机失败。
  // 这里给整个 jsdom 测试环境兜一层默认实现：用例自己的 vi.stubGlobal 仍然优先生效，
  // unstub 后回落到这层默认值（matches:false 与常规桌面默认一致）。
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!('matchMedia' in globalThis)) {
    globalThis.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
  }
}

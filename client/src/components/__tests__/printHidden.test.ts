import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * .no-print 钩子与 @media print 隐藏清单的相容性（源码级）
 * ----------------------------------------------------------------------------
 * 上轮加了 `.no-print{display:none!important}` 却没有任何组件使用，这条规则形同虚设；
 * 本轮给报告头按钮、图表工具条、失败列重试、搜索历史管理动作都挂上了 `.no-print`
 * （DOM 断言见 ReportHeader / PriceTrendChart / ComparisonView / StockSelector 的测试）。
 * 这里守住两个容易回归的点：
 *   1. `.no-print` 必须只在打印上下文里生效——若哪天挪到屏幕样式里，页面上会直接少按钮；
 *   2. `.no-print` 的规则只能声明 display:none，不能与打印清单里"要显示"的规则打架。
 */

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf-8');

/** 去掉注释后再断言：注释里会引用旧写法，不剥离就会被自己的注释绊倒 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取 @media print { ... } 整块（按花括号配对，避免把后面的规则也吞进来） */
function printBlock(src: string): string {
  const start = src.indexOf('@media print');
  expect(start, 'index.css 里找不到 @media print 块').toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('@media print 花括号未配对');
}

const code = stripComments(css);
const print = printBlock(code);

describe('.no-print 打印钩子', () => {
  it('在 @media print 内定义为 display: none !important', () => {
    expect(print).toMatch(/\.no-print\s*\{[^}]*display:\s*none\s*!important/);
  });

  it('屏幕样式里不出现 .no-print（否则页面上会真的少掉按钮）', () => {
    const outside = code.split(print).join('');

    expect(outside).not.toContain('.no-print');
  });

  it('所有含 .no-print 的规则都只声明 display: none，不存在"显示"型冲突', () => {
    const rules = [...code.matchAll(/([^{}]*\.no-print[^{}]*)\{([^}]*)\}/g)].map((m) => ({
      selector: m[1].trim(),
      body: m[2],
    }));

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.selector, `选择器不该同时挂到 .print-only: ${rule.selector}`).not.toContain(
        '.print-only',
      );
      expect(rule.body).toMatch(/display:\s*none/);
      // 除掉 display:none 之后不该还有别的 display 声明（否则就是"又要隐藏又要显示"的冲突）
      const rest = rule.body.replace(/display:\s*none(\s*!important)?/g, '');
      expect(rest, `规则里出现非 none 的 display: ${rule.body}`).not.toMatch(/display\s*:/);
    }
  });

  it('打印清单仍然按类名隐藏同一批交互元素（与 .no-print 双保险，不互相取消）', () => {
    for (const cls of [
      '.btn',
      '.btn-ghost',
      '.cmp-fail-retry',
      '.search-history-clear',
      '.delete-btn',
      '.trend-controls',
      '.history-actions',
      '.history-delete',
    ]) {
      expect(print, `打印清单缺少 ${cls}`).toContain(cls);
    }
  });

  it('.print-only 与 .no-print 语义相反且互不干扰（前者只用于将来"仅打印可见"的补充信息）', () => {
    expect(print).toMatch(/\.print-only\s*\{[^}]*display:\s*block\s*!important/);
    expect(print).not.toMatch(/\.print-only[^{]*\.no-print/);
  });
});

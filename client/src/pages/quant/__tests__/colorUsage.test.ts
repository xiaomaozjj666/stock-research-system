import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * 着色口径防回归（源码级）
 * ----------------------------------------------------------------------------
 * 为什么不做 DOM 级用例：这三个面板是"表单 + 分钟级异步任务 + Toast 上下文"的重组件，
 * 要渲染出收益单元格得先跑完整评估流程（mock 十几个接口），成本远高于收益。
 * 而被修的缺陷本身是"用错了哪个类名"，源码级断言既能精确覆盖，又能防止回退。
 *
 * 规则：表示收益/涨跌/方向的位置用 signCls（val-*，红涨绿跌），
 *      表示统计显著/OOS 通过的位置用 significanceCls（sig-*，色板语义不变）；
 *      两者都不允许在 JSX 里写裸字面量。
 */
const FILES = {
  CrossSectionPanel: '../CrossSectionPanel.tsx',
  FactorLabPanel: '../FactorLabPanel.tsx',
  CompositeBatchPanel: '../CompositeBatchPanel.tsx',
} as const;

function read(name: keyof typeof FILES): string {
  return readFileSync(fileURLToPath(new URL(FILES[name], import.meta.url)), 'utf-8');
}

function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/**
 * 去掉注释后再断言：说明性注释里会写旧写法本身（如 positive:true / sig-valid），
 * 不剥离就会"被自己的注释绊倒"。（`//` 前是冒号的 https:// 不误伤）
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('量化面板着色口径（signCls / significanceCls）', () => {
  for (const name of Object.keys(FILES) as (keyof typeof FILES)[]) {
    it(`${name}：不再出现裸的 .sig-* 字面量（显著性也要走统一入口）`, () => {
      const src = read(name);
      expect(src).not.toContain("'sig-valid'");
      expect(src).not.toContain("'sig-inverted'");
      expect(src).not.toContain("'sig-none'");
      expect(src).toContain("from '../../lib/colors'");
    });
  }

  it('CrossSectionPanel：收益用例走 signCls，显著性走 significanceCls', () => {
    const src = read('CrossSectionPanel');
    // 组合回测「总收益」列 + IC 单元格（显著 + 方向）
    expect(count(src, 'signCls(')).toBeGreaterThanOrEqual(1);
    expect(count(src, 'significanceCls(')).toBeGreaterThanOrEqual(2);
    // 旧写法（正收益显示成绿色）不得复活
    expect(code(src)).not.toMatch(/totalReturn\s*>=\s*0\s*\?\s*'sig-/);
  });

  it('FactorLabPanel：总收益/IC 均值走 signCls，采信判定走 significanceCls', () => {
    const src = read('FactorLabPanel');
    expect(count(src, 'signCls(')).toBeGreaterThanOrEqual(2);
    expect(count(src, 'significanceCls(')).toBeGreaterThanOrEqual(2);
    expect(code(src)).not.toMatch(/totalReturn\s*>=\s*0\s*\?\s*'sig-/);
    expect(code(src)).not.toMatch(/icMean\s*>=\s*0\s*\?\s*'sig-/);
  });

  it('CompositeBatchPanel：看多/看空方向走 signCls（up = 红），不再用显著性色板', () => {
    const src = read('CompositeBatchPanel');
    expect(count(src, 'signCls(')).toBeGreaterThanOrEqual(1);
    expect(src).not.toMatch(/d === 'up' \? 'sig-/);
  });

  it('BacktestChart：涨跌色表达好坏的位置已改中性（交易次数/最大回撤）', () => {
    const src = code(
      readFileSync(fileURLToPath(new URL('../BacktestChart.tsx', import.meta.url)), 'utf-8'),
    );
    expect(src).not.toMatch(/positive:\s*(true|false)/);
    expect(src).toContain("tone: 'val-warn'"); // 最大回撤 = 风险琥珀
    expect(src).toContain('signCls(data.totalReturn)');
  });
});

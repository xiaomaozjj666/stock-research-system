import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 类型逃逸的守门测试
 * ============================================================================
 * 逃逸（`as any` / `: any` / `as never`）的危害不是「不好看」，而是**让类型系统对
 * 某段代码彻底失明**：
 *
 *   - `as any`（生产代码）：`n.title` 在上游字段改名后**静默变成 undefined**，
 *     编译期无提示，运行时表现为「标题全空」这类难查问题。
 *   - `as never`（测试桩）：桩只造 2-3 个字段再蒙混，于是用例只验自己造的
 *     那几个字段 —— 真实结构改了，测试照样绿。本项目接入契约校验时抓到的
 *     6 处「桩 ≠ 契约」，全部是这种写法造成的。
 *
 * 所以本守卫**限增量**：存量给出豁免清单（逐条附理由），增量一律拦住。
 * 不追求存量归零 —— 那是与当前目标无关的大重构；但不许再涨。
 *
 * ── 覆盖范围的一处教训 ──
 * 第一版只匹配 `as any` / `as never`，反向验证时注入 `const _x: any = ...`
 * **竟然没被拦** —— 正则漏了「类型标注」这一形式，而它恰恰是生产代码里更常见的
 * 逃逸写法。现在的正则覆盖：as any / as never / `: any` 标注 / `any[]` /
 * `Array<any>` / `<any>`。**守卫的正则本身也需要反向验证**，否则它就是
 * 一条自己都测不准的守卫。
 */

/** 只扫生产代码：server/src 与 client/src 下非 *.test.* 的 .ts/.tsx */
const SRC_ROOTS = ['server/src', 'client/src'] as const;

/**
 * 逃逸形式。分两组：
 *  - HARD：完全放弃类型检查（any 家族、never）—— 原则上禁止
 *  - SOFT：`as unknown as X`（经 unknown 二次断言）—— 是**依赖注入的类型擦除**，
 *    本项目里合法且必要（模块替身、动态 import），故只统计不禁止。
 */
const HARD_ESCAPES: { name: string; re: RegExp }[] = [
  { name: 'as any', re: /\bas\s+any\b/g },
  { name: 'as never', re: /\bas\s+never\b/g },
  { name: ': any 标注', re: /:\s*any\s*[;,)=]/g },
  { name: 'any[]', re: /\bany\s*\[\]/g },
  { name: 'Array<any>', re: /Array\s*<\s*any\s*>/g },
  { name: '<any>', re: /<\s*any\s*>/g },
];
const SOFT_ESCAPES: { name: string; re: RegExp }[] = [
  { name: 'as unknown as', re: /\bas\s+unknown\s+as\b/g },
];

const EXEMPT = new Set<string>([
  // 测试基础设施：它们要在 unknown 与具体类型之间来回转换，正是本守卫要检查
  // 的那类转换，写死类型反而更不安全。
  'server/src/test/contractSupertest.ts',
  'server/src/test/contractFixtures.ts',
  'server/src/test/contractSchema.ts',
  // 泛型收窄技巧：`settle(fn: (v: never) => void, value: unknown)` 用 never
  // 作参数以禁止外部直接调用。改成 unknown 会让 settle 接受任意参数，
  // 反而削弱约束。
  'server/src/utils/timeout.ts',
  // 第三方库类型噪声：echarts 的 ComposeOption 与我们构造的 option 在
  // 字面量量纲上有细微差异，属库的已知问题而非业务风险。
  'client/src/components/EChart.tsx',
]);

/** 剥掉注释与字符串字面量，避免「文档里解释 as any 的害处」被算成一处逃逸 */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(name.name) && !/\.test\.tsx?$/.test(name.name)) acc.push(full);
  }
  return acc;
}

describe('生产代码不得逃逸类型', () => {
  it('server/src 与 client/src 的非测试文件里没有硬逃逸（any 家族 / as never）', () => {
    const offenders: string[] = [];
    for (const f of SRC_ROOTS.flatMap((r) => walk(r))) {
      const norm = f.replace(/\\/g, '/');
      if (EXEMPT.has(norm)) continue;
      const code = stripNonCode(readFileSync(f, 'utf-8'));
      for (const { name, re } of HARD_ESCAPES) {
        const n = (code.match(re) ?? []).length;
        if (n > 0) offenders.push(`${norm}：${name} × ${n}`);
      }
    }
    expect(
      offenders,
      '生产代码出现硬类型逃逸。\n' +
        '· 上游 JSON 用 `unknown` + 收窄助手（不要 any）\n' +
        '· 枚举用字面量联合 + 运行时 includes 校验（不要 as never）\n' +
        '· 确有必要时写进本测试的 EXEMPT 清单并注明理由\n' +
        `发现：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('软逃逸（as unknown as）保持在基线内 —— 用于依赖注入的类型擦除', () => {
    // 这些是模块替身 / 动态 import 的必要代价，禁不掉；但**不许增长**：
    // 增长通常意味着有人在用 as unknown as 掩盖真实的不兼容。
    const BASELINE = 10;
    let total = 0;
    const perFile: string[] = [];
    for (const f of SRC_ROOTS.flatMap((r) => walk(r))) {
      const norm = f.replace(/\\/g, '/');
      if (EXEMPT.has(norm)) continue;
      const code = stripNonCode(readFileSync(f, 'utf-8'));
      let n = 0;
      for (const { re } of SOFT_ESCAPES) n += (code.match(re) ?? []).length;
      if (n > 0) {
        total += n;
        perFile.push(`${norm}: ${n}`);
      }
    }
    expect(
      total,
      `生产代码 as unknown as 共 ${total} 处（基线 ${BASELINE}），只许减不许增。\n` +
        '若确实需要新增（如新的动态 import），请在提交信息里说明理由。\n' +
        `分布：\n${perFile.join('\n')}`,
    ).toBeLessThanOrEqual(BASELINE);
  });
});

describe('测试里的类型逃逸不增不减', () => {
  /** 基线：2026-10-05 实测。改动此数字必须同步下方说明 */
  const BASELINE = 82;

  it('server 测试里 as never 的总数不超过基线（只许减不许增）', () => {
    const dir = join('server', 'src', '__tests__');
    let total = 0;
    const perFile: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.ts'))) {
      const code = stripNonCode(readFileSync(join(dir, f), 'utf-8'));
      const n = (code.match(/\bas\s+never\b/g) ?? []).length;
      if (n > 0) {
        total += n;
        perFile.push(`${f}: ${n}`);
      }
    }
    expect(
      total,
      `server 测试里 as never 共 ${total} 处，基线 ${BASELINE}。\n` +
        '只允许减少：把桩改用 test/contractFixtures.ts 的完整形状工厂即可去掉一个。\n' +
        `分布：\n${perFile.join('\n')}`,
    ).toBeLessThanOrEqual(BASELINE);
  });
});

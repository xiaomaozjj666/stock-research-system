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
  // 本文件自身：`as never` 只出现在正则 `/\bas\s+never\b/g` 与失败文案里，
  // 统计时会把自己算进去（那 3 处不是真的类型逃逸）。
  'server/src/test/__tests__/typeEscape.test.ts',
  // 测试基础设施：它们要在 unknown 与具体类型之间来回转换，正是本守卫要检查
  // 的那类转换，写死类型反而更不安全。
  'server/src/test/contractSupertest.ts',
  'server/src/test/contractFixtures.ts',
  'server/src/test/contractSchema.ts',
  'server/src/test/partial.ts',
  'server/src/test/depStubs.ts',
  // 前端测试基建：jsdom 缺失的全局（ResizeObserver / matchMedia）只能造形状不全的
  // 替身。它虽不是 *.test.ts，但性质与 partial.ts 相同——按「文件名排除测试」
  // 的规则会被误算进生产代码。
  'client/src/test/setup.ts',
  'client/src/test/partial.ts',
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

/**
 * 收集目录下的 .ts/.tsx。
 *
 * @param includeTests 传 true 时**包含** `*.test.ts`；默认 false（只取生产代码）。
 *   两者不可混用：2026-10-06 发现「测试里的 as never」那条守卫复用了本函数的
 *   默认形态（排除测试文件），于是遍历结果恒为空、`total` 恒为 0、**守卫恒绿**。
 *   注入一处 `as never` 也照样通过——是「反向验证」把它揪出来的。
 */
function walk(dir: string, acc: string[] = [], includeTests = false): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walk(full, acc, includeTests);
    else if (/\.tsx?$/.test(name.name) && (includeTests || !/\.test\.tsx?$/.test(name.name)))
      acc.push(full);
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
    // 2026-10-06 从 10 降到 1。逐处核实后，9 处断言在掩盖真实问题，已修掉：
    //   · quantOps：parseStrategyInput 本就返回 StrategyConfig，断言纯属多余
    //   · analysisPipeline：`undefined as unknown as Promise<...>` 是一句类型谎言
    //     （构造时该字段真为 undefined），改为可选 + 读取处 `!`
    //   · crossSectionBuilder：Object.fromEntries 无法表达键的字面量联合，
    //     改用带显式累加器类型的 reduce（顺带让新增因子漏初始化会报错）
    //   · TodayPanel：自定义了字段更松的局部 AlertItem 再断言转换，
    //     改用契约生成的 WatchlistAlert
    //   · chatAgent + llm/tools：**最有价值的一处** —— runBacktest 声明成
    //     `(unknown, unknown) => Promise<unknown>`，而真实实现是
    //     `(OHLCVData[], StrategyConfig) => BacktestResult`（**同步**返回）。
    //     签名收紧后 tsc 逐条报出 8 处不符的测试桩，全部在撒谎（谎称异步、
    //     缺必填字段），一并修正。**软逃逸本身是发现这些的入口。**
    //
    // 唯一保留的 1 处：`quant/pdfExtract.ts` 用 `await import(spec)` 动态加载
    // **可选依赖** pdfjs-dist（未安装时 tsc/构建不能失败），specifier 存于变量
    // 以免被静态解析。此时 import 的返回值只能是 any，断言用于收窄到手写形状 ——
    // 属真正的类型擦除，无法消除。
    const BASELINE = 1;
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
  /**
   * 基线：2026-10-06 实测 **111**（范围：server/src + client/src + e2e 下全部
   * `*.test.ts` / `*.test.tsx`，剥注释与字符串后）。
   *
   * ── 这个数字改过两次，每次都是因为「守卫自己测不准」 ──
   *  1. 第一版写 **82**：统计范围用了 `server/src/**` 全递归，而守卫实际只扫
   *     `server/src/__tests__/` 顶层。**基线虚高 = 门槛形同虚设**，涨到 82 都不红。
   *  2. 第二版写 **25**：把范围收窄成顶层目录「对齐实际扫描逻辑」。看似修好了，
   *     实则更糟 —— 范围外的 `llm/__tests__`、`quant/__tests__`、
   *     `services/__tests__`、`client/src/**` 全都**不被任何守卫覆盖**，
   *     合计 86 处逃逸处于无人看管状态。这与上轮「正则漏了 `: any`」是
   *     同一个错误的两种形态：**先让守卫能测准，再谈基线数字**。
   *
   * 现在改为**全量测试文件**统一统计，范围与实际扫描逻辑一致。
   * 真实存量 114 处，其中 `typeEscape.test.ts` 自身 3 处是正则/字符串字面量
   * （`/\bas\s+never\b/g` 与文案），已计入 EXEMPT，故基线 111。
   *
   * 114 处的性质（2026-10-06 逐文件分类）：绝大多数是「构造不完整的对象喂给
   * mock 或 express 中间件」。解法不是加豁免，而是补基础设施 + 补桩形状：
   *   · express req/res 桩 → `test/partial.ts` 的 `reqOf` / `mwReq` / `mwRes`
   *   · 业务对象桩 → 补全必填字段并标注真实返回类型（tsc 会精确报出缺哪个）
   *   · `deferred<never>()` → 改成 `deferred<HistoryItem>()` 等真实类型，
   *     否则 resolve/returnValue 每处都得 `as never` 蒙混
   *
   * ── 最终结果：114 → 0 ──
   * 存量已全部清零，基线设为 **0**：从「不许增长」升级为「一旦出现即失败」。
   * 这也是清理过程最有价值的部分——每清一处，tsc 都会精确报出被 `as never`
   * 掩盖的真实问题（缺失的必填字段、多余的残留字段、类型不匹配的桩）。
   *
   * 新增基础设施（清理的产物，长期价值高于清理本身）：
   *  · `server/src/test/partial.ts` —— partial / partialList / reqOf / mwReq /
   *    mwRes / jsonResponse，把「构造不完整的测试替身」的类型擦除集中到一处
   *  · `client/src/test/partial.ts` —— 前端对等实现
   *  · `contractFixtures.analysisResult` 返回类型由 `Record<string, unknown>`
   *    改为 `AnalysisResult`，工厂自身开始受编译器约束
   *
   * ── 清理过程本身又抓到两类假绿灯，值得记下来 ──
   *  1. `as never` 换成 `partial<T>()` 后**忘了加 import**：`jsonResponse` 未定义，
   *     ReferenceError 被被测代码的 catch 吞掉 → 走「降级模拟数据」分支 →
   *     用例仍绿但拿到的是 9 条 `isSimulated: true` 的假数据。**清完必须立刻
   *     跑 typecheck**，否则未定义符号会伪装成「降级路径正常」。
   *  2. `partial.ts` 里 `Request`/`Response` 同时匹配 express 与 DOM 两个同名
   *     类型，编译报「缺 93 个属性」且方向完全误导。已显式
   *     `import type { Request, Response } from 'express'`，fetch 桩另用
   *     `FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>`。
   */
  const BASELINE = 0;

  it('全部测试文件里 as never 的总数不超过基线（只许减不许增）', () => {
    const TEST_ROOTS = ['server/src', 'client/src', 'e2e'];
    let total = 0;
    const perFile: string[] = [];
    // includeTests=true 是关键：默认形态会把测试文件全部过滤掉，
    // 让本守卫在空集合上「通过」（见 walk 的注释）。
    for (const f of TEST_ROOTS.flatMap((r) => walk(r, [], true)).filter((p) =>
      /\.test\.tsx?$/.test(p),
    )) {
      const norm = f.replace(/\\/g, '/');
      if (EXEMPT.has(norm)) continue;
      const code = stripNonCode(readFileSync(f, 'utf-8'));
      const n = (code.match(/\bas\s+never\b/g) ?? []).length;
      if (n > 0) {
        total += n;
        perFile.push(`${norm}: ${n}`);
      }
    }
    perFile.sort();
    expect(
      total,
      `测试里 as never 共 ${total} 处，基线 ${BASELINE}。\n` +
        '测试代码不得再出现 as never。构造不完整的对象请走 test/partial.ts 的\n' +
        '  partial<T>(...) / reqOf / mwReq / mwRes / jsonResponse，或\n' +
        '  test/contractFixtures.ts 的完整形状工厂。\n' +
        `分布：\n${perFile.join('\n')}`,
    ).toBeLessThanOrEqual(BASELINE);
  });
});

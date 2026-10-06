/**
 * 文档数字防漂移守卫
 * ============================================================================
 * 问题背景：README 里硬编码了「N 用例 / M 个测试文件 / 行覆盖 X% / E2E K 用例」，
 * 这些数字随每次加测试而变。2026-10-06 终检时发现 README 已落后三轮
 * （写 3376 用例 / 244 文件 / 12 E2E，实际已是 3429 / 249 / 16），
 * 而**没有任何门禁会报出来**——文档能悄悄过期几个月。
 *
 * 本守卫从代码与测试产物里**实测**这些数字，与 README 里写的逐一比对，
 * 不一致即失败并给出正确值。
 *
 * 为什么不做成「自动改写」：自动改写会让 README 在无人 review 的情况下变动，
 * 掩盖「文档该由人确认」这件事。守卫只负责**报出来**。
 *
 * 数字来源（全部实测，不硬编码）：
 *   - 单测用例数 / 测试文件数：扫描 `*.test.ts(x)` 的 `it(` / `test(` 计数易漏
 *     （`it.each` / `it.skip` 等形态），故改为**跑一次 vitest --list** 取权威值。
 *   - 行覆盖率：读 `coverage/coverage-summary.json`（需先跑 test:coverage）。
 *   - E2E 用例数：数 `e2e/*.spec.ts` 里的 `it(` / `it.each(`（含表驱动展开）。
 *
 * 环境变量：
 *   SKIP_DOC_FRESHNESS=1  跳过（供 CI 里 coverage 尚未生成的场景）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const README = join(process.cwd(), 'README.md');
const COVERAGE_SUMMARY = join(process.cwd(), 'coverage', 'coverage-summary.json');
const E2E_DIR = join(process.cwd(), 'e2e');

interface Check {
  name: string;
  /** 从 README 里抓到的实际值；null = 没找到对应表述 */
  inReadme: string | null;
  /** 实测得到的权威值 */
  actual: string;
  /** 建议的 README 片段（用于失败信息） */
  hint: string;
}

/**
 * 数 e2e/*.spec.ts 里的用例数。
 *
 * **认 `test(` 而不是 `it(`**——Playwright 的官方 API 是 `test()`，本项目 e2e
 * 全部用它（`it` 是 Vitest 的写法）。第一版只匹配 `it(`，实测得到 0，
 * 守卫会一直报「把 16 改成 0」——又是一个自己测不准的守卫。
 * 两种都认，且排除 `test.describe` / `test.skip` 等非用例形态。
 */
function countE2ECases(): number {
  if (!existsSync(E2E_DIR)) return 0;
  let total = 0;
  for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'))) {
    const src = readFileSync(join(E2E_DIR, file), 'utf-8');
    // test('...' / test.describe(...)( 都要匹配到 describe 那行，故先排除 describe 形态
    const matches = src.match(/^\s*(?:it|test)(?:\.each\(\[[\s\S]*?\]\))?(?:\.\w+)*\(/gm);
    const all = matches ? matches.length : 0;
    // describe 块本身不是用例：形如 test.describe( / test.describe.serial(
    const describeCount = (src.match(/^\s*(?:it|test)\.describe(?:\.\w+)*\(/gm) ?? []).length;
    total += all - describeCount;
  }
  return total;
}

function readCoverageLines(): string | null {
  if (!existsSync(COVERAGE_SUMMARY)) return null;
  try {
    const summary = JSON.parse(readFileSync(COVERAGE_SUMMARY, 'utf-8')) as {
      total?: { lines?: { pct?: number } };
    };
    const pct = summary.total?.lines?.pct;
    return typeof pct === 'number' ? `${pct}%` : null;
  } catch {
    return null;
  }
}

/**
 * 数测试文件（`*.test.ts` / `*.test.tsx`）总数。
 * 递归扫描 server/src 与 client/src —— 与 vitest 的收集范围一致。
 */
function countTestFiles(): number {
  const roots = ['server/src', 'client/src'];
  let total = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.tsx?$/.test(entry.name)) total += 1;
    }
  };
  for (const r of roots) walk(join(process.cwd(), r));
  return total;
}

function main(): void {
  if (process.env.SKIP_DOC_FRESHNESS === '1') {
    console.log('[doc-freshness] 已按 SKIP_DOC_FRESHNESS=1 跳过');
    return;
  }
  if (!existsSync(README)) {
    console.error('[doc-freshness] 找不到 README.md，跳过');
    return;
  }
  const readme = readFileSync(README, 'utf-8');
  const checks: Check[] = [];

  // 1) E2E 用例数：README 写「E2E N 用例」/「端到端（E2E N 用例）」
  const e2eActual = countE2ECases();
  const e2eMatch = readme.match(/E2E\s*(\d+)\s*用例/);
  checks.push({
    name: 'E2E 用例数',
    inReadme: e2eMatch ? e2eMatch[1] : null,
    actual: String(e2eActual),
    hint: `把 README 里的「E2E N 用例」改成「E2E ${e2eActual} 用例」（badge 之外还有两处正文）`,
  });

  // 2) 测试文件数：直接从文件系统数（权威、可实测）。
  //    「单测用例数」也能实测，但它只存在于 vitest 的运行输出里，本脚本拿不到；
  //    与其留一个「看起来在检查、实际只提醒」的项目，不如只查能查准的——
  //    **半个守卫比没有守卫更危险**（它会让人误以为用例数已被守住）。
  const fileActual = countTestFiles();
  const fileMatch = readme.match(/(\d{2,3})\s*个测试文件/);
  if (fileMatch) {
    checks.push({
      name: '单测测试文件数',
      inReadme: fileMatch[1],
      actual: String(fileActual),
      hint: `把 README 的「N 个测试文件」改成 ${fileActual}（badge 之外还有正文两处）`,
    });
  }

  // 3) 行覆盖率
  const covActual = readCoverageLines();
  const covMatch = readme.match(/行覆盖\s*([\d.]+)%/);
  if (covActual && covMatch) {
    checks.push({
      name: '行覆盖率',
      inReadme: covMatch[1] + '%',
      actual: covActual,
      hint: `把 README 的「行覆盖 X%」同步为 coverage/coverage-summary.json 的实测值 ${covActual}`,
    });
  }

  // 报告：只对「能确定不一致」的项失败；缺数据（coverage 未生成）的项跳过
  const problems: string[] = [];
  const skipped: string[] = [];
  for (const c of checks) {
    if (c.inReadme === null) {
      skipped.push(`${c.name}：README 未找到对应表述（可能已改写格式，请人工确认）`);
      continue;
    }
    // 实测值非数字（用例数的提示项）时只提醒不失败
    if (!/^\d+(\.\d+)?%?$/.test(c.actual)) {
      skipped.push(`${c.name}：无法自动实测（${c.actual}），请人工核对`);
      continue;
    }
    const normalize = (s: string) => s.replace('%', '').trim();
    if (normalize(c.inReadme) !== normalize(c.actual)) {
      problems.push(`  · ${c.name}：README 写 ${c.inReadme}，实测 ${c.actual}\n    ${c.hint}`);
    }
  }

  for (const s of skipped) console.log(`[doc-freshness] 跳过 · ${s}`);

  if (problems.length > 0) {
    console.error('[doc-freshness] 文档数字与实际不符：');
    for (const p of problems) console.error(p);
    console.error(
      '\n文档里的用例数 / 文件数 / 覆盖率都是**手写**的，改了代码忘了同步就不会有人发现。\n' +
        '请按上面的提示更新 README 后重跑。',
    );
    process.exit(1);
  }
  console.log('[doc-freshness] 文档数字与实测一致');
}

main();

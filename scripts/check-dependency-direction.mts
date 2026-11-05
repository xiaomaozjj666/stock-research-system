/**
 * 依赖方向校验（CI 门禁）：禁止 quant/shared 反向依赖 services
 * ----------------------------------------------------------------------------
 * 架构约定：shared（类型/接口/底层能力）← quant（量化引擎）← services（业务编排）
 * ← routes ← index（组合根）。此前 quant/fundamentalCache 直接 import
 * services/dataFetcher、quant/screener 直接 import services/stockMaster，
 * 与 services/analysisPipeline → quant 的依赖构成包级循环。
 *
 * 本脚本以简单静态扫描兜底（无需额外依赖）：
 * - server/src/quant/**（不含测试）：禁止任何指向 services 的 import/export/
 *   动态 import；
 * - server/src/shared/**（不含测试）：禁止**静态** import/export 指向 services；
 *   动态 import 仅允许 shared/fundamentalFetchers.ts 的兼容装配（文件内已注明）。
 * 发现违规即以非零退出并列出 file:line，防止反向依赖回潮。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/src');

interface Violation {
  file: string;
  line: number;
  text: string;
  rule: string;
}

/** 静态 import/export ... from '...' 与动态 import('...') 的目标捕获 */
const STATIC_FROM_RE = /\b(?:import|export)\b[^'"]*\bfrom\s*['"]([^'"]+)['"]/;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/;
/** 指向 services 包的相对路径（../services/、../../services/ 等） */
const SERVICES_PATH_RE = /(?:^|\.\.)\/services\//;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function checkFile(file: string, allowDynamicServices: boolean): Violation[] {
  const violations: Violation[] = [];
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  lines.forEach((text, index) => {
    const staticMatch = text.match(STATIC_FROM_RE);
    if (staticMatch && SERVICES_PATH_RE.test(staticMatch[1])) {
      violations.push({
        file,
        line: index + 1,
        text: text.trim(),
        rule: '禁止静态 import/export services（反向依赖）',
      });
    }
    const dynamicMatch = text.match(DYNAMIC_IMPORT_RE);
    if (!allowDynamicServices && dynamicMatch && SERVICES_PATH_RE.test(dynamicMatch[1])) {
      violations.push({
        file,
        line: index + 1,
        text: text.trim(),
        rule: '禁止动态 import services（反向依赖）',
      });
    }
  });
  return violations;
}

const violations: Violation[] = [];
for (const area of ['quant', 'shared'] as const) {
  const dir = path.join(SRC_ROOT, area);
  for (const file of listTsFiles(dir)) {
    // shared/fundamentalFetchers.ts 是唯一的动态装配白名单（见文件头注释）
    const allowDynamic = file.endsWith(path.join('shared', 'fundamentalFetchers.ts'));
    violations.push(...checkFile(file, allowDynamic));
  }
}

if (violations.length > 0) {
  console.error('依赖方向校验失败：quant/shared 不得反向依赖 services\n');
  for (const v of violations) {
    console.error(`  ${path.relative(process.cwd(), v.file)}:${v.line}  ${v.rule}\n    ${v.text}`);
  }
  process.exit(1);
}
console.log('依赖方向校验通过：quant/shared 未反向依赖 services');

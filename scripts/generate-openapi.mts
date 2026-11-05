/**
 * OpenAPI 文档生成与同步校验
 * ----------------------------------------------------------------------------
 * 单一事实源：server/src/services/openapi/ 下按域拆分的 paths/schemas 模块
 * （聚合入口 buildOpenApiDocument，兼容旧 import 路径 services/openapi.ts）。
 * 生成物：docs/openapi.json（供 Swagger UI / 外部代码生成器直接消费，无需起服务）。
 *
 * 用法：
 *   tsx scripts/generate-openapi.mts           重新生成 docs/openapi.json
 *   tsx scripts/generate-openapi.mts --check   只比对不写入（CI 同步门禁）
 *
 * --check 用深度相等比对「当前聚合文档」与「已提交生成物」：改了域模块却忘记
 * 重新生成时立即失败，防止契约源与生成物分叉（与 check:api-types 同一思路）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../server/src/services/openapi.js';
// 经 Prettier 格式化：生成物必须同时满足「确定性同步比对」与仓库 format:check 门禁
import { format, resolveConfig } from 'prettier';

const OUT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/openapi.json');
const checkOnly = process.argv.includes('--check');

const document = buildOpenApiDocument();

/**
 * 递归规范化对象键序：按域模块聚合后 paths/schemas 的键顺序取决于域分组，
 * 与手写单文件时代的声明顺序不同。规范化后生成物完全确定——同一契约内容
 * 永远产出同一 JSON，--check 只需字符串比对，且不受「条目在域间移动」影响。
 * （OpenAPI 语义与对象键顺序无关；数组保持原顺序。）
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// 必须携带项目 Prettier 配置（printWidth=100 等）：否则 API 默认 80 列与 CLI
// format:check 的折叠风格不一致，生成物会被格式门禁误报
const prettierConfig = await resolveConfig(OUT_FILE);
const serialized = await format(JSON.stringify(canonicalize(document), null, 2), {
  ...prettierConfig,
  parser: 'json',
});

if (checkOnly) {
  let existing = '';
  try {
    existing = readFileSync(OUT_FILE, 'utf-8');
  } catch {
    console.error(`生成物不存在：${OUT_FILE}\n请先运行 npm run generate:openapi`);
    process.exit(1);
  }
  if (existing !== serialized) {
    console.error(
      'OpenAPI 生成物与源不同步：docs/openapi.json 与 services/openapi/ 域模块聚合结果不一致。\n' +
        '请运行 npm run generate:openapi 重新生成后一并提交。',
    );
    process.exit(1);
  }
  console.log('OpenAPI 生成物与源同步（docs/openapi.json 为最新）');
} else {
  writeFileSync(OUT_FILE, serialized, 'utf-8');
  const pathCount = Object.keys(document.paths).length;
  const schemaCount = Object.keys(document.components.schemas).length;
  console.log(`已生成 docs/openapi.json（paths=${pathCount}，schemas=${schemaCount}）`);
}

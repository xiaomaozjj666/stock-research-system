/**
 * 类型生成 CLI：读契约 → 写 client/src/api/generated.ts
 * ----------------------------------------------------------------------------
 * 两种模式：
 *   node（默认）    写入生成物
 *   --check         只比对不写入，不一致则退出码 1（CI 用）
 *
 * 为什么生成物落在 client/src/api/ 而不是共享包：本仓库是 npm workspaces
 * （server + client），没有 packages/，也没有 tsconfig 的 paths / project
 * 引用。建共享包要同时接 vite alias 与 tsc project 引用，是一整套构建改动。
 * 先用单文件换零构建改动——服务端暂不复用生成类型，等真有第二消费方再升级。
 *
 * 生成物**提交进仓库**（而非 gitignore + 构建时生成）：本项目 CI 跑 typecheck
 * 与 e2e 都依赖工作区里的 client 源码，生成物入库才能让「契约↔类型」的漂移
 * 在 PR 里直接可见（diff），而不是等到构建时才炸。
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../server/src/services/openapi.js';
import { generateTypesModule } from '../server/src/services/apiTypeGen.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'client', 'src', 'api', 'generated.ts');

const check = process.argv.includes('--check');

const doc = buildOpenApiDocument() as unknown as Parameters<typeof generateTypesModule>[0];
let generated: string;
try {
  generated = generateTypesModule(doc);
} catch (error) {
  // 生成器遇到不认识的契约构造时必须硬失败：悄悄降级成 unknown 会让整套类型失去意义
  console.error('[generate-api-types] 契约含生成器无法处理的构造，已中止：');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// 与 prettier 对齐：生成物要能过 format:check，否则门禁会在格式上变红
const { format } = await import('prettier');
const prettierOpts = { parser: 'typescript', singleQuote: true, printWidth: 100 } as const;
let output: string;
try {
  output = await format(generated, prettierOpts);
} catch (error) {
  console.error('[generate-api-types] 生成结果不是合法 TS（prettier 解析失败），已中止：');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

if (check) {
  let current: string | null = null;
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* 文件不存在 → 视为不一致 */
  }
  if (current === null) {
    console.error(`[generate-api-types] 生成物不存在：${OUT}`);
    console.error('请运行：npm run generate:api-types');
    process.exit(1);
  }
  if (current !== output) {
    console.error('[generate-api-types] 生成物与契约不一致（契约已改，类型没重新生成）');
    console.error('请运行：npm run generate:api-types 并把结果一起提交');
    // 打印首个差异位置，便于定位
    const a = current.split('\n');
    const b = output.split('\n');
    const i = a.findIndex((line, idx) => line !== b[idx]);
    console.error(`首个差异在第 ${i + 1} 行：`);
    console.error(`  现有：${a[i] ?? '<EOF>'}`);
    console.error(`  应为：${b[i] ?? '<EOF>'}`);
    process.exit(1);
  }
  console.log('[generate-api-types] 生成物与契约一致');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, output, 'utf8');
  const typeCount = (output.match(/^export type /gm) ?? []).length;
  console.log(`[generate-api-types] 已写入 ${OUT}（${typeCount} 个类型）`);
}

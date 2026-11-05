/**
 * OpenAPI 一次性迁移工具：单文件（5788 行）→ 按域模块 + 单一聚合入口
 * ----------------------------------------------------------------------------
 * 实现说明：仓库锁定的 typescript@7 不再提供 JS Compiler API，因此采用
 * 「prettier 规整缩进 + 条目起始行」文本切分（paths 条目 = 6 空格 + '/api/...'，
 * schemas 条目 = 8 空格 + 标识符键），不做括号计数（字符串内花括号无需转义处理）。
 *
 * 安全网：迁移后 `npm run check:openapi` 必须深度等于迁移前生成的 docs/openapi.json
 * （先跑 generate:openapi 留基线，再跑本脚本）。幂等：发现已拆分则退出。
 *
 *   npx tsx scripts/split-openapi.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'server/src/services/openapi.ts');
const OUT_DIR = path.join(ROOT, 'server/src/services/openapi');

const text = readFileSync(SOURCE, 'utf-8');
if (text.includes('./openapi/index.js')) {
  console.log('已拆分（openapi.ts 为 re-export 入口），无需重复迁移');
  process.exit(0);
}
const lines = text.split('\n');

function mustFind(re: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  throw new Error(`定位失败: ${re} (from line ${from + 1})`);
}

// === 1. helpers：OPENAPI_VERSION 起到 buildOpenApiDocument 前的顶层 const 段 ===
const helpersStart = mustFind(/^export const OPENAPI_VERSION/);
const buildFnLine = mustFind(/^export function buildOpenApiDocument/);
const stmtStarts: number[] = [];
for (let i = helpersStart; i < buildFnLine; i++) {
  if (/^(?:export )?const \w+/.test(lines[i])) stmtStarts.push(i);
}
const helperNames: string[] = [];
const helperBlocks: string[] = [];
stmtStarts.forEach((start, idx) => {
  const end = idx + 1 < stmtStarts.length ? stmtStarts[idx + 1] : buildFnLine;
  const block = lines.slice(start, end).join('\n').replace(/\s+$/, '');
  helperBlocks.push(block);
  const name = /^(?:export )?const (\w+)/.exec(lines[start])![1];
  helperNames.push(name);
});

// === 2. return 对象：keptProps（info/tags 等）、paths 条目、schemas 条目 ===
const pathsStart = mustFind(/^ {4}paths: \{$/, buildFnLine);
const componentsStart = mustFind(/^ {4}components: \{$/, pathsStart);
const schemasStart = mustFind(/^ {6}schemas: \{$/, componentsStart);

// return { 行到 paths 前 = info/tags 等保留属性（原样含缩进）
const returnLine = mustFind(/^ {2}return \{$/, buildFnLine);
const keptProps = lines
  .slice(returnLine + 1, pathsStart)
  .join('\n')
  .replace(/,\s*$/, '');

// paths 条目区：pathsStart+1 .. paths 关闭行（4 空格 `},`）前；
// 关闭行与 components 之间可能有块注释（保留到聚合入口）
const pathsClose = mustFind(/^ {4}\},/, pathsStart + 1);
const pathsBody = lines.slice(pathsStart + 1, pathsClose);
const componentsLeading = lines.slice(pathsClose + 1, componentsStart).join('\n');
// schemas 条目区：schemasStart+1 .. schemas 关闭行（6 空格 `},`）前
const schemasClose = mustFind(/^ {6}\},/, schemasStart + 1);
const schemasBody = lines.slice(schemasStart + 1, schemasClose);

interface Entry {
  key: string;
  text: string;
}

function splitEntries(body: string[], entryRe: RegExp, keyRe: RegExp, indent: number): Entry[] {
  const starts: number[] = [];
  body.forEach((line, i) => {
    if (entryRe.test(line)) starts.push(i);
  });
  if (starts.length === 0) throw new Error('条目切分失败：未匹配到任何条目');
  // 条目值关闭行：与 key 同缩进、以 } 开头（对象条目必有；单行引用条目无）
  const closeRe = new RegExp(`^ {${indent}}\\}`);

  // 条目真实起点 = 上一条目值关闭行之后：两 key 行之间的注释/空行完整归入新条目，
  // 不逐行识别注释（手写注释并不总是规整的 ` * ` 前缀，逐行猜会把注释切成两截）
  const realStarts = starts.map((s, idx) => {
    if (idx === 0) return 0;
    let prevClose = -1;
    for (let j = starts[idx - 1]; j < s; j++) {
      if (closeRe.test(body[j])) prevClose = j;
    }
    return prevClose >= 0 ? prevClose + 1 : starts[idx - 1] + 1;
  });

  const entries: Entry[] = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? realStarts[i + 1] : body.length;
    const keyMatch = keyRe.exec(body[starts[i]]);
    if (!keyMatch) throw new Error(`条目 key 解析失败: ${body[starts[i]]}`);
    const blockLines = body.slice(realStarts[i], end);
    while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === '') {
      blockLines.pop();
    }
    // 逗号只补在条目值关闭行（key 行之后最后一个同缩进 } 行）；
    // 其后的尾部注释原样保留，绝不在注释行上加逗号
    let valueClose = -1;
    for (let j = starts[i] - realStarts[i]; j < blockLines.length; j++) {
      if (closeRe.test(blockLines[j])) valueClose = j;
    }
    if (valueClose >= 0 && !blockLines[valueClose].trimEnd().endsWith(',')) {
      blockLines[valueClose] = `${blockLines[valueClose]},`;
    }
    entries.push({ key: keyMatch[1] ?? keyMatch[2], text: blockLines.join('\n') });
  }
  return entries;
}

const pathEntries = splitEntries(pathsBody, /^ {6}'\/api\//, /^ {6}'([^']+)':/, 6);
const schemaEntries = splitEntries(
  schemasBody,
  /^ {8}(?:'[^']+'|[A-Za-z_$][\w$]*): /,
  /^ {8}(?:'([^']+)'|([A-Za-z_$][\w$]*)): /,
  8,
);

// === 3. 域归属 ===
function pathDomain(key: string): string {
  const p = key.replace(/^\/api\//, '');
  if (p.startsWith('quant/') || p.startsWith('backtest/')) return 'quant';
  if (p.startsWith('paper/') || p.startsWith('watchlist')) return 'portfolio';
  if (p.startsWith('intl/')) return 'intl';
  if (p.startsWith('chat')) return 'chat';
  if (p === 'ingest' || p === 'documents') return 'documents';
  if (p.startsWith('autonomous/')) return 'autonomous';
  if (p.startsWith('improvement/')) return 'improvement';
  if (p.startsWith('llm/')) return 'llm';
  if (p.startsWith('theses')) return 'thesis';
  if (p.startsWith('stocks')) return 'market';
  if (p.startsWith('analyze') || p === 'compare' || p.startsWith('history')) return 'analysis';
  return 'system';
}
function schemaDomain(name: string): string {
  if (/Thesis/i.test(name)) return 'thesis';
  if (/Intl/i.test(name)) return 'intl';
  if (/Autonomous/i.test(name)) return 'autonomous';
  if (/Improvement/i.test(name)) return 'improvement';
  if (/Chat/i.test(name)) return 'chat';
  if (/Document|Insight/i.test(name)) return 'documents';
  if (/Paper|Watchlist|Alert/i.test(name)) return 'portfolio';
  if (/History|Compare|Expert|Analysis/i.test(name)) return 'analysis';
  if (
    /Quant|Factor|CrossSection|Composite|Screener|Digest|Timeseries|Backtest|Strategy|Valuation|Announcement|ResearchMemory|Experiment|Universe|Ensemble|Calibration|Skill|Ohlcv|Kline|Pattern|Rps/i.test(
      name,
    )
  ) {
    return 'quant';
  }
  return 'common';
}

function usedHelpers(snippet: string): string[] {
  return helperNames.filter((n) => new RegExp(`\\b${n}\\b`).test(snippet));
}
function emitModule(entries: string[], exportName: string): string {
  const used = [...new Set(entries.flatMap(usedHelpers))].filter((n) => n !== 'OPENAPI_VERSION');
  const importLine =
    used.length > 0 ? `import { ${used.sort().join(', ')} } from '../shared.js';\n\n` : '';
  return `${importLine}export const ${exportName} = {\n${entries.join('\n')}\n};\n`;
}

// === 4. 分组并写出 ===
const pathGroups = new Map<string, string[]>();
for (const entry of pathEntries) {
  const domain = pathDomain(entry.key);
  if (!pathGroups.has(domain)) pathGroups.set(domain, []);
  pathGroups.get(domain)!.push(entry.text);
}
const schemaGroups = new Map<string, string[]>();
for (const entry of schemaEntries) {
  const domain = schemaDomain(entry.key);
  if (!schemaGroups.has(domain)) schemaGroups.set(domain, []);
  schemaGroups.get(domain)!.push(entry.text);
}

mkdirSync(path.join(OUT_DIR, 'paths'), { recursive: true });
mkdirSync(path.join(OUT_DIR, 'schemas'), { recursive: true });

const header = `/**\n * OpenAPI 共享构件：版本号、通用 schema 片段与响应包装 helper。\n * 由 scripts/split-openapi.mts 从原单文件 openapi.ts 迁移而来（按域拆分见 paths/ 与 schemas/）。\n */\n\n`;
writeFileSync(
  path.join(OUT_DIR, 'shared.ts'),
  header +
    helperBlocks.map((b) => (b.startsWith('export ') ? b : `export ${b}`)).join('\n\n') +
    '\n',
  'utf-8',
);

const pathDomains = [...pathGroups.keys()].sort();
for (const domain of pathDomains) {
  writeFileSync(
    path.join(OUT_DIR, 'paths', `${domain}.ts`),
    emitModule(pathGroups.get(domain)!, `${domain}Paths`),
    'utf-8',
  );
}
const schemaDomains = [...schemaGroups.keys()].sort();
for (const domain of schemaDomains) {
  writeFileSync(
    path.join(OUT_DIR, 'schemas', `${domain}.ts`),
    emitModule(schemaGroups.get(domain)!, `${domain}Schemas`),
    'utf-8',
  );
}

const pathImports = pathDomains
  .map((d) => `import { ${d}Paths } from './paths/${d}.js';`)
  .join('\n');
const schemaImports = schemaDomains
  .map((d) => `import { ${d}Schemas } from './schemas/${d}.js';`)
  .join('\n');
const indexTs = `/**
 * OpenAPI 3.1 契约聚合入口（按域模块的单一事实源）
 * ----------------------------------------------------------------------------
 * 2026-11 架构整改：原 5788 行单文件拆分为 paths/ 与 schemas/ 按域模块，
 * 本入口只做聚合，不再承载逐条契约定义；新增/修改路由契约请改对应域模块。
 * 兜底校验不变：services/__tests__/openapi.routes.test.ts 与真实路由表双向比对；
 * 生成物 docs/openapi.json 由 scripts/generate-openapi.mts 产出，CI 经
 * check:openapi 保证「生成物与源同步」。
 */
import { OPENAPI_VERSION } from './shared.js';
${pathImports}
${schemaImports}

export { OPENAPI_VERSION };

export function buildOpenApiDocument() {
  return {
${keptProps},
    paths: {
${pathDomains.map((d) => `      ...${d}Paths,`).join('\n')}
    },
${componentsLeading}
    components: {
      schemas: {
${schemaDomains.map((d) => `        ...${d}Schemas,`).join('\n')}
      },
    },
  };
}
`;
writeFileSync(path.join(OUT_DIR, 'index.ts'), indexTs, 'utf-8');

writeFileSync(
  SOURCE,
  `/**\n * 兼容 re-export：契约已按域拆分到 ./openapi/（聚合入口 ./openapi/index.ts）。\n * 本文件保留仅为不破坏既有 import 路径，请勿在此新增契约定义。\n */\nexport * from './openapi/index.js';\n`,
  'utf-8',
);

console.log(
  `拆分完成：paths ${pathDomains.length} 个域模块（${pathEntries.length} 条），` +
    `schemas ${schemaDomains.length} 个域模块（${schemaEntries.length} 个）`,
);

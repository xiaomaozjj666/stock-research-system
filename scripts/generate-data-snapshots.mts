/**
 * 内置样本数据快照生成与同步校验。
 *
 * 内置行情样本是离线降级路径的事实源。数据形状或数值变更必须同步更新快照，
 * 避免报告、估值与契约冒烟在不同迭代里静默使用不同口径。
 *
 * 用法：
 *   tsx scripts/generate-data-snapshots.mts           重新生成快照
 *   tsx scripts/generate-data-snapshots.mts --check   只比对不写入
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { MOUTAI_FINANCIAL, MOUTAI_INFO, MOUTAI_VALUATION } from '../server/src/data/sampleData.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(SCRIPT_DIR, 'sample-data.snapshot.json');
const checkOnly = process.argv.includes('--check');

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

const snapshot = canonicalize({
  version: 1,
  info: MOUTAI_INFO,
  financial: MOUTAI_FINANCIAL,
  valuation: MOUTAI_VALUATION,
});
const prettierConfig = await resolveConfig(OUT_FILE);
const serialized = await format(JSON.stringify(snapshot, null, 2), {
  ...prettierConfig,
  parser: 'json',
});

if (checkOnly) {
  let existing = '';
  try {
    existing = readFileSync(OUT_FILE, 'utf-8');
  } catch {
    console.error(`样本快照不存在：${OUT_FILE}\n请先运行 npm run generate:data-snapshots`);
    process.exit(1);
  }
  if (existing !== serialized) {
    console.error(
      '内置样本数据快照与源不同步。\n请运行 npm run generate:data-snapshots 重新生成后一并提交。',
    );
    process.exit(1);
  }
  console.log('内置样本数据快照与源同步');
} else {
  writeFileSync(OUT_FILE, serialized, 'utf-8');
  console.log(`已生成 ${path.relative(path.resolve(SCRIPT_DIR, '..'), OUT_FILE)}`);
}

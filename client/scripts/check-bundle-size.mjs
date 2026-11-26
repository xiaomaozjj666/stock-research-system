#!/usr/bin/env node
/**
 * 打包体积预算检查：读 client/dist 的构建产物，逐 chunk 对照预算表，
 * 任何一项超标就以非 0 退出码失败。
 *
 * 为什么需要它：vite 的 chunkSizeWarningLimit 只是构建时的一行提示，
 * 阈值调高之后永远不会触发，也拦不住 CI。真正被强制执行的是这个脚本——
 * 预算就是"未经评审的体积增长"的上限，超了就红。
 *
 * 零依赖：只用 Node 内置 fs / path / zlib，`node client/scripts/check-bundle-size.mjs` 直接跑。
 *
 * 用法：
 *   node client/scripts/check-bundle-size.mjs                 # 用默认预算检查
 *   node client/scripts/check-bundle-size.mjs --dir dist      # 指定产物目录
 *   node client/scripts/check-bundle-size.mjs --max-kb 300    # 临时收紧/放宽所有单 chunk 上限
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const DEFAULT_DIST = resolve(scriptDir, '..', 'dist');

/**
 * 各 chunk 的体积预算（单位 kB，按 1000 进制，与 vite 构建日志口径一致）。
 *
 * 基线实测（Vite 8.3.8，2026-11-26 构建产物，合计 1234.40 kB）：
 *   echarts-vendor 605.92 / react-vendor 218.88 / index.css 100.78 /
 *   QuantPage 77.70 / report 68.51 / index 41.07
 * 历史变动：
 *   index 90.68 → 100.99（API 错误完整携带 requestId/code/retryAfter、
 *   SSE 解析失败可见化，2026-11-05 据此把预算 100 放宽到 109）
 *   2026-11：axios 换成自研 fetch 客户端并移除未使用的 TitleComponent 后，
 *   vendor（axios）chunk 整体消失，合计 1291.46 → 1233.29 kB。
 *   2026-11-26：图例改用 LegendPlain（-5.74 kB）、雷达图由 ECharts radar
 *   坐标系改为轻量 SVG（-11.85 kB，report 慢加载块），报告组件拆出独立
 *   report chunk（index 108.88 → 41.07），三组页面 CSS 改为按需引入
 *   （首屏 CSS -8 kB）。合计 1250.05 → 1234.40 kB，余量 50 → 65.6 kB。
 * 预算值在实测值上留了约 8% 余量：够吸收压缩波动和小改动，又能在体积真的
 * 膨胀时立刻失败。改预算 = 承认一次增长，应该在 PR 里说明原因。
 * 名单里没有 vendor：项目已无第三方聚合 chunk，将来若重新出现会落到
 * DEFAULT_CHUNK_BUDGET_KB 这条更严的线上，强制先拆分再合入。
 */
const CHUNK_BUDGETS_KB = {
  'echarts-vendor': 650,
  'react-vendor': 235,
  report: 74,
  QuantPage: 85,
  index: 55,
};

/** 名单外的 chunk（例如新页面）一律按这个上限卡：超了就得先拆分再合入 */
const DEFAULT_CHUNK_BUDGET_KB = 30;

/** CSS 单独一条线：样式全量打进单个文件，最容易无感知地膨胀 */
const CSS_BUDGET_KB = 110;

/** 总体积上限：防止把体积摊薄到很多小 chunk 上从而绕过单 chunk 预算 */
const TOTAL_BUDGET_KB = 1300;

/**
 * 首屏（入口）预算：index.html 直接引用的 JS/CSS（含 modulepreload）之和。
 * 总量预算里最大的一块是懒加载的 echarts，它并不阻塞首屏；只看总量会让
 * "把懒加载块锉小、把入口撑大" 的改动看起来无害。这条线专门盯用户真正
 * 首屏下载的内容。当前实测 429.97 kB，预算 500 kB（约 14% 余量）。
 */
const INITIAL_BUDGET_KB = 500;

function parseArgs(argv) {
  const options = { dir: DEFAULT_DIST, maxKb: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      options.dir = resolve(process.cwd(), argv[i + 1] ?? '');
      i += 1;
    } else if (arg === '--max-kb') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        fail(`--max-kb 需要一个正数，收到 "${argv[i + 1]}"`);
      }
      options.maxKb = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法: node client/scripts/check-bundle-size.mjs [--dir <产物目录>] [--max-kb <正数>]\n',
      );
      process.exit(0);
    } else {
      fail(`未知参数 "${arg}"，用 --help 查看用法`);
    }
  }
  return options;
}

function fail(message) {
  process.stderr.write(`[bundle-size] ${message}\n`);
  process.exit(2);
}

/**
 * 去掉产物文件名里的内容哈希（echarts-vendor-CkS5yNzn.js -> echarts-vendor.js），
 * 得到的名字才能和预算表里的键对上。Vite 生成的哈希固定 8 位，
 * 所以只吃掉末尾那一段，否则 echarts-vendor 会被砍成 echarts。
 */
function stripHash(fileName) {
  const ext = extname(fileName);
  return basename(fileName, ext).replace(/^(.*)-[A-Za-z0-9_-]{8}$/, '$1') + ext;
}

/** 长前缀优先，避免 index 把 index.css 之类的名字认错 */
function budgetFor(name, overrideKb) {
  if (overrideKb !== null) return overrideKb;
  if (extname(name) === '.css') return CSS_BUDGET_KB;
  const keys = Object.keys(CHUNK_BUDGETS_KB).sort((a, b) => b.length - a.length);
  const hit = keys.find((key) => name === key || name.startsWith(key));
  return hit ? CHUNK_BUDGETS_KB[hit] : DEFAULT_CHUNK_BUDGET_KB;
}

const toKb = (bytes) => bytes / 1000;

const options = parseArgs(process.argv.slice(2));

let assetDir;
try {
  statSync(options.dir);
  assetDir = join(options.dir, 'assets');
  statSync(assetDir);
} catch {
  fail(
    `找不到构建产物目录 ${join(options.dir, 'assets')}，请先执行 npm run build --workspace=client`,
  );
}

const files = readdirSync(assetDir)
  .filter((file) => ['.js', '.css'].includes(extname(file)))
  .sort();

if (files.length === 0) fail(`${assetDir} 下没有 .js/.css 产物，构建可能没跑成功`);

const rows = files.map((file) => {
  const name = stripHash(file);
  const buffer = readFileSync(join(assetDir, file));
  return {
    name,
    file,
    kb: toKb(buffer.length),
    gzipKb: toKb(gzipSync(buffer).length),
    budget: budgetFor(name, options.maxKb),
  };
});

rows.sort((a, b) => b.kb - a.kb);

const violations = rows.filter((row) => row.kb > row.budget);
const totalKb = rows.reduce((sum, row) => sum + row.kb, 0);
// --max-kb 只覆盖单 chunk 上限，此时总体积/首屏预算无意义，直接跳过
const checkTotal = options.maxKb === null;
const totalExceeded = checkTotal && totalKb > TOTAL_BUDGET_KB;

/**
 * 首屏体积：解析 index.html 直接引用的 JS/CSS（script src、modulepreload、
 * stylesheet）。懒加载 chunk 不在其中——这正是它和总量预算互补的地方。
 * index.html 缺失时跳过（老产物目录/兼容），但正常构建一定存在。
 */
function initialBundleKb() {
  let html;
  try {
    html = readFileSync(join(options.dir, 'index.html'), 'utf-8');
  } catch {
    return null;
  }
  const names = new Set();
  for (const match of html.matchAll(/(?:src|href)="\/?assets\/([^"]+\.(?:js|css))"/g)) {
    names.add(match[1]);
  }
  let sum = 0;
  for (const name of names) {
    try {
      sum += statSync(join(assetDir, name)).size;
    } catch {
      fail(`index.html 引用了不存在的产物 ${name}`);
    }
  }
  return toKb(sum);
}
const initialKb = initialBundleKb();
const initialExceeded = checkTotal && initialKb !== null && initialKb > INITIAL_BUDGET_KB;

const nameWidth = Math.max(...rows.map((row) => row.name.length));
const lines = [`${'产物'.padEnd(nameWidth)}      体积(kB)     gzip(kB)    预算(kB)   结果`];
for (const row of rows) {
  lines.push(
    `${row.name.padEnd(nameWidth)} ${row.kb.toFixed(2).padStart(11)} ${row.gzipKb
      .toFixed(2)
      .padStart(
        13,
      )} ${row.budget.toFixed(0).padStart(11)}   ${row.kb > row.budget ? '超预算' : 'OK'}`,
  );
}
lines.push(
  `合计 ${totalKb.toFixed(2)} kB / 预算 ${
    checkTotal ? `${TOTAL_BUDGET_KB} kB` : '已跳过（--max-kb 只覆盖单 chunk 上限）'
  }`,
);
if (checkTotal && initialKb !== null) {
  lines.push(
    `首屏(入口) ${initialKb.toFixed(2)} kB / 预算 ${INITIAL_BUDGET_KB} kB   ${
      initialExceeded ? '超预算' : 'OK'
    }`,
  );
}

if (violations.length > 0 || totalExceeded || initialExceeded) {
  lines.push('');
  for (const row of violations) {
    lines.push(`  ${row.file} 超出预算 ${(row.kb - row.budget).toFixed(2)} kB`);
  }
  if (totalExceeded) {
    lines.push(`  总体积超出预算 ${(totalKb - TOTAL_BUDGET_KB).toFixed(2)} kB`);
  }
  if (initialExceeded && initialKb !== null) {
    lines.push(`  首屏体积超出预算 ${(initialKb - INITIAL_BUDGET_KB).toFixed(2)} kB`);
  }
  lines.push('  若这次增长是有意的，请同步上调本文件里的预算并在 PR 中说明原因。');
}

process.stdout.write(`[bundle-size] ${options.dir}\n${lines.join('\n')}\n`);

if (violations.length > 0 || totalExceeded || initialExceeded) {
  process.stderr.write(
    `[bundle-size] FAIL: ${violations.length} 个 chunk 超预算${
      totalExceeded ? '，总体积超预算' : ''
    }${initialExceeded ? '，首屏超预算' : ''}\n`,
  );
  process.exit(1);
}

process.stdout.write(`[bundle-size] PASS: ${rows.length} 个产物均在预算内\n`);

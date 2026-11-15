/**
 * 发布回归门禁：把生成物同步、依赖方向、前端体积、真实进程契约和内置
 * 样本快照串成一次可复现的本地/CI 检查。
 *
 * 顺序按依赖关系排列：size:budget 构建 client，smoke:contract 构建 server
 * 并用同一份 dist 启动真实进程；两者结束后 client/dist 与 server/dist 均可直接
 * 作为后续 e2e 产物使用。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const gates = [
  ['前端 API 类型同步', ['run', 'check:api-types']],
  ['包依赖方向', ['run', 'check:deps']],
  ['OpenAPI 生成物同步', ['run', 'check:openapi']],
  ['客户端构建与体积预算', ['run', 'size:budget']],
  ['真实进程端点契约', ['run', 'smoke:contract']],
  ['内置样本数据快照', ['run', 'check:data-snapshots']],
] as const;

for (const [name, args] of gates) {
  console.log(`\n[release-gates] ${name}`);
  const result = spawnSync('npm', [...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) {
    console.error(`[release-gates] ${name} 启动失败：${result.error.message}`);
    process.exitCode = 1;
    break;
  }
  if (result.status !== 0) {
    console.error(`[release-gates] ${name} 未通过`);
    process.exitCode = result.status || 1;
    break;
  }
}

if (!process.exitCode) console.log('\n[release-gates] 全部通过');

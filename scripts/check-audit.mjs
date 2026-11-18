#!/usr/bin/env node
/**
 * 依赖安全审计（带已知未修复 advisory 的显式豁免）
 * ----------------------------------------------------------------------------
 * CI 门禁用 `npm audit --audit-level=high`，只要出现 high/critical 就红。
 * 但上游偶尔会披露「所有版本均受影响、尚无修复」的 advisory——这时
 * `npm audit fix` 只能靠降级绕过，而降级 vite/vitest 这类核心 dev 依赖
 * 会引入更严重的回归。
 *
 * 本脚本在 npm audit 之上加一层**显式豁免名单**：只放行那些在 ALLOW_LIST
 * 里登记、且附带理由的 advisory；其它任何 high/critical 照样让 CI 红。
 * 豁免不是沉默——脚本会把豁免项打印出来，让 PR 评审能看到「这次放行了谁、为什么」。
 *
 * 判定口径：一个漏洞只有当它的整个 via 链最终都指向 ALLOW_LIST 里的
 * advisory 时才算「已豁免」；链上只要出现一个未登记的 advisory id 就失败。
 */
import { execFileSync } from 'node:child_process';

/**
 * 当前豁免项。每一项必须给理由，且理由要能回答「为什么可以放行」。
 * 删除条件：上游发布修复后，删掉对应条目即可恢复严格门禁。
 */
const ALLOW_LIST = {
  // GHSA-fc5q-39xc-vjpf（npm advisory id 1247710）：picomatch 通过单分支重复
  // extglob 的 ReDoS。受影响范围是 picomatch 全部版本，上游尚无修复。
  // 在本项目中 picomatch 只被 vite / vitest 在构建与测试时用于匹配**开发者
  // 自己配置**的 glob（vite.config / vitest.config），运行时服务不依赖它，
  // 不存在「攻击者可控 glob 输入」的可达路径，故实际不可利用。
  // 跟踪：https://github.com/advisories/GHSA-fc5q-39xc-vjpf
  1247710:
    'picomatch ReDoS（GHSA-fc5q-39xc-vjpf）：仅 dev 构建链使用、无运行时可达路径，上游未修复',
};

const ALLOWED_IDS = new Set(Object.keys(ALLOW_LIST).map(Number));

function runAudit() {
  try {
    const out = execFileSync('npm', ['audit', '--json', '--audit-level=high'], {
      encoding: 'utf-8',
      // shell:true：Windows 上 npm 是 npm.cmd，不用 shell spawnSync 找不到；
      // Linux CI 上同样兼容。参数都是固定字面量，无注入面。
      shell: true,
      // npm audit 有 high/critical 时退出码非 0，但我们要自己判定，所以吞掉
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (err) {
    // 非 0 退出时 stdout 仍可能有 JSON（npm 把报告写 stdout）
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        /* fallthrough */
      }
    }
    throw new Error(`npm audit 执行失败：${err.message}`, { cause: err });
  }
}

/**
 * 递归判断某个包的漏洞是否「整条 via 链都指向豁免 advisory」。
 * via 数组里：数字 = advisory id，字符串 = 上游包名（继续追）。
 */
function isFullyAllowListed(name, vulns, visiting) {
  const vuln = vulns[name];
  if (!vuln) return true; // 不在审计结果里
  if (visiting.has(name)) return true; // 防环
  visiting.add(name);

  for (const via of vuln.via ?? []) {
    if (typeof via === 'number') {
      if (!ALLOWED_IDS.has(via)) return false;
    } else if (typeof via === 'string') {
      if (!isFullyAllowListed(via, vulns, visiting)) return false;
    }
  }
  return true;
}

function main() {
  const report = runAudit();
  const vulns = report.vulnerabilities ?? {};
  const names = Object.keys(vulns);

  const blocked = [];
  const allowed = [];

  for (const name of names) {
    if (isFullyAllowListed(name, vulns, new Set())) {
      allowed.push(name);
    } else {
      blocked.push(name);
    }
  }

  if (blocked.length > 0) {
    console.error('[check-audit] 存在未豁免的 high/critical 漏洞：');
    for (const name of blocked) {
      const v = vulns[name];
      const sources = (v.via ?? [])
        .map((x) => (typeof x === 'object' ? x.url || x.title : x))
        .filter(Boolean);
      console.error(`  · ${name} (${v.severity}) via: ${sources.join(', ')}`);
    }
    console.error('\n请修复或在 scripts/check-audit.mjs 的 ALLOW_LIST 中登记并说明理由。');
    process.exit(1);
  }

  if (allowed.length > 0) {
    console.warn('[check-audit] ⚠ 以下漏洞已按 ALLOW_LIST 豁免（需持续关注上游修复）：');
    for (const name of allowed) {
      const v = vulns[name];
      console.warn(`  · ${name} (${v.severity})`);
    }
    for (const id of ALLOWED_IDS) {
      console.warn(`    豁免理由（advisory ${id}）：${ALLOW_LIST[id]}`);
    }
  } else {
    console.log('[check-audit] 无 high/critical 漏洞');
  }
  process.exit(0);
}

main();

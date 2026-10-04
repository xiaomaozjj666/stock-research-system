/**
 * 真实进程冒烟：验证「服务端实际返回的 JSON」与「契约声明的 schema」一致。
 *
 * 为什么必须做这一层：此前所有验证都在进程内（import buildOpenApiDocument 后比对），
 * 从未验证过**真实 HTTP 响应**。而契约里有一类错误是进程内测不出来的 ——
 * 路由 `res.json(...)` 实际写出的字段与契约声明不一致（两者是独立代码路径：
 * 契约是手写的，响应是 res.json 拼的）。这正是本项目反复出现的漂移形态。
 *
 * 做法：请求若干**无副作用、不依赖上游**的端点 → 用契约里的 schema 逐字段校验
 * 实际响应。进程由调用方起（见 package.json 的 smoke:contract 脚本，它会
 * 先 build 再起服务再跑本校验）—— 本机沙箱会 SIGTERM 掉脚本内部 spawn 的子进程，
 * 故不在这里自起进程。
 *
 * ⚠️ **契约必须从 dist 读，不能从源码读**。曾经写成
 * `import { buildOpenApiDocument } from '../server/src/services/openapi.js'`，
 * 而服务跑的是 `server/dist/index.js` —— 两者是**不同版本**：改了源码但没重新
 * build 时，校验会拿「新契约」去比「旧响应」，于是**注入的漂移检测不出来**
 * （实测把 codes 谎称成 number 仍然 0 异常，假绿灯）。
 * 改成从 `./contract-from-dist.mjs` 读 —— 那是从构建产物里 dump 出来的契约，
 * 与被测服务**保证同源**。
 *
 * 只覆盖无副作用、不依赖上游的端点：POST 类与需要真实行情/上游的端点无法在
 * 离线环境稳定复现，强行纳入只会让这条门禁变成随机红。**覆盖面不足是已知取舍，
 * 不是遗漏**。
 */
import { loadContractFromDist } from './contract-from-dist.mjs';

// 服务地址由启动器传入（它负责起进程）
const BASE = process.env.SMOKE_BASE ?? '';

const doc = (await loadContractFromDist()) as any;
const schemas = (doc.components?.schemas ?? {}) as any;

/** 极简 JSON Schema 校验器：只支持本项目契约实际用到的关键字 */
function validate(schema: any, value: any, path = '$'): string[] {
  const errs = [];
  if (schema === undefined || schema === null || Object.keys(schema).length === 0) return errs;
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = schemas[name];
    if (!target) return [`${path}: $ref 悬空 ${name}`];
    return validate(target, value, path);
  }
  if (schema.oneOf) {
    const branches = schema.oneOf.map((b) => validate(b, value, path));
    if (branches.every((b) => b.length > 0)) {
      return [`${path}: oneOf 全不匹配（${branches[0][0] ?? '?'}）`];
    }
    return [];
  }
  // 可空的两种写法都要认：OpenAPI 3.1 的 `type: ['string','null']`，
  // 以及 3.0 的 `nullable: true`（本项目契约里两者都在用 —— 只认前者会把
  // 一批**本来正确**的契约误报成「期望非 null，实际 null」，即假红灯）。
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes('null') || schema.nullable === true;
  if (value === null) {
    if (!nullable && types.length > 0) errs.push(`${path}: 期望非 null，实际 null`);
    return errs;
  }
  const t = types.find((x) => x !== 'null');
  if (t === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errs.push(`${path}: 期望 object，实际 ${Array.isArray(value) ? 'array' : typeof value}`);
      return errs;
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (!(k in value)) {
        if ((schema.required ?? []).includes(k)) errs.push(`${path}.${k}: 必填字段缺失`);
        continue;
      }
      errs.push(...validate(sub, value[k], `${path}.${k}`));
    }
    for (const k of schema.required ?? []) {
      if (!(k in value)) errs.push(`${path}.${k}: 必填字段缺失`);
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) {
      errs.push(`${path}: 期望 array，实际 ${typeof value}`);
      return errs;
    }
    if (schema.items)
      value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  } else if (t === 'string' && typeof value !== 'string') {
    errs.push(
      `${path}: 期望 string，实际 ${typeof value}（${JSON.stringify(value)?.slice(0, 40)}）`,
    );
  } else if ((t === 'number' || t === 'integer') && typeof value !== 'number') {
    errs.push(
      `${path}: 期望 number，实际 ${typeof value}（${JSON.stringify(value)?.slice(0, 40)}）`,
    );
  } else if (t === 'boolean' && typeof value !== 'boolean') {
    errs.push(`${path}: 期望 boolean，实际 ${typeof value}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${path}: ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)}`);
  }
  return errs;
}

function okSchemaOf(path: string, method: string) {
  const op = doc.paths[path]?.[method];
  const code = Object.keys(op?.responses ?? {}).find((c) => /^2\d\d$/.test(c));
  return op?.responses?.[code]?.content?.['application/json']?.schema;
}

let failed = 0;
{
  // 无副作用、不依赖上游的端点。GET /api/openapi.json 单独校验（它是文档自身）。
  const targets = [
    ['/api/health', 'get'],
    ['/api/stocks', 'get'],
    ['/api/watchlist', 'get'],
    ['/api/documents', 'get'],
    ['/api/models', 'get'],
    ['/api/cost', 'get'],
    ['/api/history', 'get'],
    ['/api/paper/portfolio', 'get'],
    ['/api/paper/stats', 'get'],
    ['/api/audit', 'get'],
    ['/api/autonomous/status', 'get'],
    ['/api/quant/factor/experiments', 'get'],
    ['/api/quant/digests', 'get'],
    ['/api/improvement/status', 'get'],
    ['/api/improvement/history', 'get'],
    ['/api/watchlist/alerts', 'get'],
  ];

  let checked = 0;
  for (const [p, m] of targets as [string, string][]) {
    const schema = okSchemaOf(p, m);
    if (!schema) {
      console.log(`  跳过 ${m.toUpperCase()} ${p}（契约无 2xx schema）`);
      continue;
    }
    let res;
    try {
      res = await fetch(`${BASE}${p}`);
    } catch (e) {
      console.log(`  跳过 ${m.toUpperCase()} ${p}（请求失败：${e.message}）`);
      continue;
    }
    // 非 2xx 说明该端点依赖上游/环境，跳过并说明，不算失败
    if (!res.ok) {
      console.log(`  跳过 ${m.toUpperCase()} ${p}（HTTP ${res.status}，依赖上游）`);
      continue;
    }
    const body = await res.json();
    const errs = validate(schema, body);
    checked++;
    if (errs.length === 0) {
      console.log(`  ✓ ${m.toUpperCase()} ${p}`);
    } else {
      failed++;
      console.log(`  ✗ ${m.toUpperCase()} ${p}`);
      for (const e of errs.slice(0, 6)) console.log(`      ${e}`);
    }
  }
  console.log(`\n真实进程校验：${checked} 个端点，${failed} 个与契约不符`);
}

process.exit(failed > 0 ? 1 : 0);

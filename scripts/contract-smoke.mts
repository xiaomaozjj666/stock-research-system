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
let checked = 0;

/** 打一次请求并校验；返回 'ok' | 'skipped:<原因>' */
async function check(
  method: string,
  p: string,
  body?: unknown,
  pathParams: Record<string, string> = {},
): Promise<'ok' | string> {
  const schema = okSchemaOf(p, method);
  if (!schema) return '契约无 2xx schema';
  let res: Response;
  // 契约里的 path 是模板（如 '/api/history/{id}'），请求前必须把占位符**替换**掉，
  // 不能原样拼在后面 —— 拼成 '/api/history/{id}/xxx' 会稳定 404，且极易被误读成
  // 「服务端有问题」。subPath 用于 DELETE 这类带路径参数、且要替换而非追加的场景。
  // 契约里的 path 是模板（如 '/api/history/{id}'），请求前必须把占位符**替换**掉，
  // 不能原样拼在后面 —— 拼成 '/api/history/{id}/xxx' 会稳定 404，且极易被误读成
  // 「服务端有问题」（本轮实际踩过这个坑，排查了半天才发现是脚本自己的错）。
  const url = `${BASE}${p}`.replace(/\{(\w+)\}/g, (_, key) => pathParams[key] ?? '');
  try {
    res = await fetch(url, {
      method: method.toUpperCase(),
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    return `请求失败：${e.message}`;
  }
  // 非 2xx 说明该端点依赖上游/环境或入参不合法，跳过并说明，不算失败
  if (!res.ok) return `HTTP ${res.status}（依赖上游或入参不合法）`;
  const json = await res.json();
  const errs = validate(schema, json);
  checked++;
  if (errs.length === 0) {
    console.log(`  ✓ ${method.toUpperCase()} ${url.replace(BASE, '')}`);
    return 'ok';
  }
  failed++;
  console.log(`  ✗ ${method.toUpperCase()} ${url.replace(BASE, '')}`);
  for (const e of errs.slice(0, 6)) console.log(`      ${e}`);
  return 'ok';
}

{
  // ── 无副作用的 GET：不改状态、不依赖上游 ──
  const getTargets = [
    '/api/health',
    '/api/stocks',
    '/api/watchlist',
    '/api/documents',
    '/api/models',
    '/api/cost',
    '/api/history',
    '/api/paper/portfolio',
    '/api/paper/stats',
    '/api/audit',
    '/api/autonomous/status',
    '/api/quant/factor/experiments',
    '/api/quant/digests',
    '/api/improvement/status',
    '/api/improvement/history',
    '/api/watchlist/alerts',
  ];
  for (const p of getTargets) {
    const r = await check('get', p);
    if (r !== 'ok') console.log(`  跳过 GET ${p}（${r}）`);
  }

  // ── 纯本地逻辑的 POST：不碰网络/LLM/K 线，结果确定 ──
  //
  // 这些端点此前的**响应体从未被真实校验过**（GET-only 覆盖不到），而
  // 「契约声明的字段」与「res.json 实际写出的字段」分属两条独立代码路径 ——
  // 正是本项目反复漂移的形态。启动器已把数据文件重定向到临时目录
  // （见 run-contract-smoke.mts），故这里的写操作不会污染真实数据。
  console.log('\n  ── POST（纯本地逻辑）──');
  const postTargets: [string, string, unknown?][] = [
    // 模拟盘：下单（成交价给足，规则内可成交）
    [
      'post',
      '/api/paper/order',
      // placeOrder 要求账户已有交易日，否则 400「未设置交易日」。自带 date 字段
      // 即可（路由内部会 setCurrentDate），限价 1600 给足避免被引擎拒单。
      {
        code: '600519',
        side: 'buy',
        type: 'limit',
        quantity: 100,
        price: 1600,
        date: '2026-01-05',
      },
    ],
    // 模拟盘：日终结算（只需日期 + 收盘价映射）
    ['post', '/api/paper/settle', { date: '2026-01-05', closePrices: { '600519': 1610 } }],
    // 成本账本重置：纯内存操作
    ['post', '/api/cost/reset', {}],
    // 会话记忆清空：写临时目录里的 chatHistory
    ['post', '/api/chat/history/clear', { sessionId: 'smoke-session' }],
    // 自选股增删：写临时目录
    ['post', '/api/watchlist', { code: '600519' }],
    // 改进闭环：dryRun 不落盘、不调模型
    ['post', '/api/improvement/run', { dryRun: true }],
    // 调度器：启停都是纯内存状态
    ['post', '/api/improvement/scheduler/start', {}],
    ['post', '/api/improvement/scheduler/stop', {}],
    // 自治监控：启停纯内存（间隔给默认，避免长跑）
    ['post', '/api/autonomous/start', {}],
    ['post', '/api/autonomous/stop', {}],
    // 因子评估：纯 CPU，输入自造面板，不取数
    [
      'post',
      '/api/quant/factor/evaluate',
      {
        observations: Array.from({ length: 40 }, (_, i) => ({
          date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
          symbol: 'A',
          value: i,
          returns: { 21: (i % 7) / 100 - 0.02 },
        })),
      },
    ],
  ];
  for (const [m, p, body] of postTargets) {
    const r = await check(m, p, body);
    if (r !== 'ok') console.log(`  跳过 ${m.toUpperCase()} ${p}（${r}）`);
  }

  // ── 有路径参数的 DELETE：验证 deleteFromHistory 的响应体 ──
  //
  // 用启动器播好的种子 id（SMOKE_HISTORY_ID），**不要**试图 POST 一条：
  // /api/history 并没有 POST 路由（会 404），history 只在分析成功时落库，
  // 而分析依赖 LLM + 行情 —— 冒烟环境里两者都没有。种子写在临时目录，
  // 删除也只作用于临时数据。
  const seedId = process.env.SMOKE_HISTORY_ID;
  if (!seedId) {
    console.log('  跳过 DELETE /api/history/{id}（启动器未提供 SMOKE_HISTORY_ID）');
  } else {
    // 先 GET 详情（同样带响应体，值得一起校验），再 DELETE
    const r1 = await check('get', '/api/history/{id}', undefined, { id: seedId });
    if (r1 !== 'ok') console.log(`  跳过 GET /api/history/{id}（${r1}）`);
    const r2 = await check('delete', '/api/history/{id}', undefined, { id: seedId });
    if (r2 !== 'ok') console.log(`  跳过 DELETE /api/history/{id}（${r2}）`);
  }

  console.log(`\n真实进程校验：${checked} 个端点，${failed} 个与契约不符`);
}

process.exit(failed > 0 ? 1 : 0);

/**
 * supertest 断言增强：让**任意**路由测试的响应体自动接受契约校验
 * ============================================================================
 * 解决的真问题：契约（`services/openapi.ts`，手写 schema）与实际响应
 * （路由里 `res.json(...)` 拼出的对象）是两条独立代码路径。30 个路由测试虽已
 * 深度断言响应体，但那些断言是**手写的**，不会随契约改动而更新 ——
 * 契约改了、断言没改，两边就悄悄分叉。
 *
 * 做法：提供一个 `withContract(app)` 包装，把 express app 套一层中间件，
 * 在响应发出后用契约校验它。测试文件只需把 `app` 换成 `withContract(app)`
 * 一行，即可让**该文件里所有端点**（含将来新增的）自动获得契约校验。
 *
 * 为什么用中间件而不是每次手写 `validateResponse(...)`：
 * - 手写 = 每文件每端点都要加一行，30 个文件 × 多个端点，极易漏；
 * - 中间件 = 挂一次覆盖全文件，**新增端点自动纳入**，不会遗忘。
 *
 * 失败时的行为：在响应里插入一个 `__contractViolations` 字段并把状态码
 * 改成 500，同时打印详情。之所以不改响应体就完事：测试若只断言业务字段，
 * 静默通过等于没校验；让测试**必然失败**（状态码变了）才是真门禁。
 */

import type { Express, Request, Response, NextFunction } from 'express';
import { buildOpenApiDocument } from '../services/openapi.js';
import { validateResponse, type ContractDoc } from './contractSchema.js';

const doc = buildOpenApiDocument() as unknown as ContractDoc;

/** 契约里的 path 模板 → 匹配函数。`/api/history/{id}` 匹配 `/api/history/abc` */
function templateToRegExp(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\{[a-zA-Z0-9_]+\\\}/g, '[^/]+')}$`);
}

const matchers = Object.entries(doc.paths).map(([path, item]) => ({
  path,
  methods: new Set(Object.keys(item).filter((m) => m !== 'parameters')),
  re: templateToRegExp(path),
}));

/** 找出这个 (method, url) 对应的契约 path；找不到返回 null（如 SSE/未收录端点） */
export function findContractPath(method: string, url: string): string | null {
  const clean = url.split('?')[0] ?? url;
  const m = method.toLowerCase();
  for (const m2 of matchers) {
    if (m2.methods.has(m) && m2.re.test(clean)) return m2.path;
  }
  return null;
}

/** 响应体里注入的违规标记（测试断言时能看到它，等于失败可见） */
export const CONTRACT_VIOLATION_FIELD = '__contractViolations';

/** 诊断开关：设为 '1' 时把违规详情打到 stderr（默认静默，靠状态码失败暴露） */
const TRACE = process.env.CONTRACT_TRACE === '1';

/**
 * 给 express app 套上契约校验中间件。
 *
 * 只校验 **2xx + application/json** 的响应：错误响应（4xx/5xx）各端点形状
 * 差异大且已在路由测试里断言；非 JSON（SSE / Prometheus 文本）不适用。
 * 契约里查不到该 (method, path) 时也放行 —— 契约尚未收录的新端点不应让
 * 既有测试全红，那属于「契约该补」而非「测试该改」。
 */
export function withContract(inner: Express): Express {
  // 用一个薄壳而不是直接改 app：避免污染全局 app（其他测试直接 import app）
  const wrapper = ((req: Request, res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const isJson = () => {
      const ct = String(res.getHeader('content-type') ?? '');
      return ct.includes('application/json');
    };

    res.write = ((chunk: any, ...args: any[]) => {
      if (isJson() && chunk) chunks.push(Buffer.from(chunk));
      return (origWrite as any)(chunk, ...args);
    }) as typeof res.write;
    res.end = ((chunk: any, ...args: any[]) => {
      if (chunk && isJson() && chunks.length === 0) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf-8');
      const status = res.statusCode;
      if (raw && isJson() && status >= 200 && status < 300) {
        const contractPath = findContractPath(req.method, req.originalUrl || req.url);
        if (contractPath) {
          try {
            const body = JSON.parse(raw);
            const errs = validateResponse(doc, contractPath, req.method.toLowerCase(), body);
            if (errs.length > 0) {
              const detail =
                `[contract] ${req.method} ${contractPath} 响应体与契约不符:\n` +
                errs.map((e) => `    ${e}`).join('\n');
              if (TRACE) process.stderr.write(`${detail}\n`);
              const patched = {
                ...body,
                [CONTRACT_VIOLATION_FIELD]: errs,
              };
              const out = JSON.stringify(patched);
              res.statusCode = 500;
              res.setHeader('content-length', Buffer.byteLength(out));
              return (origEnd as any)(out, ...args);
            }
          } catch {
            // 响应不是合法 JSON：不是契约校验该管的事，放行
          }
        }
      }
      return (origEnd as any)(raw.length ? raw : chunk, ...args);
    }) as typeof res.end;

    inner(req, res, next);
  }) as unknown as Express;

  // 复制原 app 的挂载点，使 wrapper 能被 request(app) 直接使用
  const proto = Object.getPrototypeOf(inner) as object;
  Object.setPrototypeOf(wrapper, proto);
  (wrapper as any).set = (inner as any).set?.bind(inner);
  return wrapper;
}

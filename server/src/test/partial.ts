/**
 * 测试专用的「部分对象」构造器
 * ============================================================================
 * 为什么要它：测试里构造 mock 桩时，几乎从不关心被 mock 对象的全部字段
 * （express 的 `Request` 有 40+ 个成员、`Response` 更多）。于是出现了两种
 * 都不可接受的写法：
 *
 *   1. `req as never` —— 放弃整个类型检查。字段名写错、必填项缺失全都
 *      编译通过，运行时才炸。**这是本项目接入契约校验时抓到的 6 处
 *      「桩 ≠ 契约」的根因。**
 *   2. 逐个补全 40 个字段只为通过编译 —— 噪音淹没意图，且字段一改全要跟。
 *
 * `partial<T>()` 在**一个**地方集中做这次类型擦除，其余调用点保持强类型
 * 提示与 IDE 补全：
 *
 *   const req = partial<Request>({ method: 'GET', path: '/api/x' });
 *   //                          ^^^^^ 显式声明目标类型，字段名仍然受编译器检查
 *
 * 关键区别：`partial<Request>({ methd: 'GET' })` 里 `methd` 拼错依然会报错
 * （因为参数位置要求 `Partial<Request>`），而 `as never` 完全不检查。
 *
 * 它**只用在测试**。生产代码出现 `as unknown as` 属于类型逃逸，由
 * `test/__tests__/typeEscape.test.ts` 守门。
 */

// Request/Response 取自 express 而非 DOM：server 的 tsconfig 含 DOM lib，
// 不显式导入会解析成浏览器同名全局类型，于是「缺 93 个属性」的错误报得莫名其妙。
// 注意 express 与 DOM **同名**：本文件的 Request/Response 一律指 express 侧
// （中间件桩用），fetch 桩另用 FetchResponse 指 DOM 侧 —— 两者不可混用。
import type { Request, Response } from 'express';

/** fetch 桩的返回类型：DOM 标准 Response（`globalThis.fetch` 的契约），非 express 那个 */
type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

/**
 * 构造一个只实现了 `T` 部分成员的测试替身。
 *
 * 相比 `as never`：目标类型在调用处显式写出，对象字面量里多写/写错字段名
 * 仍会被 TypeScript 拦下，只有「缺字段」被有意放过 —— 而缺字段正是测试
 * 桩的正常形态。
 */
export function partial<T>(value: Partial<T>): T {
  return value as T;
}

/**
 * `extractToken(req)` 一类**只读少数字段**的函数专用的桩构造器。
 *
 * `extractToken` 声明形参是完整的 express `Request`，但实现只碰
 * `headers` / `method` / `query` 三个字段。写测试时既不该 `as never`
 * （放弃检查），也不该为了凑齐 40 多个成员造噪音。
 *
 * 入参类型按「实现真正读取的字段」逐项列出（非 `Pick`，因为这三个字段的
 * 值类型与 `Request` 里的不完全一致：`headers` 在 express 里是 `IncomingHttpHeaders`，
 * 这里只要能写字面量的 `Record<string, string>`）。于是：
 *  - 写了这三个之外的字段 → 报错（提示这个函数不关心它）
 *  - 字段名拼错 → 报错
 *  - 缺 `method` 之类 → 默认值兜底，不静默产生 `undefined`
 */
export function reqOf(init: {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): Request {
  return { method: 'GET', headers: {}, query: {}, ...init } as unknown as Request;
}

/**
 * express 中间件（`req: Request, res: Response, next: NextFunction)`）专用的
 * req 桩。中介层只读 `method` / `path` / `originalUrl`，故按此收窄。
 */
export function mwReq(init: { method?: string; path?: string; originalUrl?: string }): Request {
  const { method = 'GET', path = '/', originalUrl = path } = init;
  return { method, path, originalUrl, headers: {} } as unknown as Request;
}

/**
 * 中介层专用的 res 桩：只需 `statusCode` / `writableEnded` / `on`。
 * `on` 的回调被收集到 `listeners` 里，由用例手动触发（模拟 finish/close）。
 */
export function mwRes(init: {
  statusCode?: number;
  writableEnded?: boolean;
  listeners?: Record<string, ((...args: unknown[]) => void)[]>;
}): Response {
  const { statusCode = 200, writableEnded = false, listeners = {} } = init;
  return {
    statusCode,
    writableEnded,
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ||= []).push(cb);
      return this;
    },
  } as unknown as Response;
}

/**
 * `vi.spyOn(globalThis, 'fetch')` 的 Response 桩。
 *
 * 真实 `Response` 有几十个成员（body/headers/arrayBuffer/clone/…），但被测代码
 * 在 JSON 接口上只读 `ok` / `status` / `json()`。先前逐处写
 * `{ ok: true, status: 200, json: async () => ({...}) } as never` —— 一旦被测
 * 代码改用 `res.text()` 或读 `headers`，桩会静默缺成员，测试照绿。
 */
export function jsonResponse(body: unknown, init?: { status?: number }): FetchResponse {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as FetchResponse;
}

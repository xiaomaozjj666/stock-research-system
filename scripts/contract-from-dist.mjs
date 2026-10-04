/**
 * 从**构建产物**（server/dist）里取出 OpenAPI 契约。
 *
 * 为什么要从 dist 而不是源码 import：契约冒烟校验的对象是「真实进程返回的响应」，
 * 那个进程跑的是 server/dist/index.js。若契约从 src 读，两边可能不是同一版本 ——
 * 改了源码没重新 build 时，就会拿新契约比旧响应，**注入的漂移检测不出来**
 * （实测确认过，假绿灯）。从 dist 读则与被测服务保证同源。
 *
 * 实现：动态 import 构建产物里的 openapi 模块。构建产物是 ESM（NodeNext），
 * 用 pathToFileURL 转 URL 才能被 node 正确加载（Windows 上尤其重要：
 * 直接给绝对路径会被当成模块 specifier 而报 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST_OPENAPI = resolve(process.cwd(), 'server', 'dist', 'services', 'openapi.js');

/** 载入构建产物里的契约；产物缺失时抛出可操作的错误 */
export async function loadContractFromDist() {
  if (!existsSync(DIST_OPENAPI)) {
    throw new Error(
      `构建产物不存在：${DIST_OPENAPI}\n` +
        '请先运行：npm run build --workspace=server（契约冒烟必须针对构建产物，' +
        '否则契约与被测服务不同源，会出现假绿灯）',
    );
  }
  const mod = await import(pathToFileURL(DIST_OPENAPI).href);
  const build = mod.buildOpenApiDocument ?? mod.default?.buildOpenApiDocument;
  if (typeof build !== 'function') {
    throw new Error(`${DIST_OPENAPI} 未导出 buildOpenApiDocument，无法读取契约`);
  }
  return build();
}

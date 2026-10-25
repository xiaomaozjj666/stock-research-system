import * as path from 'path';

/**
 * 运行时数据根目录（源码树外）。
 *
 * 此前各持久化模块各自用 `import.meta.dirname + '..' + 'data'` 拼路径，
 * 结果运行时 JSON 全部落进 `server/src/data/`——与 tracked 源码
 * （industryPeers.ts / sampleData.ts / __tests__）混在同一目录，只能靠
 * .gitignore 逐文件豁免，任何一处漏写就是一次「源码树里的运行时产物」。
 *
 * 2026-10-26 起统一收敛到这里：默认 `server/data/`（源码树的上一级），
 * server/src/data 只剩源码。个别模块仍支持各自的 env 重定向
 * （PAPER_TRADING_FILE / HISTORY_FILE / AUDIT_LOG_FILE 等），语义不变——
 * 重定向优先级高于本常量。
 */
export const DATA_ROOT = path.join(import.meta.dirname, '..', 'data');

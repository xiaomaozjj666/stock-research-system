import { fetchFinancialData } from '../services/dataFetcher.js';
import { fetchQuarterlyFinancials } from '../services/quarterlyFinancials.js';
import { withQuantCache } from './quantCache.js';

/**
 * 基本面数据的量化侧缓存（2026-09-05 新增）。
 *
 * 背景：截面评估每只股票要拉三份数据——K线 + 年报快照 + 季度财报序列，
 * 即每次运行 3N 次网络调用。K线已改为合并历史增量补尾（见 dataProvider），
 * 而这两份基本面数据此前**完全没有缓存**，每次运行都全量重打。
 *
 * 财报是低频数据（季度更新），本模块把 3N 降到 1N（只剩 K 线的尾部补拉）。
 * 只在量化链路加缓存、不改 services 层共享函数——避免影响主分析流水线的
 * 数据新鲜度语义与既有测试。
 */

/**
 * 读 env 数值得到 TTL（毫秒）。语义（与 benchmarkSecidForMarket 同口径，便于热改与测试）：
 * - 未设置 / 空白 / 非数字 → 回落默认小时数；
 * - **显式 0 或负值 → 返回 0，即关闭该缓存**（withQuantCache 据此旁路）。
 *   测试逐用例 mock 返回值会与缓存冲突，全局 setup 默认据此关掉基本面缓存。
 */
function ttlFromEnv(key: string, defaultHours: number): number {
  const raw = process.env[key];
  if (raw !== undefined && raw.trim() !== '') {
    const hours = Number(raw);
    if (Number.isFinite(hours)) return hours > 0 ? hours * 60 * 60 * 1000 : 0;
  }
  return defaultHours * 60 * 60 * 1000;
}

/**
 * 年报/财务快照缓存。默认 24 小时。
 * 注：fetchFinancialData 也被主分析流水线调用，此处只缓存量化链路，
 * 流水线的实时性语义不受影响。
 */
export async function fetchFinancialDataCached(code: string) {
  return withQuantCache(
    `financial_${code}`,
    ttlFromEnv('QUANT_FINANCIAL_CACHE_TTL_HOURS', 24),
    () => fetchFinancialData(code),
  );
}

/**
 * 季度财报序列缓存。默认 7 天（168h）——财报按季度更新，无需更频繁。
 * limit 参与缓存 key，不同长度请求各自缓存。
 */
export async function fetchQuarterlyFinancialsCached(code: string, limit = 16) {
  return withQuantCache(
    `quarterly_${code}_${limit}`,
    ttlFromEnv('QUANT_QUARTERLY_CACHE_TTL_HOURS', 168),
    () => fetchQuarterlyFinancials(code, limit),
  );
}

/**
 * 基本面数据获取器注册表（依赖倒置，打破 quant ↔ services 包级循环）
 * ----------------------------------------------------------------------------
 * quant/fundamentalCache 需要「拉年报快照 + 拉季度财报」的能力，而实现位于上层的
 * services（dataFetcher / quarterlyFinancials）——底层包直接 import 上层包构成了
 * quant → services → quant 的循环。
 *
 * 现在：本模块（shared，不依赖任何一侧）只定义接口与注册表；组合根
 * （server/src/index.ts）在启动时显式 registerFundamentalFetchers() 注入生产实现。
 * 未显式注册时（如 quant 链路单测）通过动态 import 惰性装配——这不是静态依赖，
 * 且 vitest 的 vi.mock 对动态 import 同样生效，既有测试零改动；
 * CI 的 check:deps 脚本禁止 quant/shared 出现对 services 的**静态** import。
 */
import type { FinancialData } from '../types.js';
import type { QuarterlySeries } from './quarterlyTypes.js';

export interface FundamentalFetchers {
  fetchFinancialData: (code: string) => Promise<FinancialData>;
  fetchQuarterlyFinancials: (code: string, limit?: number) => Promise<QuarterlySeries>;
}

let registered: FundamentalFetchers | null = null;

/** 组合根显式注入生产实现（启动时调用一次；重复调用以后者为准，便于测试替换） */
export function registerFundamentalFetchers(fetchers: FundamentalFetchers): void {
  registered = fetchers;
}

/**
 * 解析当前可用的获取器。
 * 已注册 → 直接用；未注册 → 动态 import 生产实现（每次现取，不做模块级缓存，
 * 避免测试间 mock 切换被旧实现污染）。
 */
export async function resolveFundamentalFetchers(): Promise<FundamentalFetchers> {
  if (registered) return registered;
  const [{ fetchFinancialData }, { fetchQuarterlyFinancials }] = await Promise.all([
    import('../services/dataFetcher.js'),
    import('../services/quarterlyFinancials.js'),
  ]);
  return { fetchFinancialData, fetchQuarterlyFinancials };
}

import { fetchValuationData, fetchBoardInfo } from './dataFetcher.js';
import { resolveIndustry, getPeerCodes } from '../data/industryPeers.js';

export interface PeerComparisonEntry {
  name: string;
  code: string;
  pe: number;
  pb: number;
  roe: number;
  marketCap: number;
}

/**
 * 解析股票所属行业。
 * 优先级：传入的 industryHint（生产环境下来自主数据）-> datacenter BOARD_NAME 反查 -> 代码反查。
 * 返回标准行业名（与 industryPeers 参考表一致），未命中返回空串。
 */
export async function resolveStockIndustry(
  selfCode: string,
  industryHint?: string,
): Promise<string> {
  const hint = industryHint && industryHint.trim() ? industryHint.trim() : undefined;
  if (hint) {
    const norm = resolveIndustry(undefined, selfCode) ?? resolveIndustry(hint, selfCode);
    if (norm) return norm;
  }
  const board = await fetchBoardInfo(selfCode);
  const fromBoard = resolveIndustry(board?.boardName, selfCode);
  return fromBoard ?? '';
}

/**
 * 构建同业估值对比。
 * - 同业代码来自行业参考表（A股真实可比公司）。
 * - 估值（PE/PB/总市值）与证券简称均实时拉取（datacenter，可达）。
 * - 适用于主数据（push2 全表）不可达的环境，同时保留生产环境下主表优先的能力。
 */
export async function buildPeerComparison(
  selfCode: string,
  industryHint?: string,
): Promise<PeerComparisonEntry[]> {
  const industry = await resolveStockIndustry(selfCode, industryHint);
  const codes = getPeerCodes(industry || undefined, selfCode, 4);
  if (codes.length === 0) return [];

  const peers = await Promise.all(
    codes.map(async (code): Promise<PeerComparisonEntry | null> => {
      try {
        const [v, board] = await Promise.all([fetchValuationData(code), fetchBoardInfo(code)]);
        return {
          name: board?.name || '',
          code,
          pe: v.pe || 0,
          pb: v.pb || 0,
          roe: 0,
          marketCap: v.marketCap || 0,
        };
      } catch {
        return null;
      }
    }),
  );

  return peers.filter((p): p is PeerComparisonEntry => p !== null);
}

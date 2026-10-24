import { getPeerCodes, resolveIndustry } from '../data/industryPeers.js';
import { fetchBoardInfo, fetchValuationData } from './dataFetcher.js';

export interface PeerComparisonEntry {
  name: string;
  code: string;
  pe: number;
  pb: number;
  /**
   * 同业 ROE：上游估值接口（RPT_VALUEANALYSIS_DET）不提供该字段，恒为 null。
   * 此前硬编码 0 会被下游当成「真实 ROE 为 0」参与截面统计（拉低行业均值），
   * 消费方按 null 识别「无数据」并跳过（见 scoreEngine 的截面退化）。
   */
  roe: number | null;
  marketCap: number;
  /** true = 该同业亏损（PE 为负，H-1 口径下 pe 置 0），展示层应披露「亏损」 */
  peUnavailable?: boolean;
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
          // M-2: pe 保留上游真实值（H-1 口径下亏损股为 0 + peUnavailable 标注），
          // 不再 `v.pe || 0` 清零——负值/0 与「有真实 PE」必须可区分，报告层才能展示「亏损」。
          pe: v.pe,
          pb: v.pb,
          roe: null, // 上游估值接口无同业 ROE 字段（见接口注释），显式 null 而非误导性的 0
          marketCap: v.marketCap,
          peUnavailable: v.peUnavailable,
        };
      } catch {
        return null;
      }
    }),
  );

  return peers.filter((p): p is PeerComparisonEntry => p !== null);
}

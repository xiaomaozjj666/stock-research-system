import type { OHLCVData } from '../types.js';

/**
 * 按日期范围过滤 K 线（look-ahead 防御，借鉴 TradingAgents stockstats_utils）：
 * 剔除 endDate 之后（未来数据——回测混入未来行会让 Sharpe/回撤失真）
 * 与 startDate 之前（越界数据）的行；返回保留行数与剔除行数。
 *
 * 解析层（provider 内部）与返回前（dataProvider 统一兜底）共用同一份实现，
 * 保证「源内过滤」与「出口过滤」口径一致。
 */
export function filterOHLCVByRange(
  data: OHLCVData[],
  startDate: string,
  endDate: string,
): { data: OHLCVData[]; trimmed: number } {
  const start = startDate.replace(/-/g, '');
  const end = endDate.replace(/-/g, '');
  const kept: OHLCVData[] = [];
  let trimmed = 0;
  for (const d of data) {
    const ymd = d.date.replace(/-/g, '');
    if (ymd < start || ymd > end) {
      trimmed++;
    } else {
      kept.push(d);
    }
  }
  return { data: kept, trimmed };
}

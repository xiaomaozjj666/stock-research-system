import type { OHLCVData, DataQualityReport } from '../types.js';

/**
 * 数据工程师Agent - 数据质量检查（纯函数）
 */
export function dataEngineer(data: OHLCVData[]): DataQualityReport {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 100;

  // --- 基础统计 ---
  const totalRecords = data.length;
  const dates = data.map((d) => d.date);
  const sortedDates = [...dates].sort();
  const start = sortedDates[0] ?? '';
  const end = sortedDates[sortedDates.length - 1] ?? '';

  // --- 1. 重复日期检查 ---
  const dateCounts = new Map<string, number>();
  for (const d of dates) {
    dateCounts.set(d, (dateCounts.get(d) ?? 0) + 1);
  }
  const duplicates: string[] = [];
  for (const [date, count] of dateCounts) {
    if (count > 1) duplicates.push(date);
  }
  if (duplicates.length > 0) {
    score -= duplicates.length * 5;
    issues.push(
      `发现 ${duplicates.length} 个重复日期: ${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? '...' : ''}`,
    );
    suggestions.push('去除重复日期的数据记录');
  }

  // --- 2. 时间戳一致性检查 ---
  let timestampOrdered = true;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] < dates[i - 1]) {
      timestampOrdered = false;
      break;
    }
  }
  if (!timestampOrdered) {
    score -= 10;
    issues.push('日期未按升序排列');
    suggestions.push('按日期升序重新排列数据');
  }

  // --- 3. 缺失交易日检查 ---
  const existingDateSet = new Set(dates);
  const missingDates = findMissingTradingDays(start, end, existingDateSet);
  if (missingDates.length > 0) {
    // 法定节假日容差：A 股每年约 12-14 个工作日休市（纯函数拿不到真实交易日历），
    // 按跨度每月 ~1 个工作日给容差、仅对超出部分扣分——否则 2 年回测约 26 个节假日
    // 工作日会扣 52 分，把完美真实数据的质量分系统性打崩（模拟数据反而得满分）
    const spanDays =
      (new Date(end + 'T00:00:00').getTime() - new Date(start + 'T00:00:00').getTime()) / 86400000;
    const holidayTolerance = Math.floor(Math.max(0, spanDays) / 30);
    const excessMissing = missingDates.length - holidayTolerance;
    if (excessMissing > 0) {
      score -= excessMissing * 2;
      issues.push(`发现 ${missingDates.length} 个缺失交易日`);
      suggestions.push('补充缺失交易日数据或确认停牌信息');
    }
  }

  // --- 4. 异常值检查 ---
  const outliers: DataQualityReport['outliers'] = [];

  // 去重后的数据用于异常值检查
  const uniqueData = deduplicateData(data);

  for (let i = 1; i < uniqueData.length; i++) {
    const prev = uniqueData[i - 1];
    const curr = uniqueData[i];

    // 价格涨跌幅检查（超过±11%）
    if (prev.close !== 0) {
      const priceChange = ((curr.close - prev.close) / prev.close) * 100;
      if (Math.abs(priceChange) > 11) {
        outliers.push({
          date: curr.date,
          field: 'close',
          value: priceChange,
          expected: '涨跌幅应在±11%以内',
        });
      }
    }

    // 成交量为0
    if (curr.volume === 0) {
      outliers.push({
        date: curr.date,
        field: 'volume',
        value: 0,
        expected: '成交量应大于0',
      });
    }
  }

  // 成交量异常（超过平均值的10倍）
  const avgVolume = uniqueData.reduce((s, d) => s + d.volume, 0) / (uniqueData.length || 1);
  for (const d of uniqueData) {
    if (d.volume > avgVolume * 10 && d.volume > 0) {
      outliers.push({
        date: d.date,
        field: 'volume',
        value: d.volume,
        expected: `成交量应在平均值(${Math.round(avgVolume)})的10倍以内`,
      });
    }
  }

  if (outliers.length > 0) {
    score -= outliers.length * 3;
    issues.push(`发现 ${outliers.length} 个异常值`);
    suggestions.push('检查并处理异常价格/成交量数据');
  }

  // --- 最终评分 ---
  score = Math.max(0, score);
  const tradingDays = uniqueData.length;

  return {
    overallScore: score,
    totalRecords,
    missingDates,
    outliers,
    duplicates,
    issues,
    suggestions,
    dataRange: { start, end, tradingDays },
  };
}

// --- 辅助函数 ---

/** 计算两个日期之间的预期交易日（排除周末），返回缺失的 */
function findMissingTradingDays(start: string, end: string, existingDates: Set<string>): string[] {
  if (!start || !end) return [];
  const missing: string[] = [];
  const current = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');

  while (current <= endDate) {
    const day = current.getDay();
    // 跳过周末
    if (day !== 0 && day !== 6) {
      const dateStr = formatDate(current);
      if (!existingDates.has(dateStr)) {
        missing.push(dateStr);
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return missing;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 去重（保留第一条） */
function deduplicateData(data: OHLCVData[]): OHLCVData[] {
  const seen = new Set<string>();
  const result: OHLCVData[] = [];
  for (const d of data) {
    if (!seen.has(d.date)) {
      seen.add(d.date);
      result.push(d);
    }
  }
  return result;
}

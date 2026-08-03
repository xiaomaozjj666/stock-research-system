/**
 * 自选股主动预警（纯函数，可单测）
 * 基于批量新闻回测报告的逐股新闻信号，检测需要关注的异动：
 *  - 强烈看多 / 强烈看空（|polarity| 超过阈值）
 *  - 高影响强度（weightedImpact 超过阈值）
 * 不含网络/调度，调用方可自行决定如何推送（前端轮询 / 邮件 / 定时任务）。
 */
export interface WatchlistAlertInput {
  code: string;
  name: string | null;
  newsSentiment?: { polarity: number; weightedImpact: number; hasNews: boolean } | null;
}

export interface WatchlistAlert {
  code: string;
  name: string | null;
  level: 'strong-bull' | 'strong-bear' | 'high-impact';
  polarity: number;
  weightedImpact: number;
  detail: string;
}

// 阈值（保守，避免噪声）
const STRONG_POLARITY = 0.5;
const HIGH_IMPACT = 0.6;

export function detectAlerts(rows: WatchlistAlertInput[]): WatchlistAlert[] {
  const alerts: WatchlistAlert[] = [];
  for (const r of rows) {
    const ns = r.newsSentiment;
    if (!ns || !ns.hasNews) continue;
    const name = r.name ?? r.code;
    if (ns.polarity >= STRONG_POLARITY) {
      alerts.push({
        code: r.code,
        name,
        level: 'strong-bull',
        polarity: ns.polarity,
        weightedImpact: ns.weightedImpact,
        detail: `${name} 新闻姿态强烈看多（polarity=${ns.polarity.toFixed(2)}）`,
      });
    } else if (ns.polarity <= -STRONG_POLARITY) {
      alerts.push({
        code: r.code,
        name,
        level: 'strong-bear',
        polarity: ns.polarity,
        weightedImpact: ns.weightedImpact,
        detail: `${name} 新闻姿态强烈看空（polarity=${ns.polarity.toFixed(2)}）`,
      });
    }
    if (ns.weightedImpact >= HIGH_IMPACT) {
      alerts.push({
        code: r.code,
        name,
        level: 'high-impact',
        polarity: ns.polarity,
        weightedImpact: ns.weightedImpact,
        detail: `${name} 新闻影响强度高（weightedImpact=${ns.weightedImpact.toFixed(2)}）`,
      });
    }
  }
  return alerts;
}

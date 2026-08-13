import { runBacktest } from '../quant/backtestEngine.js';
import type { OHLCVData, StrategyConfig } from '../quant/types.js';

/** 新闻叠加后的对比指标 */
export interface NewsAwareMetrics {
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  /** 新闻姿态 posture = clamp(0.5 + 0.5·polarity, 0, 1) */
  posture: number;
}

/** 策略推荐结果 */
export interface StrategyRecommendation {
  strategyType: string;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalReturn: number;
  applicableMarket: string;
  fatalWeakness: string;
  backtestWarning: string;
  /** 含最新消息情绪叠加层的回测对比（仅当传入 newsSignal 时存在） */
  newsAware?: NewsAwareMetrics;
}

export async function generateStrategyList(
  stockCode: string,
  ohlcvData: OHLCVData[],
  newsSignal?: { polarity: number } | null,
): Promise<StrategyRecommendation[]> {
  const strategies: StrategyRecommendation[] = [];

  // 对3种策略分别运行回测
  const strategyConfigs: {
    name: string;
    type: StrategyConfig['type'];
    params: Record<string, number>;
  }[] = [
    { name: '均线交叉', type: 'ma_cross', params: { shortPeriod: 5, longPeriod: 20 } },
    {
      name: '动量策略',
      type: 'momentum',
      params: { lookback: 20, buyThreshold: 5, sellThreshold: -3 },
    },
    {
      name: '均值回归',
      type: 'mean_reversion',
      params: { maPeriod: 20, buyDeviation: -3, sellDeviation: 3 },
    },
  ];

  for (const config of strategyConfigs) {
    try {
      const strategyConfig: StrategyConfig = {
        name: config.name,
        type: config.type,
        stockCode,
        params: config.params,
        startDate: ohlcvData[0]?.date ?? '',
        endDate: ohlcvData[ohlcvData.length - 1]?.date ?? '',
      };

      const result = runBacktest(ohlcvData, strategyConfig);

      const rec: StrategyRecommendation = {
        strategyType: config.name,
        sharpeRatio: Math.round(result.sharpeRatio * 100) / 100,
        maxDrawdown: Math.round(result.maxDrawdown * 100) / 100,
        winRate: Math.round(result.winRate * 100) / 100,
        totalReturn: Math.round(result.totalReturn * 100) / 100,
        applicableMarket: getApplicableMarket(config.type),
        fatalWeakness: getFatalWeakness(config.type),
        backtestWarning: '历史回测结果不代表未来收益，存在过拟合和市场风格切换失效风险。',
      };

      // 若提供最新消息情绪，额外运行"含新闻"回测并对比
      if (newsSignal && isFinite(newsSignal.polarity)) {
        const awareConfig: StrategyConfig = {
          ...strategyConfig,
          newsOverlay: { polarity: newsSignal.polarity },
        };
        const aware = runBacktest(ohlcvData, awareConfig);
        rec.newsAware = {
          totalReturn: Math.round(aware.totalReturn * 100) / 100,
          sharpeRatio: Math.round(aware.sharpeRatio * 100) / 100,
          maxDrawdown: Math.round(aware.maxDrawdown * 100) / 100,
          winRate: Math.round(aware.winRate * 100) / 100,
          posture: aware.newsPosture ?? 1,
        };
      }

      strategies.push(rec);
    } catch {
      // 策略运行失败时跳过
    }
  }

  // 按夏普比率排序
  return strategies.sort((a, b) => b.sharpeRatio - a.sharpeRatio);
}

function getApplicableMarket(type: string): string {
  switch (type) {
    case 'ma_cross':
      return '趋势明确的单边行情，如牛市主升浪或熊市主跌浪';
    case 'momentum':
      return '强势股持续走强的高动量环境，成交量配合良好';
    case 'mean_reversion':
      return '震荡市或区间波动市场，价格在均值附近反复';
    default:
      return '未知';
  }
}

function getFatalWeakness(type: string): string {
  switch (type) {
    case 'ma_cross':
      return '震荡市中频繁产生假信号，导致连续小额亏损（whipsaw效应）';
    case 'momentum':
      return '动量崩溃时回撤极大，如市场风格突然切换、黑天鹅事件';
    case 'mean_reversion':
      return '趋势行情中逆势操作，可能遭遇单边暴跌导致巨额亏损';
    default:
      return '未知';
  }
}

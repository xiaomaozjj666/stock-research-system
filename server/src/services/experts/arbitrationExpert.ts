import type { FinancialData, ValuationData, StockInfo, ExpertOpinion, ControversyPoint } from '../../types.js';

export interface ArbitrationInput {
  financial: FinancialData;
  valuation: ValuationData;
  info: StockInfo;
  opinions: ExpertOpinion[];
}

export function arbitrationExpert(input: ArbitrationInput): {
  controversies: ControversyPoint[];
  finalOpinion: ExpertOpinion;
} {
  const { opinions, financial, valuation } = input;
  const n = financial.years.length;

  // === 统计各专家情绪 ===
  const bullishCount = opinions.filter(o => o.overallSentiment === 'bullish').length;
  const bearishCount = opinions.filter(o => o.overallSentiment === 'bearish').length;
  const neutralCount = opinions.filter(o => o.overallSentiment === 'neutral').length;

  // === 识别共识点：多个专家在 arguments 中一致认同的方向 ===
  const consensusPoints: string[] = [];
  const divergencePoints: string[] = [];

  // 提取所有 support/oppose 论点的关键主题词
  const themeKeywords = [
    '毛利率', 'ROE', '现金流', '应收', '商誉', '负债', '增速', '估值',
    'PE', 'PEG', '存货', '利润', '分红', '行业', '集中度', '竞争',
    '景气', '风险', '减值', '杠杆'
  ];

  // 共识：同一主题被 3+ 个专家以相同方向提及
  for (const keyword of themeKeywords) {
    const supportExperts = opinions.filter(o =>
      o.arguments.some(a => a.type === 'support' && a.text.includes(keyword))
    );
    const opposeExperts = opinions.filter(o =>
      o.arguments.some(a => a.type === 'oppose' && a.text.includes(keyword))
    );

    if (supportExperts.length >= 3) {
      consensusPoints.push(`${keyword}表现积极`);
    } else if (opposeExperts.length >= 3) {
      consensusPoints.push(`${keyword}存在隐忧`);
    }
  }

  // 分歧：同一主题既有 support 又有 oppose
  for (const keyword of themeKeywords) {
    const supporters = opinions.filter(o =>
      o.arguments.some(a => a.type === 'support' && a.text.includes(keyword))
    );
    const opposers = opinions.filter(o =>
      o.arguments.some(a => a.type === 'oppose' && a.text.includes(keyword))
    );

    if (supporters.length > 0 && opposers.length > 0) {
      divergencePoints.push(keyword);
    }
  }

  // === 动态生成争议话题 ===
  const controversies: ControversyPoint[] = [];

  // 争议话题生成器：基于分歧关键词
  const topicTemplates: Record<string, (fin: FinancialData, val: ValuationData) => ControversyPoint | null> = {
    '估值': (fin, val) => {
      const peValues = val.historicalPE.map(h => h.pe).sort((a, b) => a - b);
      const pePercentile = (peValues.filter(p => p <= val.pe).length / peValues.length) * 100;
      const peerAvgPE = val.peerComparison.reduce((s, p) => s + p.pe, 0) / val.peerComparison.length;
      return {
        topic: '当前估值水平是否合理',
        bullishView: `PE ${val.pe}x处于历史${pePercentile.toFixed(0)}%分位，估值偏低或合理，具备安全边际`,
        bearishView: `PE较同业均值${peerAvgPE.toFixed(1)}x存在溢价，估值中枢可能进一步下移`,
        arbitration: `当前PE处于历史${pePercentile.toFixed(0)}%分位，${pePercentile <= 40 ? '确实偏低，安全边际较高' : pePercentile <= 60 ? '处于合理区间' : '估值偏高，需要高增长支撑'}。但需结合行业周期和增速综合判断。`,
        confidence: 68
      };
    },
    '增速': (fin, _val) => {
      const latestGrowth = (fin.netProfit[n - 1] - fin.netProfit[n - 2]) / fin.netProfit[n - 2] * 100;
      const avgGrowth = n >= 2 ? (Math.pow(fin.netProfit[n - 1] / fin.netProfit[0], 1 / (n - 1)) - 1) * 100 : 0;
      return {
        topic: '利润增速能否持续',
        bullishView: `历史复合增长率${avgGrowth.toFixed(1)}%，最新增速${latestGrowth.toFixed(1)}%，增长基础扎实`,
        bearishView: `增速从高点回落至${latestGrowth.toFixed(1)}%，基数效应和行业压力加大`,
        arbitration: `增速趋势${latestGrowth > avgGrowth ? '仍在加速' : '已放缓'}，需关注行业周期和竞争格局变化对增长持续性的影响。`,
        confidence: 65
      };
    },
    '毛利率': (fin, _val) => {
      const avgGM = fin.grossMargin.reduce((a, b) => a + b, 0) / n;
      const gmTrend = fin.grossMargin[n - 1] - fin.grossMargin[0];
      return {
        topic: '毛利率趋势与竞争格局',
        bullishView: `平均毛利率${avgGM.toFixed(1)}%，${gmTrend > 0 ? '且呈上升趋势' : '保持稳定'}，定价权和成本控制力强`,
        bearishView: `毛利率${gmTrend < 0 ? '呈下降趋势' : '波动较大'}，行业竞争可能加剧`,
        arbitration: `毛利率${gmTrend > 3 ? '改善明显' : gmTrend < -3 ? '承压下行' : '基本稳定'}，${avgGM > 40 ? '整体处于较高水平' : '处于中等水平'}，需持续跟踪行业竞争态势。`,
        confidence: 66
      };
    },
    '现金流': (fin, _val) => {
      const avgCF = fin.operatingCashFlow.reduce((s, cf, i) => s + cf / fin.netProfit[i], 0) / n;
      return {
        topic: '利润含金量与现金流质量',
        bullishView: `经营现金流/净利润均值${avgCF.toFixed(2)}，利润转化为真金白银的能力强`,
        bearishView: avgCF < 0.5 ? `现金流/净利润仅${avgCF.toFixed(2)}，盈利质量存疑` : '现金流波动较大，需关注季节性因素',
        arbitration: `现金流/净利润${avgCF.toFixed(2)}，${avgCF > 0.8 ? '盈利质量可靠' : avgCF > 0.5 ? '盈利质量中等' : '盈利质量需重点关注'}。`,
        confidence: 70
      };
    },
    '行业': (fin, val) => {
      const avgRevGrowth = n >= 2 ? ((fin.revenue[n - 1] / fin.revenue[0]) ** (1 / (n - 1)) - 1) * 100 : 0;
      return {
        topic: '行业前景与公司竞争地位',
        bullishView: `行业增速${avgRevGrowth.toFixed(1)}%，龙头竞争优势明显，集中度提升利好头部企业`,
        bearishView: avgRevGrowth < 5 ? `行业增速放缓至${avgRevGrowth.toFixed(1)}%，总量见顶风险` : '行业竞争格局存在不确定性',
        arbitration: `行业处于${avgRevGrowth > 10 ? '成长期' : avgRevGrowth > 0 ? '成熟期' : '收缩期'}，龙头凭借品牌和规模优势仍可维持相对增长，但行业β机会${avgRevGrowth > 10 ? '较强' : '减弱'}。`,
        confidence: 63
      };
    },
    '负债': (fin, _val) => {
      const latestDR = fin.debtRatio[n - 1];
      return {
        topic: '财务杠杆与偿债风险',
        bullishView: `资产负债率${latestDR.toFixed(1)}%，${latestDR < 40 ? '财务结构稳健' : '杠杆可控'}`,
        bearishView: latestDR > 60 ? `负债率${latestDR.toFixed(1)}%偏高，偿债压力较大` : '负债率变化趋势需持续关注',
        arbitration: `当前负债率${latestDR.toFixed(1)}%，${latestDR < 30 ? '极其稳健' : latestDR < 60 ? '处于合理范围' : '需要警惕'}，需结合行业特征和利率环境综合评估。`,
        confidence: 72
      };
    },
    '商誉': (fin, _val) => {
      const gwr = fin.goodwill[n - 1] / fin.equity[n - 1] * 100;
      return {
        topic: '商誉减值风险',
        bullishView: gwr === 0 ? '零商誉，完全无减值风险' : `商誉/净资产${gwr.toFixed(1)}%，风险可控`,
        bearishView: gwr > 30 ? `商誉/净资产${gwr.toFixed(1)}%，减值风险较大` : '商誉规模需持续关注',
        arbitration: `商誉/净资产${gwr.toFixed(1)}%，${gwr === 0 ? '无减值风险' : gwr < 20 ? '风险较低' : gwr < 40 ? '存在一定风险' : '风险较高，需密切跟踪被收购资产业绩'}。`,
        confidence: 75
      };
    }
  };

  // 按分歧点优先级生成争议话题（最多 5 个）
  const priorityOrder = ['估值', '增速', '毛利率', '现金流', '行业', '负债', '商誉'];
  for (const keyword of priorityOrder) {
    if (divergencePoints.includes(keyword) && controversies.length < 5 && topicTemplates[keyword]) {
      const topic = topicTemplates[keyword](financial, valuation);
      if (topic) controversies.push(topic);
    }
  }

  // 如果分歧不足但数据有看点，补充数据驱动的争议
  if (controversies.length < 2) {
    const latestProfitGrowth = (financial.netProfit[n - 1] - financial.netProfit[n - 2]) / financial.netProfit[n - 2] * 100;
    const avgROE = financial.roe.reduce((a, b) => a + b, 0) / n;
    controversies.push({
      topic: '未来增长确定性',
      bullishView: `ROE ${avgROE.toFixed(1)}%，基本面扎实，具备持续增长基础`,
      bearishView: `最新利润增速${latestProfitGrowth.toFixed(1)}%，${latestProfitGrowth < 5 ? '增长动力不足' : '增速存在波动'}`,
      arbitration: `基本面${avgROE > 15 ? '较优' : '一般'}，但增速${latestProfitGrowth > 10 ? '尚可' : '承压'}，需权衡确定性与弹性。`,
      confidence: 60
    });
  }

  // === 最终综合判断 ===
  const avgConfidence = opinions.reduce((s, o) => s + o.confidence, 0) / opinions.length;
  const supportArgs = opinions.flatMap(o => o.arguments.filter(a => a.type === 'support')).slice(0, 4);
  const opposeArgs = opinions.flatMap(o => o.arguments.filter(a => a.type === 'oppose')).slice(0, 3);

  const finalOpinion: ExpertOpinion = {
    expert: '数据仲裁官（综合研判）',
    arguments: [...supportArgs, ...opposeArgs],
    overallSentiment: bullishCount > bearishCount ? 'bullish' : neutralCount >= 2 ? 'neutral' : 'bearish',
    confidence: Math.round(avgConfidence),
    keyPoints: [
      consensusPoints.length > 0
        ? `专家共识：${consensusPoints.slice(0, 3).join('、')}`
        : '各专家观点较为分散，缺乏强共识',
      divergencePoints.length > 0
        ? `主要分歧：${divergencePoints.slice(0, 3).join('、')}`
        : '专家观点基本一致',
      `${bullishCount}位专家看多，${neutralCount}位中性，${bearishCount}位看空`,
      `综合${controversies.length}个争议话题的仲裁分析`,
      `整体置信度${Math.round(avgConfidence)}%，基于${opinions.length}位专家独立研判`
    ].slice(0, 6)
  };

  return { controversies, finalOpinion };
}

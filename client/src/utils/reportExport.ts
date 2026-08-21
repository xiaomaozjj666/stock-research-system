import type { AnalysisResult } from '../types';

/**
 * 研究报告导出：前端生成 Markdown 文本并触发下载（无需后端改动）。
 * 覆盖：核心摘要 / 评分评级 / 估值 / 专家观点 / 争议 / 风险 / 情景 / 策略 / 跟踪指标。
 */
export function generateReportMarkdown(result: AnalysisResult): string {
  const s = result.stock_pool[0];
  if (!s) return '';
  const lines: string[] = [];
  const push = (t = '') => lines.push(t);

  push(`# ${s.stock_name}（${s.stock_code}）研究报告`);
  push('');
  push(`> 行业：${s.industry}｜综合评分：**${s.total_score}**｜评级：**${s.rating}**`);
  // 记忆反思闭环：较上次分析的评分/评级演化（可选）
  if (s.vs_previous) {
    const v = s.vs_previous;
    const delta = v.score_delta;
    const arrow = delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : '＝ ';
    push(`> 较上次分析（${v.previous_date}）：**${arrow}${Math.round(delta * 100) / 100} 分**`);
    if (v.rating_changed) push(`> 评级演化：${v.previous_rating} → ${s.rating}`);
  }
  if (s.valuation?.currentPrice)
    push(
      `> 现价：¥${s.valuation.currentPrice}｜PE：${s.valuation.pe ?? '—'}｜PB：${s.valuation.pb ?? '—'}`,
    );
  push('');
  push('## 核心摘要');
  push(s.core_summary);
  push('');

  if (s.score_detail) {
    push('## 五维评分');
    push('| 维度 | 得分 |');
    push('| --- | --- |');
    push(`| 盈利质量 | ${s.score_detail.profit_quality} |`);
    push(`| 成长性 | ${s.score_detail.growth} |`);
    push(`| 估值性价比 | ${s.score_detail.valuation} |`);
    push(`| 行业景气度 | ${s.score_detail.industry_boom} |`);
    push(`| 风险水平 | ${s.score_detail.risk_deduction} |`);
    push('');
  }

  if (s.strengths.length > 0) {
    push('## 核心优势');
    s.strengths.forEach((x) => push(`- ${x}`));
    push('');
  }

  if (s.expert_opinions.length > 0) {
    push('## 专家观点');
    for (const o of s.expert_opinions) {
      const sentiment =
        o.overallSentiment === 'bullish'
          ? '看多'
          : o.overallSentiment === 'bearish'
            ? '看空'
            : '中性';
      push(`### ${o.expert}：${sentiment}（置信度 ${o.confidence}）`);
      for (const a of o.arguments) {
        push(`- [${a.type === 'support' ? '支持' : '反对'}] ${a.text}`);
      }
      push('');
    }
  }

  if (s.controversy_points.length > 0) {
    push('## 争议焦点');
    for (const c of s.controversy_points) {
      push(`- **${c.topic}**（置信度 ${c.confidence}）`);
      push(`  - 看多：${c.bullishView}`);
      push(`  - 看空：${c.bearishView}`);
      push(`  - 仲裁：${c.arbitration}`);
    }
    push('');
  }

  if (s.risk_list.length > 0) {
    push('## 风险清单');
    s.risk_list.forEach((x) => push(`- ${x}`));
    push('');
  }

  if (s.scenarios && s.scenarios.length > 0) {
    push('## 情景推演');
    for (const sc of s.scenarios) {
      push(
        `- **${sc.name}（概率 ${sc.probability}%）**：目标区间 ${sc.targetPriceRange.low} ~ ${sc.targetPriceRange.high}`,
      );
      for (const k of sc.keyAssumptions) push(`  - 假设：${k}`);
      for (const p of sc.preconditions) push(`  - 触发：${p}`);
    }
    push('');
  }

  if (s.strategyList && s.strategyList.length > 0) {
    push('## 量化策略');
    for (const st of s.strategyList) {
      push(
        `- **${st.strategyType}**：夏普 ${st.sharpeRatio}｜回撤 ${st.maxDrawdown}%｜胜率 ${st.winRate}%｜累计收益 ${st.totalReturn}%`,
      );
      if (st.fatalWeakness) push(`  - 致命弱点：${st.fatalWeakness}`);
      if (st.backtestWarning) push(`  - 回测警示：${st.backtestWarning}`);
    }
    push('');
  }

  if (s.follow_up_indicators.length > 0) {
    push('## 后续跟踪指标');
    s.follow_up_indicators.forEach((x) => push(`- [ ] ${x}`));
    push('');
  }

  push('---');
  push('> 本报告由 AI 多专家投研系统自动生成，基于公开数据模拟分析，不构成投资建议。');
  return lines.join('\n');
}

/** 触发浏览器下载（Blob + a[download]） */
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

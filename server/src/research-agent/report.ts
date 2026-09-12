/**
 * 报告渲染：ResearchReport -> Markdown
 * 确定性纯函数，无 LLM 参与。引用编号按报告分节顺序统一编排，
 * 每条引用附带获取路径（轮次/查询词/适配器），保证可审计。
 */
import type { EvidenceConflict, ResearchReport } from './types.js';
import { SOURCE_TIER } from './types.js';

const DIMENSION_LABEL: Record<EvidenceConflict['dimension'], string> = {
  numeric: '数值',
  temporal: '时间',
  causal: '因果',
  factual: '事实',
  caliber: '口径',
};

const RESOLUTION_LABEL: Record<EvidenceConflict['resolution'], string> = {
  a_wins: '采信前者',
  b_wins: '采信后者',
  both_partially_true: '两者各部分成立',
  unresolved: '未决',
};

/** 分节状态 -> 中文展示标签 */
const STATUS_LABEL: Record<string, string> = {
  consistent: '多源一致',
  partial_conflict: '部分出入',
  contradictory: '存在矛盾',
  insufficient: '证据不足',
  blocked: '受阻',
  not_verified: '未验证',
};

export function renderReportMarkdown(report: ResearchReport): string {
  const lines: string[] = [];

  lines.push(`# ${report.title}`, '');
  lines.push(
    `> 总体置信度: **${report.confidenceLabel}** (${report.overallConfidence}) · 生成时间: ${report.generatedAt.slice(0, 19).replace('T', ' ')}`,
    '',
  );

  lines.push('## 执行摘要', '', report.executiveSummary || '（无）', '');

  lines.push('## 方法说明', '');
  const m = report.methodology;
  lines.push(
    `- 编排轮次: ${m.rounds} 轮 · 证据 ${m.evidenceCount} 条（来自 ${m.sourceCount} 个独立来源）`,
    `- 检索通道: ${m.adaptersUsed.length > 0 ? m.adaptersUsed.join(' -> ') : '无'}（含降级顺序）`,
    `- 计划版本: v${m.planVersions} · 证据冲突 ${m.conflictsFound} 处`,
    '',
  );

  lines.push('## 主要发现', '');
  let citeNo = 0;
  for (const section of report.sections) {
    lines.push(`### ${section.question}`, '');
    const statusText = STATUS_LABEL[section.status] ?? section.status;
    lines.push(
      `**结论**（置信度: ${section.confidenceLabel} ${section.confidence} / 状态: ${statusText}）：${section.conclusion}`,
      '',
    );
    if (section.citations.length > 0) {
      lines.push('**依据**:');
      for (const c of section.citations) {
        citeNo += 1;
        const parts = [
          `第 ${c.path.round} 轮`,
          `查询词"${c.path.query}"`,
          `通道 ${c.path.adapter}`,
          `第 ${c.path.attempt} 次尝试`,
        ];
        if (c.path.fallbackOf) parts.push(`由 ${c.path.fallbackOf} 降级`);
        lines.push(
          `${citeNo}. ${c.claim} — ${c.sourceTitle}（${SOURCE_TIER[c.sourceType].label}${c.publisher ? ` · ${c.publisher}` : ''}${c.publishedAt ? ` · ${c.publishedAt.slice(0, 10)}` : ''}）获取路径: ${parts.join(' · ')}`,
        );
      }
      lines.push('');
    }
    if (section.conflictNotes.length > 0) {
      lines.push('**冲突与口径说明**:', ...section.conflictNotes.map((n) => `- ${n}`), '');
    }
  }

  if (report.conflicts.length > 0) {
    lines.push('## 数据与口径差异', '');
    for (const c of report.conflicts) {
      lines.push(
        `- [${DIMENSION_LABEL[c.dimension]}] ${c.description} → ${RESOLUTION_LABEL[c.resolution]}${c.resolutionReason ? `（${c.resolutionReason}）` : ''}`,
      );
    }
    lines.push('');
  }

  lines.push('## 局限性与未决问题', '');
  lines.push(...report.limitations.map((l) => `- ${l}`), '');

  return lines.join('\n');
}

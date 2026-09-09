/**
 * 对话技能路由（Skill Router）
 * ------------------------------------------------------------------
 * 借鉴 reverse-skill 的「按任务类型路由到专用技能模块」：先用确定性的规则表
 * 判定意图，命中就带着 skill 标签进入对应技能（各自的工具链与提示词），
 * 不必让一个巨型 prompt 承担所有场景。
 *
 * 与 chatAgent 现有 AgentPlan（direct/tools/debate）的关系：那层决定「走不走
 * 工具」，这一层决定「走哪个技能」，两者正交——先粗判执行路径，再细分技能。
 * 规则表是纯函数，便于写回归基准（见 __tests__/skillRouter.test.ts）。
 */

export type SkillId = 'quant_factor' | 'backtest' | 'news' | 'compare' | 'watchlist' | 'chat';

export interface SkillRoute {
  skill: SkillId;
  /** 置信度 0-1（规则命中为高，兜底为低） */
  confidence: number;
  reason: string;
}

interface SkillRule {
  skill: SkillId;
  pattern: RegExp;
  reason: string;
}

/** 顺序敏感：越具体的技能越靠前（对比/因子优先于泛化的回测） */
const RULES: SkillRule[] = [
  {
    skill: 'compare',
    pattern: /对比|比较|\bvs\b|versus|谁更|谁强|哪个更好/,
    reason: '多标的横向比较',
  },
  {
    skill: 'quant_factor',
    // (?<!自) 排除"自选股"——否则"自选股监控"会被 选股 命中而错投因子技能
    pattern: /因子|截面|\bIC\b|阿尔法|\balpha\b|(?<!自)选股|有效性|单调性|分层/,
    reason: '因子有效性/截面评估',
  },
  {
    skill: 'backtest',
    pattern: /回测|策略|均线|动量|均值回归|夏普|胜率|最大回撤|参数优化/,
    reason: '策略回测与参数',
  },
  { skill: 'news', pattern: /新闻|消息|公告|舆情|情绪|利好|利空/, reason: '新闻与情绪' },
  { skill: 'watchlist', pattern: /自选|持仓|监控|预警|异动|盯盘/, reason: '自选股与异动监控' },
];

export function routeSkill(message: string): SkillRoute {
  const text = String(message ?? '');
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { skill: rule.skill, confidence: 0.9, reason: rule.reason };
    }
  }
  return { skill: 'chat', confidence: 0.6, reason: '未命中专用技能，走通用研究对话' };
}

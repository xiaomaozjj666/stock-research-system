import { describe, it, expect } from 'vitest';
import { routeSkill, type SkillId } from '../skillRouter.js';

/**
 * 技能路由回归基准。
 * 规则表一旦改动导致某个既有问法被路由到别的技能，这里会立刻失败——
 * 这正是 reverse-skill 用回归基准守住路由表的原因。
 */
const CASES: { message: string; skill: SkillId }[] = [
  { message: '帮我对比 600519 和 000858 的估值', skill: 'compare' },
  { message: '茅台和五粮液谁更值得买', skill: 'compare' },
  { message: '这个因子的截面 IC 显著吗', skill: 'quant_factor' },
  { message: '跑一下白酒板块的阿尔法因子有效性', skill: 'quant_factor' },
  { message: '用均线交叉策略回测一下，看夏普和最大回撤', skill: 'backtest' },
  { message: '动量策略的参数怎么优化', skill: 'backtest' },
  { message: '最近关于这只股票的新闻情绪如何', skill: 'news' },
  { message: '有什么利好利空公告', skill: 'news' },
  { message: '把自选股加一下并监控异动预警', skill: 'watchlist' },
  { message: '你好，今天行情怎么样', skill: 'chat' },
];

describe('routeSkill 回归基准', () => {
  for (const c of CASES) {
    it(`「${c.message}」→ ${c.skill}`, () => {
      const r = routeSkill(c.message);
      expect(r.skill).toBe(c.skill);
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(0);
    });
  }

  it('未命中任何技能 → chat 且置信度较低', () => {
    const r = routeSkill('随便聊聊');
    expect(r.skill).toBe('chat');
    expect(r.confidence).toBeLessThan(0.9);
  });

  it('顺序敏感：同时含对比与因子关键词时，更具体的 compare 优先', () => {
    expect(routeSkill('对比两个因子的有效性').skill).toBe('compare');
  });
});

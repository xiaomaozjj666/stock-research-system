import { describe, it, expect } from 'vitest';
import { resolveIndustry, getPeerCodes, CODE_TO_INDUSTRY } from '../industryPeers.js';

describe('resolveIndustry', () => {
  it('通过 BOARD_NAME 反查行业（含罗马数字序号）', () => {
    expect(resolveIndustry('白酒Ⅱ', '600519')).toBe('白酒');
    expect(resolveIndustry('股份制银行Ⅲ', '600036')).toBe('银行');
  });

  it('通过代码反查行业优先于 BOARD_NAME', () => {
    expect(resolveIndustry(undefined, '600519')).toBe('白酒');
    expect(resolveIndustry('未知', '000001')).toBe('银行');
  });

  it('未知行业与未知代码返回 undefined', () => {
    expect(resolveIndustry('某虚构行业', '999999')).toBeUndefined();
    expect(resolveIndustry(undefined, '999999')).toBeUndefined();
  });

  it('CODE_TO_INDUSTRY 覆盖主要研究标的', () => {
    expect(CODE_TO_INDUSTRY['600519']).toBe('白酒');
    expect(CODE_TO_INDUSTRY['300750']).toBe('新能源车');
  });
});

describe('getPeerCodes', () => {
  it('返回同行业可比公司且排除自身', () => {
    const peers = getPeerCodes('白酒', '600519', 4);
    expect(peers).toContain('000858'); // 五粮液
    expect(peers).not.toContain('600519'); // 排除自身
  });

  it('不超过请求数量上限', () => {
    const peers = getPeerCodes('白酒', '600519', 4);
    expect(peers.length).toBeLessThanOrEqual(4);
  });

  it('未知行业返回空数组', () => {
    expect(getPeerCodes('不存在的行业', '600519')).toEqual([]);
  });

  it('银行行业返回真实银行代码', () => {
    const peers = getPeerCodes('银行', '600036', 6);
    expect(peers).toContain('601398'); // 工商银行
    expect(peers).not.toContain('600036');
  });
});

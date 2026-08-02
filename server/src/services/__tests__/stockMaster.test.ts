import { describe, it, expect } from 'vitest';
import { normalizeName, fuzzyMatch, type SecurityMasterEntry } from '../stockMaster.js';

describe('normalizeName', () => {
  it('去除上市窗口期前缀 C（次日起5交易日）', () => {
    expect(normalizeName('C长鑫')).toBe('长鑫');
  });
  it('去除上市首日前缀 N', () => {
    expect(normalizeName('N新股')).toBe('新股');
  });
  it('去除风险警示前缀 ST / *ST', () => {
    expect(normalizeName('ST康美')).toBe('康美');
    expect(normalizeName('*ST股')).toBe('股');
  });
  it('去除除权除息前缀 XD/XR/DR', () => {
    expect(normalizeName('XD工商')).toBe('工商');
    expect(normalizeName('DR银行')).toBe('银行');
  });
  it('仅保留中文字符，去除英文/数字/空格', () => {
    expect(normalizeName('A 股 Test 1')).toBe('股');
  });
  it('普通名称不变', () => {
    expect(normalizeName('贵州茅台')).toBe('贵州茅台');
  });
});

describe('fuzzyMatch', () => {
  const master: SecurityMasterEntry[] = [
    { code: '600519', name: '贵州茅台', industry: '白酒' },
    { code: '000858', name: '五粮液', industry: '白酒' },
    { code: '601318', name: '中国平安', industry: '保险' },
    { code: '300750', name: '宁德时代', industry: '新能源车' },
    { code: '688825', name: '长鑫科技', industry: '半导体' },
  ];

  it('6 位代码精确匹配优先', () => {
    const r = fuzzyMatch('600519', master);
    expect(r).toHaveLength(1);
    expect(r[0].code).toBe('600519');
  });

  it('子串包含匹配（如「茅台」命中「贵州茅台」）', () => {
    const r = fuzzyMatch('茅台', master);
    expect(r.some((e) => e.code === '600519')).toBe(true);
  });

  it('上市简称匹配（「长鑫科技」命中 688825）', () => {
    const r = fuzzyMatch('长鑫科技', master);
    expect(r.some((e) => e.code === '688825')).toBe(true);
  });

  it('空关键词返回空', () => {
    expect(fuzzyMatch('', master)).toHaveLength(0);
    expect(fuzzyMatch('   ', master)).toHaveLength(0);
  });

  it('无匹配返回空数组', () => {
    expect(fuzzyMatch('量子计算xyz', master)).toHaveLength(0);
  });

  it('单字符过泛词不会淹没结果（需公共子串>=2）', () => {
    const r = fuzzyMatch('银', master);
    // 「银」长度1，仅作为包含匹配，不应因单字公共子串乱配
    expect(r.every((e) => e.name.includes('银'))).toBe(true);
  });
});

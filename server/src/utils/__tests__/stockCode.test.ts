import { describe, it, expect } from 'vitest';
import {
  normalizeStockCode,
  normalizeStockCodeFor,
  normalizeAShareCode,
  MAX_STOCK_CODE_INPUT_LENGTH,
} from '../stockCode.js';

/**
 * 出站参数白名单回归测试
 * ----------------------------------------------------------------------------
 * 背景（审计 P1）：上游 URL 由 `${secid}` / `(SECUCODE="${code}")` 直接插值拼接，
 * `?code=1&lmt=99999` 可改写东财 K 线的 lmt 参数（放大单次拉取量），
 * `x") OR (SECUCODE="y` 可改写 RPT 过滤表达式。本文件锁定闸门本身的边界：
 * 合法形态必须放行（不能把功能修坏），任何可改写查询/表达式的字符必须拒绝。
 */

describe('normalizeStockCode —— 形态校验与市场推断', () => {
  it('A 股 6 位数字 → market=A', () => {
    expect(normalizeStockCode('600519')).toEqual({ code: '600519', market: 'A' });
    expect(normalizeStockCode('000001')).toEqual({ code: '000001', market: 'A' });
  });

  it('港股 5 位数字 → market=HK', () => {
    expect(normalizeStockCode('00700')).toEqual({ code: '00700', market: 'HK' });
  });

  it('美股字母代码 → market=US（统一大写）', () => {
    expect(normalizeStockCode('aapl')).toEqual({ code: 'AAPL', market: 'US' });
    expect(normalizeStockCode('TSLA')).toEqual({ code: 'TSLA', market: 'US' });
  });

  it('美股允许 . 与 -（BRK.B / BF-B 是真实代码，不能一刀切掉）', () => {
    expect(normalizeStockCode('brk.b')).toEqual({ code: 'BRK.B', market: 'US' });
    expect(normalizeStockCode('BF-B')).toEqual({ code: 'BF-B', market: 'US' });
  });

  it('首尾空白被 trim（历史行为：路由先 trim 再校验）', () => {
    expect(normalizeStockCode('  600519 ')).toEqual({ code: '600519', market: 'A' });
  });

  it('JSON body 里的数字代码保持兼容（{"stockCode": 600519}）', () => {
    expect(normalizeStockCode(600519)).toEqual({ code: '600519', market: 'A' });
  });

  it('空/非字符串/数组/对象/NaN → null（?code=a&code=b 会解析成数组，必须拒绝）', () => {
    for (const bad of [
      '',
      '   ',
      undefined,
      null,
      true,
      ['600519', '000001'],
      { code: '600519' },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      600519.5,
    ]) {
      expect(normalizeStockCode(bad), `应拒绝：${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it(`超过 ${MAX_STOCK_CODE_INPUT_LENGTH} 字符的入参直接拒绝（先按长度一刀切，不进正则）`, () => {
    expect(normalizeStockCode('6'.repeat(MAX_STOCK_CODE_INPUT_LENGTH))).toBeNull();
    expect(normalizeStockCode('6'.repeat(MAX_STOCK_CODE_INPUT_LENGTH + 1))).toBeNull();
    expect(normalizeStockCode('A'.repeat(1000))).toBeNull();
  });

  it('含可改写 URL 查询串的字符 → 一律拒绝', () => {
    // 审计给出的真实攻击形态：code=1&lmt=99999 会往上游多塞一个查询参数
    for (const bad of [
      '1&lmt=99999',
      '00700&lmt=99999',
      '600519?x=1',
      'code=AAPL&x=y',
      '600519/../etc',
      '%20600519',
      '600519#frag',
      '600 519',
      'AAPL,TSLA',
      "600519'",
      '`600519`',
      '600519;DROP',
    ]) {
      expect(normalizeStockCode(bad), `应拒绝：${bad}`).toBeNull();
    }
  });

  it('含引号/括号（可改写 RPT 过滤表达式）→ 一律拒绝', () => {
    expect(normalizeStockCode('x") OR (SECUCODE="y')).toBeNull();
    expect(normalizeStockCode('00700.HK") OR (SECUCODE="00700')).toBeNull();
    expect(normalizeStockCode('(SECUCODE="00700.HK")')).toBeNull();
  });
});

describe('normalizeStockCodeFor —— 显式市场校验', () => {
  it('market=HK 时放宽到 4-5 位（与 intlDataProvider.fetchIntlKlines 口径一致）', () => {
    expect(normalizeStockCodeFor('0700', 'HK')).toEqual({ code: '0700', market: 'HK' });
    expect(normalizeStockCodeFor('00700', 'HK')).toEqual({ code: '00700', market: 'HK' });
    expect(normalizeStockCodeFor('600519', 'HK')).toBeNull();
  });

  it('market=US 只认字母代码（含 . -），不接受数字', () => {
    expect(normalizeStockCodeFor('aapl', 'US')).toEqual({ code: 'AAPL', market: 'US' });
    expect(normalizeStockCodeFor('0700', 'US')).toBeNull();
  });

  it('market=A 只认 6 位数字（港股/美股形态被拒）', () => {
    expect(normalizeStockCodeFor('600519', 'A')).toEqual({ code: '600519', market: 'A' });
    expect(normalizeStockCodeFor('00700', 'A')).toBeNull();
    expect(normalizeStockCodeFor('AAPL', 'A')).toBeNull();
  });
});

describe('normalizeAShareCode —— A 股专用入口（自选股/分析/回测）', () => {
  it('只认 6 位数字，行为与旧 /^\\d{6}$/ 完全一致', () => {
    expect(normalizeAShareCode('600519')).toBe('600519');
    expect(normalizeAShareCode('00700')).toBeNull(); // 港股 5 位：自选股接口历史上不认
    expect(normalizeAShareCode('AAPL')).toBeNull();
    expect(normalizeAShareCode('abc')).toBeNull();
    expect(normalizeAShareCode('600519&x=1')).toBeNull();
    expect(normalizeAShareCode('60051')).toBeNull();
    expect(normalizeAShareCode('6005199')).toBeNull();
  });

  it('港美股入口（/api/intl/*）的形态判定复用同一组规则', () => {
    // 不传 market 时按形态推断：5 位→HK、字母→US；6 位数字是 A 股（由路由回分流提示）
    expect(normalizeStockCode('00700')).toEqual({ code: '00700', market: 'HK' });
    expect(normalizeStockCode('aapl')).toEqual({ code: 'AAPL', market: 'US' });
    expect(normalizeStockCode('600519')?.market).toBe('A');
    // 显式 market 时按该市场校验（4 位港股放行，误配市场被拒）
    expect(normalizeStockCodeFor('0700', 'HK')).toEqual({ code: '0700', market: 'HK' });
    expect(normalizeStockCodeFor('0700', 'US')).toBeNull();
    expect(normalizeStockCodeFor('600519', 'HK')).toBeNull();
    // 注入形态一律拒绝
    expect(normalizeStockCodeFor('1&lmt=99999', 'HK')).toBeNull();
    expect(normalizeStockCodeFor('00700") OR (SECUCODE="x', 'HK')).toBeNull();
  });
});

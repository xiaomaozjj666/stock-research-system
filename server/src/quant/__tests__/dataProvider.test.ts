import { describe, it, expect } from 'vitest';
import { marketOf, resolveSecid } from '../dataProvider.js';

describe('market resolution', () => {
  it('A-share keeps historical secid', () => {
    expect(marketOf('600519')).toBe('A');
    expect(resolveSecid('600519')).toBe('1.600519');
    expect(resolveSecid('000001')).toBe('0.000001');
    expect(resolveSecid('300750')).toBe('0.300750');
  });

  it('HK 5-digit codes map to 116.', () => {
    expect(marketOf('00700')).toBe('HK');
    expect(resolveSecid('00700')).toBe('116.00700');
  });

  it('US tickers map to 107. (uppercased)', () => {
    expect(marketOf('AAPL')).toBe('US');
    expect(resolveSecid('aapl')).toBe('107.AAPL');
  });
});

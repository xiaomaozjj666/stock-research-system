/**
 * 港美股财务估值（东财 datacenter RPT 网关，替代 push2）。
 */
import { Router } from 'express';
import { metaLimiter } from '../middleware.js';
import {
  fetchIntlFundamentals,
  fetchIntlKlines,
  type IntlMarket,
} from '../quant/intlDataProvider.js';
import { normalizeStockCode, normalizeStockCodeFor, type StockMarket } from '../utils/stockCode.js';
import logger from '../utils/logger.js';

const router = Router();

/** 显式 market 的白名单：只认这三个值，其它一律 400（不接受任意串被当成市场标识透给上游） */
const ALLOWED_MARKETS: readonly StockMarket[] = ['A', 'HK', 'US'];

type IntlQueryCheck =
  { ok: true; code: string; market: CheckedIntlMarket } | { ok: false; error: string };

/**
 * 校验结果里的市场：比 IntlMarket 多一个 'A'。
 * 6 位数字是合法形态（不能报"格式无效"），只是不该走本接口——调用方据此回分流提示。
 */
type CheckedIntlMarket = IntlMarket | 'A';

/** 形态非法时的统一提示（说清各市场可接受的样子，便于调用方改对参数） */
const CODE_FORMAT_ERROR =
  'code 格式无效：港股应为 4-5 位数字（需 market=HK），美股应为 1-8 位字母代码（如 AAPL / BRK.B）；不得包含 & ? = 空格等字符';

/**
 * 校验 /api/intl/* 的入参（code / market）。
 *
 * 为什么必须在这里拦：intlDataProvider 把 code 直接拼进上游 URL / 过滤表达式
 * （K 线走 `secid=116.${code}`，财务估值走 `(SECUCODE="${code}.HK")`）。
 * 审计已确认 `?code=1&lmt=99999&market=HK` 这类输入能改写上游查询参数、放大单次拉取量。
 * 这里用统一闸门只放行「A 股 6 位数字 / 港股 4-5 位数字 / 美股字母代码（可含 . -）」，
 * 其余（含 `& ? = 空格 " ( ) / %`）在拼接进 URL 之前就拒掉。
 *
 * 注意 A 股形态会被放行到这里返回 market='A'：本接口不管 A 股，但调用方要回
 * 「A 股请走 /api/analyze」这类**分流提示**，而不是把它报成"格式无效"（用户会不知道该走哪）。
 */
function checkIntlQuery(query: Record<string, unknown>): IntlQueryCheck {
  const rawCode = query.code;
  if (rawCode === undefined || rawCode === null || String(rawCode).trim() === '') {
    return { ok: false, error: '请提供代码 code' };
  }
  const rawMarket = query.market === undefined ? null : String(query.market).toUpperCase();
  if (rawMarket !== null && !ALLOWED_MARKETS.includes(rawMarket as StockMarket)) {
    return { ok: false, error: `market 取值无效（仅支持 ${ALLOWED_MARKETS.join(' / ')}）` };
  }
  // 未显式给 market：按形态推断（与 intlDataProvider.detectMarket 同口径：6 位→A、5 位→HK、字母→US）
  const normalized =
    rawMarket === null
      ? normalizeStockCode(rawCode)
      : normalizeStockCodeFor(rawCode, rawMarket as StockMarket);
  if (!normalized) return { ok: false, error: CODE_FORMAT_ERROR };
  return { ok: true, code: normalized.code, market: normalized.market };
}

router.get('/api/intl/fundamentals', metaLimiter, async (req, res) => {
  try {
    const checked = checkIntlQuery(req.query as Record<string, unknown>);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    if (checked.market === 'A') {
      return res
        .status(400)
        .json({ error: 'A 股代码请走 /api/analyze 分析接口，本接口仅港美股财务估值' });
    }
    const result = await fetchIntlFundamentals(checked.code, checked.market);
    res.json(result);
  } catch (error) {
    logger.error('Intl fundamentals error', { route: '/api/intl/fundamentals', err: error });
    res.status(500).json({ error: '港美股数据获取失败', detail: (error as Error).message });
  }
});

/** 港美股日 K 线：与 A 股同一东财 K 线通道（secid 映射 116.x / 107.x），含缓存合并与防前视 */
router.get('/api/intl/klines', metaLimiter, async (req, res) => {
  try {
    const checked = checkIntlQuery(req.query as Record<string, unknown>);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    if (checked.market === 'A') {
      return res.status(400).json({ error: 'A 股代码请走量化/行情既有接口，本接口仅港美股 K 线' });
    }
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const end = new Date();
    const endStr = dateRe.test(String(req.query.endDate ?? ''))
      ? String(req.query.endDate)
      : end.toISOString().slice(0, 10);
    const defaultStart = new Date(end);
    defaultStart.setFullYear(defaultStart.getFullYear() - 2);
    const startStr = dateRe.test(String(req.query.startDate ?? ''))
      ? String(req.query.startDate)
      : defaultStart.toISOString().slice(0, 10);
    const bars = await fetchIntlKlines(checked.code, checked.market, startStr, endStr);
    res.json({
      code: checked.code,
      market: checked.market,
      startDate: startStr,
      endDate: endStr,
      count: bars.length,
      klines: bars,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/(需|不足|至少|无效)/.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    logger.error('Intl klines error', { route: '/api/intl/klines', err: error });
    res.status(500).json({ error: '港美股 K 线获取失败', detail: msg });
  }
});

export default router;

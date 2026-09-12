/**
 * 港美股财务估值（东财 datacenter RPT 网关，替代 push2）。
 */
import { Router } from 'express';
import {
  fetchIntlFundamentals,
  fetchIntlKlines,
  detectMarket,
  type IntlMarket,
} from '../quant/intlDataProvider.js';
import logger from '../utils/logger.js';

const router = Router();

router.get('/api/intl/fundamentals', async (req, res) => {
  try {
    const code = String(req.query.code ?? '').trim();
    if (!code) return res.status(400).json({ error: '请提供代码 code' });
    const rawMarket = req.query.market
      ? String(req.query.market).toUpperCase()
      : detectMarket(code);
    if (rawMarket === 'A') {
      return res
        .status(400)
        .json({ error: 'A 股代码请走 /api/analyze 分析接口，本接口仅港美股财务估值' });
    }
    const market = rawMarket as IntlMarket;
    const result = await fetchIntlFundamentals(code, market);
    res.json(result);
  } catch (error) {
    logger.error('Intl fundamentals error', { route: '/api/intl/fundamentals', err: error });
    res.status(500).json({ error: '港美股数据获取失败', detail: (error as Error).message });
  }
});

/** 港美股日 K 线：与 A 股同一东财 K 线通道（secid 映射 116.x / 107.x），含缓存合并与防前视 */
router.get('/api/intl/klines', async (req, res) => {
  try {
    const code = String(req.query.code ?? '').trim();
    if (!code) return res.status(400).json({ error: '请提供代码 code' });
    const rawMarket = req.query.market
      ? String(req.query.market).toUpperCase()
      : detectMarket(code);
    if (rawMarket === 'A') {
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
    const bars = await fetchIntlKlines(code, rawMarket as IntlMarket, startStr, endStr);
    res.json({
      code,
      market: rawMarket,
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

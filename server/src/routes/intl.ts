/**
 * 港美股财务估值（东财 datacenter RPT 网关，替代 push2）。
 */
import { Router } from 'express';
import { fetchIntlFundamentals, detectMarket, type IntlMarket } from '../quant/intlDataProvider.js';
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

export default router;

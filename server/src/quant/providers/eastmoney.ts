/**
 * 东方财富数据源 provider（默认）
 * ----------------------------------------------------------------------------
 * 从 quant/dataProvider.ts 原样迁出**上游适配**部分：secid 拼接、URL 构造、klines
 * 文本解析与行级脏数据防御。缓存 / 增量补尾 / look-ahead 出口过滤 / 模拟降级仍留在
 * dataProvider 统一处理，因此本文件的对外行为必须与迁移前逐字一致——URL、错误文案、
 * 日志文案、超时与中止语义都不许漂移。
 */
import logger from '../../utils/logger.js';
import type { OHLCVData } from '../types.js';
import { marketOf } from './markets.js';
import { filterOHLCVByRange } from './ohlcvRange.js';
import type { DataProvider, KlineRequest } from './types.js';

/** 东财 K 线接口默认超时：历史调用方均显式传 10000/15000，缺省值只做兜底 */
const DEFAULT_KLINE_TIMEOUT_MS = 15000;

function getSecId(code: string): string {
  return code.startsWith('6') ? `1.${code}` : `0.${code}`;
}

/**
 * 允许进入 secid 的字符白名单（数字/字母/点/连字符，长度上限 12）。
 * 这是**出站 URL 拼接前的最后一道闸**：secid 会被直接插进上游查询串（`secid=${secid}`），
 * 而 `resolveSecid` 对非港美股形态一律按 A 股拼 `0.${code}`，于是 `1&lmt=99999`
 * 这种入参能改写上游参数（改 lmt/fs 等）。
 * 刻意不在此处做严格的「6 位数字」校验：`marketOf` 与既有测试允许 4~7 位等历史形态
 * （见 dataProvider.extra.test.ts 的 `0.1234567` 用例），严格形态校验已由路由层
 * `utils/stockCode.ts` 的 normalizeStockCode 承担；这里只堵可改写 URL 的元字符。
 */
const SAFE_CODE_RE = /^[A-Za-z0-9.-]{1,12}$/;

/**
 * 把代码解析为东方财富 secid（含港股/美股）。
 * A 股：6 开头→1.（上交所），其余→0.（深交所）——与历史 getSecId 完全一致。
 * 港股：5 位→116.（港股通/港股市场）。
 * 美股：字母→107.（美股市场，大写）。
 * @throws 代码含可改写 URL 的字符时抛出，调用方据此快速失败而不是发出畸形上游请求
 */
export function resolveSecid(code: string): string {
  const c = code.trim();
  if (!SAFE_CODE_RE.test(c)) {
    throw new Error(`非法股票代码（含不允许的字符）：${c.slice(0, 32)}`);
  }
  const m = marketOf(c);
  if (m === 'HK') return `116.${c}`;
  if (m === 'US') return `107.${c.toUpperCase()}`;
  return getSecId(c);
}

/**
 * 拉取指定区间的日 K 线（东方财富）。返回 null 表示失败（网络/解析），由调用方降级；
 * 这样「拉取失败」与「区间内确实无数据」可区分，不会把空区间误判为需模拟降级。
 */
export async function fetchEastmoneyKline(request: KlineRequest): Promise<OHLCVData[] | null> {
  const { secid, startDate, endDate, signal } = request;
  const timeoutMs = request.timeoutMs ?? DEFAULT_KLINE_TIMEOUT_MS;
  const beg = startDate.replace(/-/g, '');
  const end = endDate.replace(/-/g, '');

  // lmt 按请求跨度估算：固定 1000 会在约 4 年以上的区间静默截断
  // （API 只返回前 1000 根且无告警，回测区间悄悄缩水）；日历天数 ≥ 交易日数，
  // 再加 10 天余量即可保证不截断，封顶防滥用
  const spanDays =
    Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1;
  const lmt = Math.min(Math.max(Number.isFinite(spanDays) ? spanDays + 10 : 1000, 1000), 100000);

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=${beg}&end=${end}&lmt=${lmt}`;

  try {
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
        : AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json();

    if (json?.data?.klines) {
      // H3 第一层防御（解析层行过滤）：open/close/high/low/volume 任一非有限
      // （NaN/Infinity）或 close ≤ 0 的行直接丢弃——close=0 会把动量算成 Infinity
      // 假信号、close=NaN 会污染整条权益曲线；宁可少一根 bar 也不让畸形值静默进回测
      // （引擎入口 runBacktest 还有第二层 throw 兜底）。
      const data: OHLCVData[] = [];
      let dropped = 0;
      for (const line of json.data.klines as string[]) {
        const parts = line.split(',');
        const row: OHLCVData = {
          date: parts[0],
          open: parseFloat(parts[1]),
          close: parseFloat(parts[2]),
          high: parseFloat(parts[3]),
          low: parseFloat(parts[4]),
          volume: parseFloat(parts[5]),
        };
        const sane =
          Number.isFinite(row.open) &&
          Number.isFinite(row.close) &&
          Number.isFinite(row.high) &&
          Number.isFinite(row.low) &&
          Number.isFinite(row.volume) &&
          row.close > 0;
        if (sane) data.push(row);
        else dropped++;
      }
      if (dropped > 0) {
        logger.warn('K线存在畸形行（非有限价格/量或 close≤0），已丢弃', {
          secid,
          startDate,
          endDate,
          dropped,
        });
      }

      // look-ahead 防御：剔除超出请求范围的行（API 边界行为不可控，本地二次校验兜底）
      const { data: filtered, trimmed } = filterOHLCVByRange(data, startDate, endDate);
      if (trimmed > 0) {
        logger.warn('K线返回越界行，已剔除（look-ahead 防御）', {
          secid,
          startDate,
          endDate,
          trimmed,
        });
      }
      return filtered;
    }
  } catch (error) {
    // 外部中止 ≠ 拉取失败：重抛给调用方，避免走到「降级模拟数据 / 写部分缓存」
    if (signal?.aborted) throw signal.reason ?? error;
    logger.warn('获取K线数据失败', { secid, startDate, endDate, err: error });
  }
  return null;
}

/** 东方财富 provider：默认数据源，覆盖 A / HK / US 三市场 K 线（可选能力暂未实现） */
export const eastmoneyProvider: DataProvider = {
  id: 'eastmoney',
  capabilities: { kline: true, quote: false, financial: false, markets: ['A', 'HK', 'US'] },
  resolveSecid,
  fetchKline: fetchEastmoneyKline,
};

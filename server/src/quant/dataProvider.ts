import logger from '../utils/logger.js';
import { filterOHLCVByRange } from './providers/ohlcvRange.js';
import { getProvider } from './providers/registry.js';
import type { Market } from './providers/types.js';
import { isCacheFresh, readCacheEntry, writeCacheEntry } from './quantCache.js';
import type { OHLCVData } from './types.js';

/** 市场判定与 provider 共享同一份实现（导出面保持不变） */
export { marketOf } from './providers/markets.js';
/** look-ahead 过滤与 provider 解析层共用同一份实现（导出面保持不变） */
export { filterOHLCVByRange };
/** 市场标识（与 provider 契约同源，导出面保持不变） */
export type { Market };

/** 缓存条目的日期形态：非此形态视为脏数据（时间戳/畸形字符串混入会让区间比较失真） */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 把代码解析为上游证券标识（默认东财 secid）。
 *
 * 代码 → secid 的拼接已下沉到当前启用的 provider：这样路由层校验、取数层拼 URL 与
 * 换源配置共用同一份口径，不会出现「路由按 A 股放行、取数按新源拼」的两套定义。
 * 默认 provider（eastmoney）的字符白名单与抛错文案与改造前逐字一致。
 * @throws provider 判定代码非法时抛出（eastmoney：含可改写 URL 的字符）
 */
export function resolveSecid(code: string): string {
  return getProvider().resolveSecid(code);
}

/** K 线缓存条目：按 token 存合并后的完整历史，而非按请求区间分片 */
interface KlineCachePayload {
  bars: OHLCVData[];
  /**
   * 写入该缓存的 provider id。缓存键仍是 `kline_<token>`（不变），此字段用于避免
   * 换源后复用旧源的历史；旧缓存没有该字段，按「来源未知」兼容读取。
   */
  provider?: string;
}

/**
 * K 线缓存的有效期（供 prune 判断是否保留文件）。
 * 历史 K 线一旦落定不再变化，故有效期远长于「新鲜度」窗口；真正的更新靠下面的
 * 尾部补拉，而不是靠过期丢弃整段历史（那会导致每次全量重拉，正是要修的问题）。
 */
function klineCacheTtlMs(): number {
  const raw = Number(process.env.QUANT_KLINE_CACHE_TTL_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? raw : 30;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * 「完全覆盖且新鲜」的判定窗口：同一区间在该窗口内重复请求零网络调用。
 * 次日滚动窗口（end 前移）会越过此窗口，但只补拉尾部新增的几根。
 */
function klineFreshTtlMs(): number {
  const raw = Number(process.env.QUANT_KLINE_FRESH_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 12;
  return hours * 60 * 60 * 1000;
}

/** 合并两段 K 线：按日期去重（新值覆盖旧值以容纳当日修订），按日期升序返回 */
function mergeBars(existing: OHLCVData[], incoming: OHLCVData[]): OHLCVData[] {
  const byDate = new Map<string, OHLCVData>();
  for (const bar of existing) if (bar?.date) byDate.set(bar.date, bar);
  for (const bar of incoming) if (bar?.date) byDate.set(bar.date, bar);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * H2：前复权基准漂移阈值（重叠段收盘价最大相对偏差）。
 * fqt=1 前复权下，除权会使上游按新基准重算**整个历史序列**——正常增量补尾不会改变
 * 重叠段价格；偏差超过该阈值即「两个复权基准混用」的信号（合并会在除权日出现假跳空）。
 * 取 1%：足以容纳当日盘中小幅修订，又远低于任何真实除权的量级。
 */
const ADJUSTMENT_DRIFT_THRESHOLD = 0.01;

/**
 * H2：比较缓存与新增数据在重叠日期上的收盘价，返回最大相对偏差（|new-old|/old）。
 * 无重叠日期或无可比基准价时返回 null（无法判定，不触发重拉）。
 */
function maxOverlapCloseDrift(existing: OHLCVData[], incoming: OHLCVData[]): number | null {
  const oldClose = new Map<string, number>();
  for (const b of existing) if (b.close > 0) oldClose.set(b.date, b.close);
  let max: number | null = null;
  for (const b of incoming) {
    const old = oldClose.get(b.date);
    if (old === undefined || !(old > 0) || !(b.close > 0)) continue;
    const drift = Math.abs(b.close - old) / old;
    if (max === null || drift > max) max = drift;
  }
  return max;
}

/**
 * 按 secid 获取 K 线（fetchOHLCVData 与指数基准共用内核）。
 *
 * 缓存策略（2026-09-05 重构）：按 cacheToken 存**合并后的完整历史**，请求时本地切片，
 * 只补拉未覆盖的缺口。此前按 `{token}_{start}_{end}` 分片缓存，而截面/回测用的是
 * 滚动窗口（end = 今天），导致每天为每只股票生成全新缓存文件并重拉全量历史——
 * 几百只全市场时这是主要瓶颈。现在：首次冷拉全量，之后每天只补拉尾部几根。
 *
 * 另含 look-ahead 防御与模拟数据降级；模拟数据绝不写入缓存（避免污染真实历史）。
 */
export async function fetchKlineBySecid(
  secid: string,
  startDate: string,
  endDate: string,
  cacheToken: string,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<OHLCVData[]> {
  const cacheKey = `kline_${cacheToken}`;
  if (signal?.aborted) throw signal.reason ?? new Error('K线拉取已中止');

  // 0. 本次请求固定用同一个 provider：避免「读 A 源历史、用 B 源补尾」的混用。
  const provider = getProvider();

  // 1. 读缓存：合并历史。不判断新鲜度——即使不新鲜也要读出来做增量补尾。
  const cached = readCacheEntry<KlineCachePayload>(cacheKey);
  // provider 归属校验：缓存键保持 `kline_<token>` 不变，旧缓存没有 provider 字段，
  // 按「来源未知」兼容读取；有且与当前源不同则视为未命中（换源后不能继续返回旧源历史）。
  const cachedProviderId = cached?.data?.provider;
  const providerMismatch = typeof cachedProviderId === 'string' && cachedProviderId !== provider.id;
  if (providerMismatch) {
    logger.warn('K线缓存属于其他数据源 provider，已忽略并全量重拉', {
      secid,
      cachedProvider: cachedProviderId,
      provider: provider.id,
    });
  }
  const rawCachedBars =
    !providerMismatch && cached?.data && Array.isArray(cached.data.bars)
      ? cached.data.bars.filter((b) => b && typeof b.date === 'string')
      : [];
  // 真正的脏数据是**非法日期行**（畸形/时间戳混入会让排序与区间比较失真）；
  // 这类才告警并剔除。「请求窗口比缓存窄」导致的裁剪是正常行为（缓存保留并集历史），
  // 不再逐次 warn——否则每次窄窗口请求都刷一条，掩盖真异常。
  const cachedBars = rawCachedBars.filter((b) => ISO_DATE_RE.test(b.date));
  const invalidCached = rawCachedBars.length - cachedBars.length;
  if (invalidCached > 0) {
    logger.warn('缓存K线含非法日期行，已剔除', { secid, invalid: invalidCached });
  }
  const cStart = cachedBars.length > 0 ? cachedBars[0].date : null;
  const cEnd = cachedBars.length > 0 ? cachedBars[cachedBars.length - 1].date : null;

  // 完全覆盖且新鲜 → 零网络调用返回
  const covered = cStart !== null && cEnd !== null && startDate >= cStart && endDate <= cEnd;
  if (covered && cached && isCacheFresh(cached.timestamp, klineFreshTtlMs())) {
    // 仍做范围过滤（请求窗口比缓存窄时属正常提取，静默处理）
    const { data, trimmed } = filterOHLCVByRange(cachedBars, startDate, endDate);
    if (trimmed > 0) {
      logger.debug('缓存K线按请求窗口裁剪', { secid, startDate, endDate, trimmed });
    }
    return data;
  }

  // 2. 只补拉未覆盖的部分：
  //    - 无缓存，或请求左边界在缓存之前 → 从 startDate 拉（冷启动 / 窗口拓宽）；
  //    - 否则 → 从 cEnd 拉（尾部增量，即正常的每日更新路径）。
  const fetchStart = cEnd !== null && cStart !== null && startDate >= cStart ? cEnd : startDate;
  let merged = cachedBars;
  if (fetchStart <= endDate) {
    const fetched = await provider.fetchKline({
      secid,
      startDate: fetchStart,
      endDate,
      timeoutMs,
      signal,
    });
    if (fetched !== null && fetched.length > 0) {
      merged = mergeBars(cachedBars, fetched);
      // H2：前复权基准一致性校验——除权后上游按新基准重算整个历史，旧缓存是旧基准、
      // 新尾部是新基准，直接合并会在除权日出现假跳空（两基准混用）。
      // 重叠段收盘价最大偏差超阈值 → 判定基准变更，放弃缓存全量重拉（fetchStart 移到
      // 缓存最早日期），保证整段历史同一复权基准。
      const drift = maxOverlapCloseDrift(cachedBars, fetched);
      if (drift !== null && drift > ADJUSTMENT_DRIFT_THRESHOLD) {
        const fullStart = cStart ?? startDate;
        const refetched = await provider.fetchKline({
          secid,
          startDate: fullStart,
          endDate,
          timeoutMs,
          signal,
        });
        if (refetched !== null) {
          // 全量重拉成功：整段以新基准为准（不再与旧缓存合并，防旧基准残留），回写缓存
          merged = mergeBars([], refetched);
          writeCacheEntry(cacheKey, { bars: merged, provider: provider.id }, klineCacheTtlMs());
        } else {
          // 全量重拉失败（网络错误）：返回已有的合并数据（可能混用两个复权基准）。
          // 决策：不改 OHLCVData[] 返回结构——它被 fetchOHLCVData / 指数基准 / intl
          // 通道与 services 层共用，加 staleAdjustment 字段侵入面大；logger.warning
          // 是最小侵入方案，以 staleAdjustment 关键词标注便于告警检索。
          // 同时不回写缓存：避免把混合基准固化，下次请求仍会重试全量重拉。
          logger.warn(
            '复权基准变更但全量重拉失败，返回数据可能混用两个前复权基准（staleAdjustment）',
            { secid, fullStart, endDate, drift: Math.round(drift * 1000) / 1000 },
          );
        }
      } else {
        writeCacheEntry(cacheKey, { bars: merged, provider: provider.id }, klineCacheTtlMs());
      }
    } else if (fetched === null && cachedBars.length === 0) {
      // 3. 真失败（网络/解析）且无历史 → 降级模拟数据（用于演示），绝不写入缓存
      // F1.6: 模拟数据标记 isSimulated=true，下游策略引擎应检查此标志
      const simulated = generateSimulatedData(cacheToken, startDate, endDate);
      return simulated.map((d) => ({ ...d, isSimulated: true }));
    } else if (fetched === null) {
      // 拉取失败但已有历史：返回已缓存的部分区间（真实数据优于模拟噪声）
      logger.warn('K线尾部补拉失败，返回已缓存的部分区间', {
        secid,
        fetchStart,
        endDate,
        cachedBars: cachedBars.length,
      });
    }
    // fetched === []（API 可达但区间内确实无数据）→ 合法空结果：
    // 不写缓存（避免瞬时异常被长 TTL 负缓存）、不降级，交由上层按「无数据」处理
  }

  // look-ahead 防御：剔除超出请求范围的行
  const { data, trimmed } = filterOHLCVByRange(merged, startDate, endDate);
  if (trimmed > 0) {
    logger.warn('K线返回越界行，已剔除（look-ahead 防御）', { secid, startDate, endDate, trimmed });
  }
  return data;
}

/**
 * 获取 K 线数据（含 look-ahead 防御：返回前按 [startDate, endDate] 二次过滤）。
 */
export async function fetchOHLCVData(
  stockCode: string,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<OHLCVData[]> {
  return fetchKlineBySecid(resolveSecid(stockCode), startDate, endDate, stockCode, 15000, signal);
}

/**
 * A 股宽基基准（默认沪深300，东方财富 secid `1.000300`）。
 * 量价因子的 Beta / 特异波动率 / 残差动量需要「市场收益」才能计算；个股自身买入持有
 * 曲线（getBenchmarkCurve）不是市场代理（用它算 Beta 会恒为 1），必须拉真实宽基指数。
 */
export const A_SHARE_BENCHMARK_SECID = '1.000300';

/**
 * 各市场宽基基准（东方财富 secid），供量价因子作市场收益。
 * - A 股：沪深300（`1.000300`）
 * - 美股：标普500（`100.SPX`，东方财富全球指数前缀 `100.` + 代码 SPX）
 * - 港股：恒生指数（`100.HSI`）
 * Beta / 特异波动率 / 残差动量需要「市场收益」才能计算；个股自身买入持有曲线
 * （getBenchmarkCurve）不是市场代理（用它算 Beta 会恒为 1），必须拉真实宽基指数。
 */
export const BENCHMARK_SECID_BY_MARKET: Record<Market, string> = {
  A: A_SHARE_BENCHMARK_SECID,
  US: '100.SPX',
  HK: '100.HSI',
};

/**
 * 宽基基准 secid 的环境变量覆盖键。用于按部署切换基准（如美股改纳指100 `100.NDX`、
 * A 股改中证500 `1.000905`），无需改代码。
 */
const BENCHMARK_SECID_ENV_KEY: Record<Market, string> = {
  A: 'QUANT_BENCHMARK_SECID_A',
  US: 'QUANT_BENCHMARK_SECID_US',
  HK: 'QUANT_BENCHMARK_SECID_HK',
};

/**
 * 按市场取宽基基准 secid。
 * 环境变量覆盖优先（`QUANT_BENCHMARK_SECID_A/US/HK`），每次调用时读取——便于
 * 配置热改动与测试 stub，避免模块加载期固化。覆盖值为空或纯空白时回落内置默认
 * （沪深300 / 标普500 / 恒生）；未知市场回退沪深300。
 */
export function benchmarkSecidForMarket(market: Market): string {
  const fallback = BENCHMARK_SECID_BY_MARKET[market] ?? A_SHARE_BENCHMARK_SECID;
  const envKey = BENCHMARK_SECID_ENV_KEY[market];
  if (!envKey) return fallback;
  const override = (process.env[envKey] ?? '').trim();
  return override || fallback;
}

/**
 * 拉取宽基指数日收益，按股票 bars 的日期对齐，供量价因子作市场基准。
 *
 * @param barDates 股票 K 线日期序列（升序），marketReturns 将与之等长对齐
 * @param startDate/endDate 与股票相同的区间（缓存/请求用）
 * @param indexSecid 指数 secid；默认 A 股沪深300。调用方通常用 `benchmarkSecidForMarket(marketOf(code))` 按市场选基准
 * @returns 与 barDates 等长的日收益数组（缺失处为 NaN）；对齐率 < 50% 或拉取失败返回 null（降级）
 */
export async function fetchBenchmarkReturns(
  barDates: string[],
  startDate: string,
  endDate: string,
  indexSecid: string = A_SHARE_BENCHMARK_SECID,
): Promise<number[] | null> {
  if (barDates.length < 2) return null;
  try {
    const idx = await fetchKlineBySecid(indexSecid, startDate, endDate, `idx_${indexSecid}`, 10000);
    if (!idx || idx.length < 2) return null;
    // 指数拉取失败会降级为模拟数据（F1.6）；模拟指数与真实股票收益无关，
    // 用于回归会污染 Beta，故视为「无市场收益」返回 null
    if (idx.some((b) => b.isSimulated)) return null;
    // 指数每日收益（realized on date i）：close[i]/close[i-1] − 1
    const idxRet = new Map<string, number>();
    for (let i = 1; i < idx.length; i++) {
      const base = idx[i - 1].close;
      const ahead = idx[i].close;
      idxRet.set(idx[i].date, base > 0 && ahead > 0 ? ahead / base - 1 : NaN);
    }
    // 按股票 bars 日期对齐（指数与 A 股同交易历；缺失处 NaN，不向前填充以免错位）
    const out = barDates.map((d) => idxRet.get(d) ?? NaN);
    const finite = out.filter((v) => Number.isFinite(v)).length;
    // 对齐率过低说明指数与股票交易历严重错配（如跨市场），放弃以免污染 Beta
    if (finite < Math.ceil(barDates.length * 0.5)) return null;
    return out;
  } catch {
    return null;
  }
}

/** 缓存文件名 token 清洗：只保留字母/数字/下划线/连字符，防 `../` 等路径穿越 */
/**
 * 合成 K 线的硬迭代上限（按自然日计，含周末）。
 *
 * 为什么要硬上限：本函数是**同步 while + 逐根 push**，循环期间 Node 单线程事件循环
 * 被完全占满（连健康检查都排不上）。而循环次数完全由 startDate/endDate 决定，
 * 入参最终来自 HTTP body——`{"startDate":"1900-01-01","endDate":"2100-01-01"}` 就是
 * 七万三千次迭代的同步阻塞。20000 个自然日 ≈ 76 年，覆盖任意真实研究窗口（默认回看
 * 2 年），同时把同步阻塞时间钉在毫秒量级。
 */
const MAX_SIMULATED_DAYS = 20000;

/**
 * 生成模拟K线数据（当API不可用时降级使用）
 *
 * 注意：入参日期由调用方（screener 入口等）负责校验为 `YYYY-MM-DD`；此处再做两层
 * 防御——非法日期立即返回空数组（不进入循环），循环本身另有 MAX_SIMULATED_DAYS 硬上限。
 */
function generateSimulatedData(stockCode: string, startDate: string, endDate: string): OHLCVData[] {
  const data: OHLCVData[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  // 非法日期/倒置区间不进入循环：Invalid Date 的 `current.setDate()` 仍是 Invalid，
  // 会一路推进到 MAX_SIMULATED_DAYS 才收手（白烧 2 万次迭代），直接短路成空数组
  // （调用方按「无 K 线」处理，与倒置区间原本「一根都不产出」的语义一致）。
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (start.getTime() > end.getTime()) return [];

  // 基于股票代码生成确定性的"随机"价格：
  // 字母代码（如 AAPL）parseInt 得 NaN 会让整条模拟曲线全是 NaN，先做确定性哈希
  function codeSeed(s: string): number {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 3) return parseInt(digits.slice(-3), 10);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 1000;
  }
  let price = 50 + (codeSeed(stockCode) % 100);
  const seed = codeSeed(stockCode.slice(-3));

  const current = new Date(start);
  // visited：迭代次数硬上限（见 MAX_SIMULATED_DAYS）。用独立计数器而不是判断
  // data.length（周末不 push，data.length 涨得比迭代慢，上限会被周末稀释）；
  // 循环体内 setDate 一定推进日期，故 visited 保证终止。
  let visited = 0;
  while (current <= end) {
    if (visited++ >= MAX_SIMULATED_DAYS) break;
    // 跳过周末：日期标签用 toISOString（UTC），星期判断也必须用 UTC 口径，
    // 否则 UTC 负偏移服务器上周末跳过与日期标签错位
    if (current.getUTCDay() !== 0 && current.getUTCDay() !== 6) {
      // 种子也必须用 UTC 口径：与上面的星期判断、下面的日期标签（toISOString）保持同一时区。
      // 此前这里用本地 getDate()/getMonth()，在 UTC 负偏移宿主（美区 runner/自建机）上
      // 会取到与 UTC 不同的日/月，模拟序列随宿主时区变化，确定性被破坏。
      const daySeed = (seed * current.getUTCDate() * (current.getUTCMonth() + 1)) % 100;
      const change = (daySeed - 50) / 500; // ±10% 波动
      price = price * (1 + change);
      price = Math.max(price, 5);

      const open = price * (1 + ((daySeed % 5) - 2) / 200);
      const high = Math.max(open, price) * (1 + (daySeed % 3) / 100);
      const low = Math.min(open, price) * (1 - (daySeed % 3) / 100);
      const volume = 1000000 + daySeed * 50000;

      data.push({
        date: current.toISOString().split('T')[0],
        open: Math.round(open * 100) / 100,
        high: Math.round(high * 100) / 100,
        low: Math.round(low * 100) / 100,
        close: Math.round(price * 100) / 100,
        volume: Math.round(volume),
      });
    }
    current.setDate(current.getDate() + 1);
  }

  return data;
}

/**
 * 获取基准数据（买入持有）
 */
export function getBenchmarkCurve(data: OHLCVData[]): { date: string; value: number }[] {
  if (data.length === 0) return [];
  const basePrice = data[0].close;
  return data.map((d) => ({
    date: d.date,
    value: Math.round((d.close / basePrice) * 10000) / 100, // 归一化为百分比
  }));
}

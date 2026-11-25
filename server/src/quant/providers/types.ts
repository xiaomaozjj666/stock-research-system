/**
 * 数据源 provider 契约（quant/providers）
 * ----------------------------------------------------------------------------
 * 存在理由：`quant/dataProvider.ts` 曾把「东财 secid 拼接 / A 股判定 / 上游 URL 构造 /
 * 缓存」混在一个模块里，接第二个数据源必须改核心取数代码。本模块只定义**上游适配层**
 * 的契约：provider 负责「代码 → 上游标识」与「一次区间拉取」，缓存、增量补尾、
 * look-ahead 过滤与模拟降级仍由 dataProvider 统一负责（各源共享同一套缓存语义）。
 *
 * 约束：
 * - `resolveSecid` 的实现必须自带入参白名单（返回值会被直接拼进上游 URL）；
 * - `fetchKline` 返回 `null` 表示网络/解析失败（上层据此降级），空数组表示
 *   「区间内确实无数据」，两者语义不可混用（沿用现有东财通道的口径）。
 */
import type { OHLCVData } from '../types.js';

/** 市场标识（与 utils/stockCode 的 StockMarket 同值域） */
export type Market = 'A' | 'HK' | 'US';

/** provider 调用的通用选项 */
export interface ProviderCallOptions {
  /** 单次请求超时（毫秒）；缺省由 provider 自行决定 */
  timeoutMs?: number;
  /** 外部取消信号：中止应原样向上抛，而不是当作「拉取失败」降级 */
  signal?: AbortSignal;
}

/** 日 K 线拉取请求 */
export interface KlineRequest extends ProviderCallOptions {
  /** 上游证券标识（如东财 `1.600519`） */
  secid: string;
  /** 起始日期 `YYYY-MM-DD`（含） */
  startDate: string;
  /** 结束日期 `YYYY-MM-DD`（含） */
  endDate: string;
}

/** 报价快照请求（可选能力） */
export interface QuoteRequest extends ProviderCallOptions {
  secid: string;
}

/** 财务快照请求（可选能力） */
export interface FinancialRequest extends ProviderCallOptions {
  secid: string;
}

/** 报价快照（可选能力的最小公共字段；各源可在实现里扩展） */
export interface ProviderQuote {
  code: string;
  price: number;
  changePct?: number;
  asOf?: string;
}

/** 财务快照（可选能力的最小公共字段；指标名由 provider 约定） */
export interface ProviderFinancial {
  code: string;
  reportDate?: string;
  metrics: Record<string, number>;
}

/**
 * 能力声明：调用方据此判断能否调用可选方法，不要靠「方法存在与否」猜。
 * `kline` 为必需能力；`quote` / `financial` 为可选扩展点（本轮仅东财 K 线，二者声明 false）。
 */
export interface ProviderCapabilities {
  kline: boolean;
  quote: boolean;
  financial: boolean;
  /** 支持的市场；缺省视为全部（A / HK / US） */
  markets?: readonly Market[];
}

/**
 * 数据源 provider：只负责上游适配，不碰缓存与降级。
 * `fetchQuote` / `fetchFinancial` 为可选实现——声明了对应能力且实现了方法才可调用
 * （判断入口见 `registry.providerSupports`）。
 */
export interface DataProvider {
  /** 稳定标识（小写，如 `eastmoney`），DATA_PROVIDERS 用它选择 provider */
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  /** 代码 → 上游证券标识；实现必须拒绝可改写 URL 的字符 */
  resolveSecid(code: string): string;
  /** 拉取指定区间的日 K 线；`null` = 网络/解析失败，`[]` = 区间内无数据 */
  fetchKline(request: KlineRequest): Promise<OHLCVData[] | null>;
  fetchQuote?(request: QuoteRequest): Promise<ProviderQuote | null>;
  fetchFinancial?(request: FinancialRequest): Promise<ProviderFinancial | null>;
}

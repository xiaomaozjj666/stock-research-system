/**
 * 股票代码规范化（纯函数，零依赖）
 * ----------------------------------------------------------------------------
 * 存在理由：本项目多处把用户传入的 code **直接字符串插值**进上游 URL
 * （quant/dataProvider.ts 的 `&secid=${secid}&...&lmt=${lmt}`、intlDataProvider 的
 * `(SECUCODE="${code}")` 过滤表达式）。只要入参没有形态闸门，`code=1&lmt=99999`
 * 这类输入就能改写上游查询参数（放大单次拉取量、绕过既有 lmt 上限），
 * `code=x") OR (SECUCODE="y` 之类能改写上游过滤表达式。
 *
 * 因此本模块同时承担两件事：
 *  1) 入参校验：非法形态一律返回 null，由调用方回 400（而不是拼进 URL 后交给上游）；
 *  2) 字符白名单：任何形态都只允许 `[0-9A-Za-z.-]`，`& ? = 空格 " ( ) / % #` 等
 *     可改写查询/表达式的字符在正则层就被拒掉。
 *
 * 为什么放在 utils/ 且不 import 任何 quant/ 模块：让拼接点自己也能一行接入自守。
 * 建议 quant/dataProvider.ts 的 resolveSecid 接入（该文件不在本次改动范围）：
 *
 *   import { normalizeStockCode } from '../utils/stockCode.js';
 *   export function resolveSecid(code: string): string {
 *     const normalized = normalizeStockCode(code);
 *     if (!normalized) throw new Error(`非法股票代码：${code}`);   // 或降级为 '' 由调用方处理
 *     ...按 normalized.market / normalized.code 拼接
 *   }
 *
 * 形态边界与既有判定保持一致（不新增可被接受、也不收窄既有可用的形态）：
 *  - A 股 6 位数字（services/watchlistService、routes/analyze 等的历史口径）；
 *  - 港股 5 位数字（quant/dataProvider.marketOf 的口径）；
 *  - 港股显式 market=HK 时放宽到 4-5 位（quant/intlDataProvider.fetchIntlKlines 的口径）；
 *  - 美股 1-8 位字母，可含 `.` / `-`（BRK.B、BF-B；intlDataProvider 的 `[A-Za-z.]{1,8}` 口径）。
 */

/** 市场标识（与 quant/dataProvider.Market 同值域） */
export type StockMarket = 'A' | 'HK' | 'US';

/**
 * 原始入参长度上限：任何合法代码（含美股 8 位）都远短于它。
 * 先按长度一刀拒掉，避免把超长串送进正则/日志/上游 URL。
 */
export const MAX_STOCK_CODE_INPUT_LENGTH = 12;

/** A 股：6 位数字（唯一口径，与自选股/分析/回测一致） */
const A_SHARE_RE = /^\d{6}$/;
/** 港股：5 位数字（与 marketOf/detectMarket 一致） */
const HK_RE = /^\d{5}$/;
/** 港股（显式 market=HK）：4-5 位，与 intlDataProvider.fetchIntlKlines 的放行口径一致 */
const HK_RELAXED_RE = /^\d{4,5}$/;
/** 美股：首字符字母，其后 0-7 位字母 / `.` / `-`，总长 ≤ 8 */
const US_RE = /^[A-Za-z][A-Za-z.-]{0,7}$/;
/** 显式 market=A 时的形态（与归一化推断口径相同，单独列出以便阅读） */
const A_SHARE_EXPLICIT_RE = /^\d{6}$/;

/** 规范化结果 */
export interface NormalizedStockCode {
  /** 规范化后的代码（美股统一大写；其余原样） */
  code: string;
  /** 推断/校验出的市场 */
  market: StockMarket;
}

/**
 * 把入参收敛为可校验的字符串。
 * - 字符串：直接用；
 * - 数字：历史行为里 `{"stockCode": 600519}`（JSON 数字）是被接受的，保持兼容；
 * - 其它（数组/对象/布尔/null/NaN/Infinity）：返回 null——Express 的 `?code=a&code=b`
 *   会解析成数组，若用 String() 会拼成 "a,b" 再进正则，这里直接拒绝更明确。
 */
function toRawString(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (typeof input === 'number' && Number.isFinite(input) && Number.isInteger(input)) {
    return String(input);
  }
  return null;
}

/**
 * 校验并规范化股票代码（自动推断市场）。
 * @returns 合法时返回 `{ code, market }`；形态非法（含任何可改写 URL 的字符）返回 null
 */
export function normalizeStockCode(input: unknown): NormalizedStockCode | null {
  const raw = toRawString(input);
  if (raw === null || raw.length > MAX_STOCK_CODE_INPUT_LENGTH) return null;
  const code = raw.trim();
  if (A_SHARE_RE.test(code)) return { code, market: 'A' };
  if (HK_RE.test(code)) return { code, market: 'HK' };
  if (US_RE.test(code)) return { code: code.toUpperCase(), market: 'US' };
  return null;
}

/**
 * 按调用方已知的市场校验（用于显式带 market 的入口，如 /api/intl/*）。
 * 与 normalizeStockCode 的差别：港股放宽到 4-5 位（东财口径），且不做跨市场推断
 * ——显式声明 market=US 却传 6 位数字，应报「格式不符」而不是被悄悄当成 A 股。
 */
export function normalizeStockCodeFor(
  input: unknown,
  market: StockMarket,
): NormalizedStockCode | null {
  const raw = toRawString(input);
  if (raw === null || raw.length > MAX_STOCK_CODE_INPUT_LENGTH) return null;
  const code = raw.trim();
  if (market === 'A') return A_SHARE_EXPLICIT_RE.test(code) ? { code, market: 'A' } : null;
  if (market === 'HK') return HK_RELAXED_RE.test(code) ? { code, market: 'HK' } : null;
  return US_RE.test(code) ? { code: code.toUpperCase(), market: 'US' } : null;
}

/**
 * 仅接受 A 股 6 位数字，返回规范化代码（自选股 / A 股分析 / 批量回测等 A 股专用入口）。
 * 这些入口历史上只认 6 位数字，故不接受港股/美股形态，行为与旧 `/^\d{6}$/` 完全一致。
 */
export function normalizeAShareCode(input: unknown): string | null {
  const out = normalizeStockCodeFor(input, 'A');
  return out ? out.code : null;
}

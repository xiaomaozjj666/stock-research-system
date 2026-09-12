/**
 * Tushare Pro HTTP 适配器（可选数据通道）
 * ============================================================================
 * 解决免费东财接口的三个结构性缺口（均为研究有效性问题而非功能问题）：
 *   1. **幸存者偏差** —— stock_basic(list_status='D'/'P'/'L') 含退市/暂停上市股，
 *      免费主表只有当前上市证券；
 *   2. **历史指数成分** —— index_weight 给出指数成分的历史变动（沪深300 调仓等），
 *      免费接口只有当前成分；
 *   3. **双日期 PIT 财务** —— income/fina_indicator 同时给公告日（ann_date）与
 *      报告期（end_date），是比「报告期+估算公告延迟」更严格的 PIT 口径。
 *
 * 为什么不需要 Python sidecar：Tushare Pro 本身是 HTTP API（POST JSON + token），
 * Node 原生可调——此前「TS 生态无官方客户端」指的是 baostock/akshare 等
 * Python 库，与 Tushare Pro 无关。
 *
 * 使用前提与诚实边界：
 *  - 需要注册 tushare.pro 获取 token，经 `TUSHARE_TOKEN` 环境变量注入；
 *    未配置时 isTushareConfigured() 为 false，所有调用抛错——调用方必须降级
 *    （免费接口是主通道，Tushare 是增强通道，绝不能反向依赖）；
 *  - 积分制：低积分（<2000）接口覆盖窄且频控严（约 50-200 次/分钟）；
 *    高校师生可申请免费积分；批量拉取务必走 quantCache 落盘缓存；
 *  - 数据商协议限制再分发——拉取的数据只用于本机研究，不入库不外传。
 */

const TUSHARE_API = 'https://api.tushare.pro';

export function isTushareConfigured(): boolean {
  return (process.env.TUSHARE_TOKEN ?? '').trim().length > 0;
}

/** Tushare Pro 通用响应结构 */
interface TsResponse {
  code: number;
  msg: string | null;
  data: { fields: string[]; items: unknown[][] } | null;
}

/** 调用 Tushare Pro 接口（POST JSON）；未配置 token / 上游错误均抛错 */
export async function callTushare(
  apiName: string,
  params: Record<string, unknown> = {},
  fields?: string,
): Promise<Record<string, unknown>[]> {
  const token = (process.env.TUSHARE_TOKEN ?? '').trim();
  if (!token) {
    throw new Error('TUSHARE_TOKEN 未配置：Tushare 通道不可用（免费东财接口为主通道，不受影响）');
  }
  const resp = await fetch(TUSHARE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_name: apiName,
      token,
      params,
      ...(fields ? { fields } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await resp.json()) as TsResponse;
  if (json.code !== 0 || !json.data) {
    throw new Error(`Tushare ${apiName} 失败：[${json.code}] ${json.msg ?? 'unknown'}`);
  }
  const { fields: cols, items } = json.data;
  return items.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      obj[c] = row[i];
    });
    return obj;
  });
}

export interface StockBasicRow {
  /** ts_code（如 600519.SH） */
  tsCode: string;
  name: string;
  /** L 上市 / D 退市 / P 暂停上市 */
  listStatus: 'L' | 'D' | 'P' | string;
  listDate: string | null;
  delistDate: string | null;
  industry: string | null;
}

/**
 * 证券主表（含退市/暂停上市）：幸存者偏差修复的数据源。
 * listStatus 传 'L'/'D'/'P' 或不传（全部）。
 */
export async function fetchStockBasic(listStatus?: string): Promise<StockBasicRow[]> {
  const rows = await callTushare(
    'stock_basic',
    listStatus ? { list_status: listStatus } : {},
    'ts_code,name,list_status,list_date,delist_date,industry',
  );
  return rows.map((r) => ({
    tsCode: String(r.ts_code ?? ''),
    name: String(r.name ?? ''),
    listStatus: String(r.list_status ?? ''),
    listDate: r.list_date ? String(r.list_date) : null,
    delistDate: r.delist_date ? String(r.delist_date) : null,
    industry: r.industry ? String(r.industry) : null,
  }));
}

export interface IndexWeightRow {
  /** 指数代码（如 000300.SH） */
  indexCode: string;
  /** 成分股 ts_code */
  conCode: string;
  /** 纳入日期 */
  inDate: string | null;
  weight: number | null;
}

/**
 * 指数历史成分（按月快照）：历史成分股/回测宇宙修复的数据源。
 * @param tradeDate 交易日期（YYYYMMDD），返回该日快照
 */
export async function fetchIndexWeight(
  indexCode: string,
  tradeDate: string,
): Promise<IndexWeightRow[]> {
  const rows = await callTushare(
    'index_weight',
    { index_code: indexCode, trade_date: tradeDate },
    'index_code,con_code,in_date,weight',
  );
  return rows.map((r) => ({
    indexCode: String(r.index_code ?? ''),
    conCode: String(r.con_code ?? ''),
    inDate: r.in_date ? String(r.in_date) : null,
    weight: typeof r.weight === 'number' ? r.weight : null,
  }));
}

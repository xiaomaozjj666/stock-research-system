/**
 * 季度财报时间序列（东方财富 F10 主要财务指标，全部报告期）
 * --------------------------------------------------------------------------
 * 年报口径（fetchFinancialFromEastMoney）一年只有一个点，无法回答：
 *   - 盈利在**加速还是减速**（单季同比的趋势）？
 *   - 最新一份季报有没有**超预期**（单季同比相对前几季的偏离，PEAD 事件因子）？
 *
 * 本模块拉取同一 RPT_F10_FINANCE_MAINFINADATA 接口的**全部报告期**
 * （一季报/中报/三季报/年报混排，均为年初累计口径），并透出 NOTICE_DATE
 * （公告日）供事件因子对齐 K 线。字段口径与年报抓取一致：
 *   - 货币字段单位为元 → yuanToYi 转亿元；
 *   - ROEJQ/XSMLL/ZCFZL 及 *TZ 同比字段均为百分比数值（如 16.75 = 16.75%）。
 *
 * 解析与拉取分离：parseQuarterlyRecords 为纯函数可独立单测；
 * fetchQuarterlyFinancials 失败抛错由调用方降级（截面评估缺季度数据时
 * 相应因子如实跳过，绝不编造）。
 */

import { fetchJson } from '../utils/http.js';
import { yuanToYi } from './dataFetcher.js';
import logger from '../utils/logger.js';

/** 单个报告期（累计口径）的季度财务快照 */
export interface QuarterlyReport {
  /** 报告期（YYYY-MM-DD，如 2026-06-30 = 中报） */
  reportDate: string;
  /** 公告日（YYYY-MM-DD）；接口缺失时为 null（该期不参与事件因子） */
  noticeDate: string | null;
  /** 营业总收入（累计，亿元） */
  revenue: number | null;
  /** 归母净利润（累计，亿元） */
  netProfit: number | null;
  /** 加权 ROE（累计，%） */
  roe: number | null;
  /** 毛利率（%） */
  grossMargin: number | null;
  /** 资产负债率（%） */
  debtRatio: number | null;
  /** 营收累计同比（%） */
  revenueYoY: number | null;
  /** 归母净利累计同比（%） */
  netProfitYoY: number | null;
}

export interface QuarterlySeries {
  code: string;
  /** 按报告期升序 */
  reports: QuarterlyReport[];
  source: 'eastmoney_f10';
}

/** null 感知的数值解析：接口缺失（null/'-'/非数值）→ null，绝不洗成 0 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 日期字段（"2026-06-30 00:00:00"）→ "2026-06-30"；非法返回 null */
function dateOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * 解析 F10 主要财务指标行 → 季度序列（升序、按报告期去重保留最新公告）。
 * 输入行的字段缺失情况参差（金融股/次新股常见 null），逐字段 numOrNull。
 */
export function parseQuarterlyRecords(
  rows: Record<string, unknown>[],
  code: string,
): QuarterlySeries {
  const byDate = new Map<string, QuarterlyReport>();
  for (const r of rows) {
    const reportDate = dateOrNull(r.REPORT_DATE);
    if (!reportDate) continue;
    const yi = (v: unknown): number | null => {
      const n = numOrNull(v);
      return n === null ? null : yuanToYi(n);
    };
    const report: QuarterlyReport = {
      reportDate,
      noticeDate: dateOrNull(r.NOTICE_DATE),
      revenue: yi(r.TOTALOPERATEREVE),
      netProfit: yi(r.PARENTNETPROFIT),
      roe: numOrNull(r.ROEJQ),
      grossMargin: numOrNull(r.XSMLL),
      debtRatio: numOrNull(r.ZCFZL),
      revenueYoY: numOrNull(r.TOTALOPERATEREVETZ),
      netProfitYoY: numOrNull(r.PARENTNETPROFITTZ),
    };
    const prev = byDate.get(reportDate);
    // 同一报告期可能因更正公告出现多行：保留公告日较新的一行
    if (!prev || (report.noticeDate ?? '') >= (prev.noticeDate ?? '')) {
      byDate.set(reportDate, report);
    }
  }
  const reports = [...byDate.values()].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  return { code, reports, source: 'eastmoney_f10' };
}

/**
 * 拉取最近 limit 个报告期的季度财务（含年报与季报，均为累计口径）。
 *
 * @throws 数据为空 / 接口失败时抛错；调用方 catch 后降级为无季度数据
 */
export async function fetchQuarterlyFinancials(code: string, limit = 16): Promise<QuarterlySeries> {
  const secucode = `${code}.${code.startsWith('6') ? 'SH' : 'SZ'}`;
  const capped = Math.max(4, Math.min(40, Math.floor(limit) || 16));
  const url =
    `https://datacenter.eastmoney.com/api/data/get?type=RPT_F10_FINANCE_MAINFINADATA` +
    `&sty=APP_F10_MAINFINADATA&filter=(SECUCODE="${secucode}")` +
    `&p=1&ps=${capped}&sr=-1&st=REPORT_DATE&source=HSF10&client=PC`;

  const json = (await fetchJson(url, { timeoutMs: 10_000, retries: 1 })) as {
    result?: { data?: Record<string, unknown>[] };
  } | null;
  const rows = json?.result?.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`无法获取 ${code} 的季度财务数据`);
  }
  const series = parseQuarterlyRecords(rows, code);
  if (series.reports.length === 0) {
    throw new Error(`${code} 季度财务数据解析为空`);
  }
  logger.debug('季度财务获取完成', { code, reports: series.reports.length });
  return series;
}

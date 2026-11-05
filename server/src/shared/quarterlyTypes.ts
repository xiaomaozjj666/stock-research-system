/**
 * 季度财报共享类型（quant 与 services 共用）
 * ----------------------------------------------------------------------------
 * 原定义在 services/quarterlyFinancials.ts，quant 侧（crossSectionBuilder /
 * fundamentalDepth / factorExpression / fundamentalCache）都要引用，形成
 * quant → services 的反向依赖（与 services → quant 构成包级循环）。
 * 类型下沉到 shared 后，两个包都只依赖本模块，依赖方向恢复单向。
 * 字段口径说明见 services/quarterlyFinancials.ts 的模块头注释。
 */

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

/**
 * 机构一致预期快照（东方财富 datacenter）——盈利预测 + 北向持股。
 *
 * 背景（2026-09-12）：业绩超预期因子（PEAD）只有「实际 vs 历史」半边，缺
 * 「市场预期」半边。东财 datacenter 报表 RPT_WEB_RESPREDICT 提供分析师
 * 一致预期快照（覆盖机构数、评级分布、未来多年 EPS 预测、目标价区间），
 * 北向持股（RPT_MUTUAL_HOLDSTOCKNORTH_STA）提供季度香港中央结算持股快照。
 *
 * **字段口径已用真实 API 响应验证（2026-09-12 ground truth）**：
 *   - 盈利预测：reportName=RPT_WEB_RESPREDICT，filter=(SECURITY_CODE="600519")，
 *     sortColumns=SECURITY_CODE（该报表一行一票，排序仅是接口必填参数）。
 *     RATING_ORG_NUM=覆盖机构数（茅台 45）；RATING_BUY/ADD/NEUTRAL/REDUCE/SALE_NUM
 *     =评级分布（缺失为 null）；YEAR1..4 + YEAR_MARK1..4（"A"=实际值，"E"=预测值）
 *     + EPS1..4=逐年度 EPS（元）；DEC_AIMPRICEMAX/MIN=目标价区间（元）；
 *     INDUSTRY_BOARD=行业板块。
 *   - 北向持股：reportName=RPT_MUTUAL_HOLDSTOCKNORTH_STA，sortColumns=TRADE_DATE。
 *     **该报表现仅保留最新季度快照一行**（2024-08 交易所停止逐日披露后，只剩
 *     季度口径）：TRADE_DATE=披露日、HOLD_SHARES_RATIO=占流通股比（%）、
 *     HOLD_MARKET_CAP=持股市值（元）、MUTUAL_TYPE="001"=沪股通/"002"=深股通。
 *
 * **诚实边界——快照数据不做回测因子**：两报表都是「当前时点」快照，无历史
 * 序列。拿它当历史因子评估就是前视（把今天的预期投影回过去），因此本模块
 * 只服务两类场景：① 深度分析管线（analysisPipeline）的 LLM 语境与结果展示；
 * ② 单票查询接口。任何把它接入截面回测的行为都属于方法论错误。
 *
 * 缓存：快照随研报/季度披露更新，TTL 默认 12h
 * （QUANT_CONSENSUS_CACHE_TTL_HOURS，显式 0 = 关闭）。
 */
import { fetchReportRows } from './eventProvider.js';
import { withQuantCache } from './quantCache.js';

/** 单年度 EPS（mark: "A"=实际值 / "E"=预测值） */
export interface ConsensusEpsForecast {
  year: number;
  eps: number;
  mark: 'A' | 'E';
}

/** 北向持股最新季度快照 */
export interface NorthHoldingsSnapshot {
  /** 披露日（YYYY-MM-DD，季度末） */
  date: string;
  /** 占流通股比（%） */
  holdSharesRatio: number | null;
  /** 持股市值（元） */
  holdMarketCap: number | null;
}

export interface ConsensusSnapshot {
  code: string;
  /** 覆盖机构数（无研报覆盖时整个快照为 null，不会返回空壳） */
  orgNum: number | null;
  /** 评级分布（%，缺失为 null——不补 0，避免把「无评级」伪装成「中性」） */
  ratings: {
    buy: number | null;
    add: number | null;
    neutral: number | null;
    reduce: number | null;
    sale: number | null;
  };
  /** 逐年度 EPS（含实际年份与预测年份，mark 区分） */
  forecasts: ConsensusEpsForecast[];
  /** 目标价区间（元） */
  targetPriceMax: number | null;
  targetPriceMin: number | null;
  /** 北向持股最新季度快照（查询失败/无记录时缺省） */
  north?: NorthHoldingsSnapshot;
}

function consensusCacheTtlMs(): number {
  const raw = process.env.QUANT_CONSENSUS_CACHE_TTL_HOURS;
  if (raw !== undefined && raw.trim() !== '') {
    const hours = Number(raw);
    if (Number.isFinite(hours)) return hours > 0 ? hours * 60 * 60 * 1000 : 0;
  }
  return 12 * 60 * 60 * 1000;
}

/** 东财日期可能是 "YYYY-MM-DD HH:mm:ss"，归一为前 10 位 */
function normDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}

/** 按候选字段取数值（数字或可解析字符串），全缺返回 null */
function numOf(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * 拉取单股机构一致预期快照（盈利预测 + 北向持股，一次网络往返各一）。
 * 返回 null 表示「无研报覆盖 / 查询成功但无数据」；抛错由调用方降级。
 * 北向持股失败只让快照缺 north 字段，不影响盈利预测部分。
 */
export async function fetchConsensusSnapshot(
  code: string,
  signal?: AbortSignal,
): Promise<ConsensusSnapshot | null> {
  return withQuantCache(`consensus_${code}`, consensusCacheTtlMs(), async () => {
    const rows = await fetchReportRows(
      'RPT_WEB_RESPREDICT',
      `(SECURITY_CODE="${code}")`,
      'SECURITY_CODE',
      '1',
      signal,
    );
    const row = rows[0];
    if (!row) return null;

    // YEAR1..4 与 EPS1..4 按下标配对；mark 缺失/非法的年度丢弃
    const forecasts: ConsensusEpsForecast[] = [];
    for (let i = 1; i <= 4; i++) {
      const year = numOf(row, [`YEAR${i}`]);
      const eps = numOf(row, [`EPS${i}`]);
      const mark = row[`YEAR_MARK${i}`];
      if (year === null || eps === null) continue;
      if (mark !== 'A' && mark !== 'E') continue;
      forecasts.push({ year, eps, mark });
    }

    let north: NorthHoldingsSnapshot | undefined;
    try {
      const northRows = await fetchReportRows(
        'RPT_MUTUAL_HOLDSTOCKNORTH_STA',
        `(SECURITY_CODE="${code}")`,
        'TRADE_DATE',
        '-1',
        signal,
      );
      const n = northRows[0];
      if (n) {
        north = {
          date: normDate(n.TRADE_DATE) ?? '',
          holdSharesRatio: numOf(n, ['HOLD_SHARES_RATIO']),
          holdMarketCap: numOf(n, ['HOLD_MARKET_CAP']),
        };
        if (!north.date) north = undefined;
      }
    } catch {
      /* 北向失败不拖垮盈利预测快照 */
    }

    return {
      code,
      orgNum: numOf(row, ['RATING_ORG_NUM']),
      ratings: {
        buy: numOf(row, ['RATING_BUY_NUM']),
        add: numOf(row, ['RATING_ADD_NUM']),
        neutral: numOf(row, ['RATING_NEUTRAL_NUM']),
        reduce: numOf(row, ['RATING_REDUCE_NUM']),
        sale: numOf(row, ['RATING_SALE_NUM']),
      },
      forecasts,
      targetPriceMax: numOf(row, ['DEC_AIMPRICEMAX']),
      targetPriceMin: numOf(row, ['DEC_AIMPRICEMIN']),
      north,
    };
  });
}

/**
 * 把快照格式化为 LLM 语境块（中文，纯文本；与 formatFinancialBrief 同风格）。
 * 只呈现事实数字，不代做判断——判断留给专家。
 */
export function formatConsensusBrief(snap: ConsensusSnapshot): string {
  const lines: string[] = [];
  lines.push('【机构一致预期（当前快照，非时点序列）】');
  if (snap.orgNum !== null) {
    const r = snap.ratings;
    const dist = [
      r.buy !== null ? `买入${r.buy}` : null,
      r.add !== null ? `增持${r.add}` : null,
      r.neutral !== null ? `中性${r.neutral}` : null,
      r.reduce !== null ? `减持${r.reduce}` : null,
      r.sale !== null ? `卖出${r.sale}` : null,
    ]
      .filter(Boolean)
      .join('、');
    lines.push(`覆盖机构 ${snap.orgNum} 家${dist ? `（${dist}）` : ''}。`);
  }
  const est = snap.forecasts.filter((f) => f.mark === 'E');
  if (est.length > 0) {
    lines.push(
      `分析师 EPS 预测：${est.map((f) => `${f.year}E ${f.eps.toFixed(2)}元`).join('，')}。`,
    );
  }
  if (snap.targetPriceMin !== null || snap.targetPriceMax !== null) {
    const lo = snap.targetPriceMin !== null ? snap.targetPriceMin : '—';
    const hi = snap.targetPriceMax !== null ? snap.targetPriceMax : '—';
    lines.push(`目标价区间 ${lo} ~ ${hi} 元。`);
  }
  if (snap.north) {
    const cap =
      snap.north.holdMarketCap !== null
        ? `，市值 ${(snap.north.holdMarketCap / 1e8).toFixed(1)} 亿`
        : '';
    const ratio =
      snap.north.holdSharesRatio !== null ? `占流通股比 ${snap.north.holdSharesRatio}%` : '';
    lines.push(
      `北向持股（${snap.north.date} 季度披露）：${[ratio, cap].filter(Boolean).join('')}。`,
    );
  }
  return lines.join('\n');
}

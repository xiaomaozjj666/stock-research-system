/**
 * 时序计量统一入口（HTTP 路由与 Chat 工具共用）
 * ----------------------------------------------------------------------------
 * 把「取数 → 校验 → 分派到 adf/garch/coint/arima/kalman」的口径收敛在一处，
 * 两条入口（POST /api/quant/timeseries/analyze 与 chat 的 run_timeseries_analyze）
 * 共享同一实现，避免参数校验与 PIT/窗口口径漂移。
 *
 * 错误约定：参数问题与数据不足都抛 Error，由调用方区分处理——
 * HTTP 路由按 message 命中「数据不足/观测不足」映射 502，其余映射 400。
 */
import { fetchOHLCVData } from '../dataProvider.js';
import { adfTest, type AdfSpec } from './adf.js';
import { fitVolatilityModels } from './garch.js';
import { engleGranger } from './cointegration.js';
import { fitArima } from './arima.js';
import { timeVaryingBeta } from './kalman.js';

export const TS_TESTS = ['adf', 'garch', 'coint', 'arima', 'kalman-beta'] as const;
export type TsTest = (typeof TS_TESTS)[number];

/** K 线行的最小结构（只取日期与收盘） */
interface CloseRow {
  date: string;
  close: number;
}

/** 本地时区日期 → YYYY-MM-DD */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 按日期对齐两条收盘序列（取交集，升序） */
function alignCloses(a: CloseRow[], b: CloseRow[]): { y: number[]; x: number[] } {
  const map = new Map<string, number>();
  for (const k of b) map.set(k.date, k.close);
  const y: number[] = [];
  const x: number[] = [];
  for (const k of a) {
    const v = map.get(k.date);
    if (v !== undefined) {
      y.push(k.close);
      x.push(v);
    }
  }
  return { y, x };
}

/** 收盘价 → 对数收益 */
function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

export interface TimeseriesAnalyzeInput {
  test: string;
  code: string;
  code2?: string;
  startDate?: string;
  endDate?: string;
  options?: Record<string, unknown>;
}

export interface TimeseriesAnalyzeResult {
  test: TsTest;
  code: string | [string, string];
  window: { startDate: string; endDate: string; n: number };
  result: unknown;
  input?: string;
  note?: string;
}

/**
 * 执行一次时序计量分析。任何问题（参数非法 / 数据不足 / 窗口非法）都抛
 * 带中文原因的 Error；数据不足类错误请按 message 命中映射 502。
 */
export async function analyzeTimeseries(
  input: TimeseriesAnalyzeInput,
): Promise<TimeseriesAnalyzeResult> {
  const test = (input.test ?? '').trim() as TsTest;
  if (!TS_TESTS.includes(test)) {
    throw new Error(`test 需为 ${TS_TESTS.map((t) => `'${t}'`).join(' | ')} 之一`);
  }
  const code = (input.code ?? '').trim();
  const code2 = (input.code2 ?? '').trim();
  if (!code) throw new Error('code 必填');
  if ((test === 'coint' || test === 'kalman-beta') && !code2) {
    throw new Error(`test='${test}' 需要第二条序列（code2）`);
  }

  // 时间窗口：默认近 3 年（日频 ≈ 730 个观测，GARCH/ADF 都够用），上限 10 年
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const endD = new Date();
  const defaultStart = new Date(endD);
  defaultStart.setFullYear(defaultStart.getFullYear() - 3);
  const endDate =
    typeof input.endDate === 'string' && dateRe.test(input.endDate)
      ? input.endDate
      : localDateStr(endD);
  const startDate =
    typeof input.startDate === 'string' && dateRe.test(input.startDate)
      ? input.startDate
      : localDateStr(defaultStart);
  const floor = new Date(endD);
  floor.setFullYear(floor.getFullYear() - 10);
  if (startDate < localDateStr(floor)) {
    throw new Error('时间窗口最多 10 年（startDate 过早）');
  }
  if (startDate >= endDate) {
    throw new Error('startDate 需早于 endDate');
  }

  const klines = await fetchOHLCVData(code, startDate, endDate);
  if (!klines || klines.length < 60) {
    throw new Error(
      `${code} 的 K 线数据不足（${klines?.length ?? 0} 条 < 60），请检查代码或扩大时间窗口`,
    );
  }
  const closes: CloseRow[] = klines.map((k) => ({ date: k.date, close: k.close }));
  const window = { startDate, endDate, n: closes.length };
  const options = input.options ?? {};

  if (test === 'adf') {
    const on = options.on === 'price' ? 'price' : 'return';
    const spec = (typeof options.spec === 'string' ? options.spec : 'c') as AdfSpec;
    if (!['n', 'c', 'ct'].includes(spec)) throw new Error("spec 需为 'n' | 'c' | 'ct'");
    const series =
      on === 'price' ? closes.map((r) => r.close) : logReturns(closes.map((r) => r.close));
    const result = adfTest(series, {
      spec,
      ...(typeof options.criterion === 'string' && ['aic', 'bic'].includes(options.criterion)
        ? { criterion: options.criterion as 'aic' | 'bic' }
        : {}),
    });
    return {
      test,
      code,
      window,
      input: on,
      result,
      note:
        on === 'price'
          ? '价格序列通常应拒绝失败（存在单位根）；若价格被判定为平稳，多见于样本极短或数据异常'
          : '对数收益序列若不能拒绝单位根，说明该序列方差结构异常，慎用于 GARCH/ARIMA 前提检查',
    };
  }

  if (test === 'garch') {
    const returns = logReturns(closes.map((r) => r.close));
    if (returns.length < 60) {
      throw new Error('对数收益观测不足 60 条，无法拟合 GARCH');
    }
    return { test, code, window, result: fitVolatilityModels(returns) };
  }

  if (test === 'arima') {
    const d =
      typeof options.d === 'number' && [0, 1, 2].includes(options.d) ? options.d : undefined;
    const pMax = typeof options.pMax === 'number' && options.pMax >= 0 ? options.pMax : undefined;
    const result = fitArima(
      closes.map((r) => r.close),
      {
        ...(d !== undefined ? { d } : {}),
        ...(pMax !== undefined ? { pMax } : {}),
      },
    );
    return { test, code, window, result };
  }

  // coint / kalman-beta：需要第二条对齐序列
  const klines2 = await fetchOHLCVData(code2, startDate, endDate);
  if (!klines2 || klines2.length < 60) {
    throw new Error(`${code2} 的 K 线数据不足（${klines2?.length ?? 0} 条 < 60）`);
  }
  const aligned = alignCloses(
    closes,
    klines2.map((k) => ({ date: k.date, close: k.close })),
  );
  if (aligned.y.length < 60) {
    throw new Error(`两序列按日期对齐后仅 ${aligned.y.length} 条（<60），日期范围可能不重叠`);
  }
  const windowAligned = { startDate, endDate, n: aligned.y.length };

  if (test === 'coint') {
    return {
      test,
      code: [code, code2],
      window: windowAligned,
      result: engleGranger(aligned.y, aligned.x),
      note: '结论仅说明历史区间内的统计关系，协整结构可能随时间漂移；交易执行还需叠加成本与持仓周期约束',
    };
  }

  // kalman-beta
  const qRatio =
    typeof options.qRatio === 'number' && options.qRatio > 0 ? options.qRatio : undefined;
  const result = timeVaryingBeta(aligned.y, aligned.x, qRatio ? { qRatio } : {});
  // β 序列整体太大，响应里只回末端 60 天，避免超大 payload
  const tail = Math.min(60, result.hedgeRatio.length);
  return {
    test,
    code: [code, code2],
    window: windowAligned,
    result: {
      ...result,
      intercept: result.intercept.slice(-tail),
      hedgeRatio: result.hedgeRatio.slice(-tail),
      oneStepErrors: result.oneStepErrors.slice(-tail),
      tailLength: tail,
      truncated: result.hedgeRatio.length > tail,
    },
    note: 'β_t 为状态随时间漂移的在线估计；期末 β 与静态 OLS β 的差距反映近期协整关系是否漂移',
  };
}

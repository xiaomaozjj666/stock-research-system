import type { IntlFundamentalsResult, IntlMarket } from '../../types';
import type {
  GETApiIntlKlinesResponse as IntlKlinesResponse,
  IntlKline as GeneratedIntlKline,
  ValuationModelResult as GeneratedValuationModelResult,
} from '../generated';
import { api, normalizeApiError } from './base';

// === 港美股财务估值（东财 datacenter RPT 网关） ===
export async function getIntlFundamentals(
  code: string,
  market?: IntlMarket,
): Promise<IntlFundamentalsResult> {
  try {
    const response = await api.get<IntlFundamentalsResult>('/intl/fundamentals', {
      params: { code, market },
      timeout: 30000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '港美股数据获取失败');
  }
}

/**
 * 港美股日 K 线（东财通道，secid 映射 116.x / 107.x）。
 * 类型来自生成的 IntlKline —— 比此前手写版多一个 isSimulated：
 * 上游取数失败时服务端会降级为**模拟 K 线**并置该标记，消费方据此如实提示用户，
 * 不能当成真实行情画图。原先手写类型漏了这个字段，等于丢掉了这个提示能力。
 */
export type IntlKline = GeneratedIntlKline;

export async function getIntlKlines(params: {
  code: string;
  market?: string;
  startDate?: string;
  endDate?: string;
}): Promise<IntlKlinesResponse> {
  try {
    // 类型来自生成的 GETApiIntlKlinesResponse：契约里已含服务端回显的
    // startDate / endDate，不再需要「只声明被消费字段」的手工裁剪。
    const response = await api.get<IntlKlinesResponse>('/intl/klines', {
      params,
      timeout: 30000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '港美股 K 线获取失败');
  }
}

/**
 * 估值建模结果（两阶段 EPS 贴现 + 可比公司表）。
 *
 * 改用契约生成的类型：手写版有两处与实现不符 ——
 *   1) sensitivity.matrix 声明成 number[][]，但服务端对非法假设格写 null
 *      （g2 接近 r 等无解组合），按 number[][] 消费会拿到与 null 比较的假代码；
 *   2) dcf.assumptions 声明成 Record<string, number>，实际是结构化对象
 *      （growthRate1/growthRate2/discountRate/explicitYears/baseEps）。
 */
export type ValuationModelResult = GeneratedValuationModelResult;

export async function runValuationModelApi(params: {
  code: string;
  assumptions?: {
    growthRate1?: number;
    growthRate2?: number;
    discountRate?: number;
    explicitYears?: number;
    baseEps?: number;
  };
}): Promise<ValuationModelResult> {
  try {
    const response = await api.post<ValuationModelResult>('/quant/valuation/model', params, {
      timeout: 60000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '估值建模失败');
  }
}

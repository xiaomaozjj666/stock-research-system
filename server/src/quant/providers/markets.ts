import { isAShareCode, isHKCode, isUSCode } from '../../utils/stockCode.js';
import type { Market } from './types.js';

/**
 * 识别市场：口径统一走 utils/stockCode 的三个判定函数——美股形态（含 `.`/`-`）
 * 在各层必须是同一个定义，否则 BRK.B 在路由层通过、到这里被当成 A 股拼 `0.BRK.B`。
 *
 * 市场判定与具体数据源无关（东财/其它源共用同一份分类），故放在 providers 的
 * 共享层而不是某个 provider 内部。
 */
export function marketOf(code: string): Market {
  const c = code.trim();
  if (isAShareCode(c)) return 'A';
  if (isHKCode(c)) return 'HK';
  if (isUSCode(c)) return 'US';
  return 'A';
}

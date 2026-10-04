/**
 * 契约生成类型 ↔ 前端手写类型的等价性校验（编译期门禁，零运行时）
 * ============================================================================
 * 为什么要这个文件：前端有一批自己手写的类型（client/src/types.ts 等），它们与
 * 生成类型（client/src/api/generated.ts）**描述同一批响应**。两份定义只要分叉，
 * 就是「契约说的」与「前端以为的」不一致——这正是本项目反复出现的那类 bug。
 * 本轮补响应 schema 时就靠它抓出了 9 处真实漂移，例如：
 *   - 契约 `horizons` 声明成 string[]，而 parseHorizons 收的是整数数组
 *   - 契约 `IntlFundamentalsResult.fundamentals` 漏写可空（只在 description 里
 *     说「可能为 null」），生成出的类型非空，消费方照契约写代码就会崩
 *   - 契约 `ScenarioResult` 漏了 supportingArguments、preconditions 误标可选
 *   - 前端 FinancialData 把服务端必填的 6 个字段标成可选（防御性放宽）
 *
 * ⚠️ 这里踩过两个坑，都必须记下：
 *
 * 1. `type _X = A extends B ? true : never` 看似是断言，实则**永远绿**——
 *    TS 对未加约束的条件类型不做求值检查，一个明显不成立的关系也能编译通过。
 *    那是虚假安全感，比没有守卫更危险。
 * 2. 社区流行的 `Equal<X, Y>`（互斥签名）在本项目会**误报**：两侧各自声明了同名
 *    `PaperPosition`/`FinancialData` 等结构，形状逐字相同，但因是两次独立声明，
 *    `Equal` 判为 false（它比的是类型 identity，不是结构）。
 *
 * 最终采用**双向赋值**（`const _: B = a` 两个方向），它是编译器真正会检查的形式：
 * 实测对「形状相同但分别声明」的类型放行，对字段增删/可选性变化/类型不兼容报错。
 * 本文件末尾附有反向验证用例所需的说明——改判据前请先读那段。
 */

import type * as Generated from './generated';
import type * as Hand from '../types';

/*
 * 双向赋值即断言。每对写两行（两个方向），任何一侧不兼容都会在这里编译失败，
 * 错误信息会直接指名是哪个类型的哪个字段不兼容。
 *
 * 为什么用 `declare const` 而非 `satisfies`：这里只需要**类型关系**成立，
 * 不需要任何值；declare 不产生运行时代码，也就不会进 bundle。
 */

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-declare */

// --- AnalysisResult（/api/analyze 的 200） ---
declare const _ar_g: Generated.AnalysisResult;
declare const _ar_h: Hand.AnalysisResult;
export const _arToHand: Hand.AnalysisResult = _ar_g;
export const _arToGen: Generated.AnalysisResult = _ar_h;

// --- CompareResponse（/api/compare 的 200） ---
declare const _cr_g: Generated.CompareResponse;
declare const _cr_h: Hand.CompareResponse;
export const _crToHand: Hand.CompareResponse = _cr_g;
export const _crToGen: Generated.CompareResponse = _cr_h;

// --- HistorySummary（/api/history 列表项） ---
declare const _hs_g: Generated.HistorySummary;
declare const _hs_h: Hand.HistorySummary;
export const _hsToHand: Hand.HistorySummary = _hs_g;
export const _hsToGen: Generated.HistorySummary = _hs_h;

// --- AuditEntry（/api/audit 的 entries 元素） ---
declare const _ae_g: Generated.AuditEntry;
declare const _ae_h: Hand.AuditEntry;
export const _aeToHand: Hand.AuditEntry = _ae_g;
export const _aeToGen: Generated.AuditEntry = _ae_h;

// --- PaperPortfolio（/api/paper/portfolio 的 200） ---
declare const _pp_g: Generated.PaperPortfolio;
declare const _pp_h: Hand.PaperPortfolio;
export const _ppToHand: Hand.PaperPortfolio = _pp_g;
export const _ppToGen: Generated.PaperPortfolio = _pp_h;

// --- PaperStats（/api/paper/stats 的 200） ---
declare const _ps_g: Generated.PaperStats;
declare const _ps_h: Hand.PaperStats;
export const _psToHand: Hand.PaperStats = _ps_g;
export const _psToGen: Generated.PaperStats = _ps_h;

// --- WatchlistMonitorResult（/api/watchlist/monitor 的 200） ---
declare const _wm_g: Generated.WatchlistMonitorResult;
declare const _wm_h: Hand.WatchlistMonitorResult;
export const _wmToHand: Hand.WatchlistMonitorResult = _wm_g;
export const _wmToGen: Generated.WatchlistMonitorResult = _wm_h;

// --- IntlFundamentalsResult（/api/intl/fundamentals 的 200） ---
declare const _if_g: Generated.IntlFundamentalsResult;
declare const _if_h: Hand.IntlFundamentalsResult;
export const _ifToHand: Hand.IntlFundamentalsResult = _if_g;
export const _ifToGen: Generated.IntlFundamentalsResult = _if_h;

/*
 * 下面这组是**别名**而非独立声明（client.ts 里已收敛为 `type X = Generated.X`），
 * 按���它们不是"两份定义"，不需要等价断言；列在这里是为了让读者知道
 * 哪些类型已经收敛、哪些还留在 client/types.ts 里手写。
 * 尚未收敛的（刻意保留手写）：页面层自己消费、契约里没有对应 operation 的类型，
 * 例如 QuantResearchReport / CrossSectionResult（pages/quant/types.ts）——
 * 它们是**前端页面的展示模型**，不是 API 契约的一部分，不应由契约生成。
 */

// --- 因子实验台账（/api/quant/factor/experiments 的 items 元素） ---
// 注意它在 client.ts 而非 types.ts（那是 api 层自己导出的消费方类型）
import type { FactorExperiment as FactorExperimentHand } from './client';
declare const _fe_g: Generated.FactorExperiment;
declare const _fe_h: FactorExperimentHand;
export const _feToHand: FactorExperimentHand = _fe_g;
export const _feToGen: Generated.FactorExperiment = _fe_h;

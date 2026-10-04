/**
 * 截面因子评估（逐日 IC / 分层 / OOS / 因子组合回测）
 *
 * 本文件由原 routes/quant.ts 按领域机械拆分而来（2026-09-28）：
 * 路由路径、限流与熔断参数逐字未变，对外 HTTP 契约零变化。
 * 跨领域共用的取数扇出 / 入参校验 / 模拟数据闸门在 services/quant/panelService.ts。
 */

import { Router } from 'express';

import { quantLimiter, circuitBreakerGuard } from '../middleware.js';
import { evaluateFactor, type FactorObservation } from '../quant/factorEvaluation.js';
import {
  buildCrossSectionPanel,
  type FundamentalFactorName,
} from '../quant/crossSectionBuilder.js';
import { runPreflight } from '../quant/preflight.js';
import { isTushareConfigured, fetchStockBasicCached } from '../quant/tushareAdapter.js';
import { recordFactorExperiments, summarizeFactorExperiments } from '../quant/factorLedger.js';
import { buildEarningsSurpriseObservations } from '../quant/fundamentalDepth.js';
import { runPortfolioBacktest } from '../quant/portfolioBacktest.js';
import { type MarginFactorName } from '../quant/marginProvider.js';
import {
  buildEventObservations,
  buybackSignalEvents,
  dividendSignalEvents,
  dragonTigerSignalEvents,
  unlockSignalEvents,
  UNLOCK_START_OFFSET_DAYS,
  UNLOCK_WINDOW_DAYS,
} from '../quant/eventPanels.js';
import { detectPatternEvents, PATTERN_NAMES } from '../quant/patternEvents.js';
import { abortOnClientClose } from '../utils/clientAbort.js';
import logger from '../utils/logger.js';
import {
  LedgerFactorInput,
  crossSectionConcurrency,
  crossSectionMaxCodes,
  fetchPanelInputs,
  horizonsOrReject,
  judgeWithActivePolicy,
  ledgerEntriesFromReport,
  parsePortfolioOpts,
  rejectIfAnySimulated,
  resolveUniverse,
  runSnapshot,
} from '../services/quant/panelService.js';

const router = Router();

// 截面因子评估：自动拉取行情/财务/季度财报装配截面观测面板，走既有截面评估器
// （按日跨股票 Spearman + Newey-West + OOS 稳定性）。
// universe 两种来源：
//   - codes：显式给出 2 到上限只股票（上限见 crossSectionMaxCodes，默认 300）；
//   - board：给行业板块代码（BKxxxx），按总市值取前 topN 只成分股——截面拉宽的
//     主路径，让逐日截面 IC 有足够样本量。
// 因子三族：量价（逐日变异）、基本面（年报快照 + 季度派生，每股常数）、
// 事件（PEAD 业绩超预期 + 分红股息率 + 回购力度 + 解禁压力，事件窗口内有效；
// includeEvents=false 可整体关闭事件族）。
// 统计功效取决于横截面宽度：stocksSkipped 与各因子 sampleSize 如实披露，不做掩饰。
router.post(
  '/api/quant/factor/cross-section',
  quantLimiter,
  circuitBreakerGuard,
  async (req, res) => {
    let abort: AbortController | null = null;
    try {
      const body = (req.body ?? {}) as {
        codes?: unknown;
        board?: unknown;
        /** 可选：指数历史成分宇宙（Baostock sidecar；{index, date?}） */
        indexUniverse?: unknown;
        topN?: unknown;
        horizons?: unknown;
        includeFundamental?: unknown;
        includeEvents?: unknown;
        /** 可选：两融因子族（融资余额变化率/拥挤度，PIT + T+1 披露延迟） */
        includeMargin?: unknown;
        /** 可选：为全部因子附带组合回测（top-N 等权周期调仓，宇宙等权基准） */
        portfolio?: unknown;
      };
      // horizons 统一解析（五处共用）：此前只做「every 在 1-250 内」的单元素校验，
      // 无个数上限——16000 个整数约 64KB body 即可通过，每档一轮全截面测算
      const parsedHorizons = horizonsOrReject(body.horizons, res);
      if (!parsedHorizons.ok) return;
      const horizons = parsedHorizons.horizons;
      const includeFundamental = body.includeFundamental !== false;
      // 事件族开关（分红/回购/解禁 + PEAD）：默认开启；关闭可跳过事件源的网络调用
      const includeEvents = body.includeEvents !== false;
      // 两融族开关：默认开启；关闭可跳过两融源的网络调用（与事件同模式）
      const includeMargin = body.includeMargin !== false;
      const portfolioOpts = parsePortfolioOpts(body.portfolio);

      // 预检（在 universe 解析前）：源不可达 + 无任何本地缓存 → 直接 503；
      // 源不可达但有缓存 → 继续走陈旧兜底（板块级精准拦截在 resolveUniverse 内）
      const preflight = await runPreflight();
      const upstreamOk = preflight.checks.find((c) => c.key === 'upstream')?.ok ?? false;
      const cacheOk = preflight.checks.find((c) => c.key === 'cache')?.ok ?? false;
      if (!upstreamOk && !cacheOk) {
        return res.status(503).json({
          error: '行情源不可用且本地缓存为空，无法装配截面',
          detail: preflight.checks.find((c) => c.key === 'upstream')?.detail,
          preflight,
        });
      }

      // universe 解析：指数历史成分 / 板块成分股（拉宽）优先于显式 codes（三路由共用助手）
      const resolved = await resolveUniverse(body, preflight);
      if (!resolved.ok) return res.status(resolved.status).json(resolved.payload);
      const codes = resolved.codes;
      // 幸存者偏差如实声明，按宇宙来源区分口径：
      //  - index 源：成分是历史快照，**本身含其后退市证券**（Baostock 的价值所在），
      //    但行情主表可能已无这些退市股的 K 线——缺 K 线者会被面板如实跳过；
      //  - board/codes 源：主表是当前上市证券，退市股不在场。Tushare 配置时附
      //    退市股名单规模（走 24h 缓存，不碰上游频控；名单仅作核对披露）。
      let survivorshipNote: string;
      if (resolved.universe.source === 'index') {
        survivorshipNote = `成分为指数历史快照（${String(
          resolved.universe.updateDate ?? '最新',
        )}），含其后退市证券；缺 K 线的退市股会被面板如实跳过`;
      } else {
        survivorshipNote = '主表为当前上市证券，历史截面不含已退市股票（幸存者偏差）';
        if (isTushareConfigured()) {
          try {
            const delisted = (await fetchStockBasicCached()).filter(
              (r) => r.listStatus === 'D',
            ).length;
            survivorshipNote += `；已接入 Tushare 退市股名单（${delisted} 只，仅供核对）`;
          } catch {
            /* 名单不可用时保持基础声明 */
          }
        }
      }
      const universe: Record<string, unknown> = {
        ...resolved.universe,
        survivorshipNote,
      };

      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      // 客户端提前断开（取消/关页）→ 级联中止在途取数
      abort = abortOnClientClose(res);
      const { signal } = abort;
      const { inputs, simulatedCodes } = await fetchPanelInputs(codes, {
        start,
        end,
        signal,
        withQuarterly: includeFundamental,
        withEvents: includeEvents,
        withMargin: includeMargin,
      });
      // 客户端已不在：跳过整段 CPU 评估，静默终止（socket 已关闭，无需写响应）
      if (abort.signal.aborted) return;
      // 模拟数据闸门：任一标的是合成 K 线 → 422，不让 IC/t/p 基于合成曲线算出来
      if (rejectIfAnySimulated(simulatedCodes, res)) return;

      const panel = buildCrossSectionPanel(inputs, horizons);
      // 逐持有期附「是否采信」判定（IC 显著 + 分层单调 + 多空价差为正），与
      // /factor/evaluate 路由同口径——前端截面表直接消费
      const evaluateWithVerdict = (obs: FactorObservation[]) => {
        const report = evaluateFactor(obs);
        return {
          ...report,
          byPeriod: report.byPeriod.map((p) => ({ ...p, verdict: judgeWithActivePolicy(p) })),
        };
      };
      // 组合回测（可选）需要各因子的原始观测面板：push 时同步登记
      const factors: { name: string; type: string; report: unknown }[] = [];
      const factorObs = new Map<string, FactorObservation[]>();
      for (const [name, obs] of Object.entries(panel.priceVolume)) {
        if (obs.length < 30) continue; // 样本不足的因子如实跳过（评估器也会拒收）
        factors.push({ name, type: 'price_volume', report: evaluateWithVerdict(obs) });
        factorObs.set(name, obs);
      }
      if (includeFundamental) {
        for (const [name, obs] of Object.entries(panel.fundamental) as [
          FundamentalFactorName,
          FactorObservation[],
        ][]) {
          if (obs.length < 30) continue;
          factors.push({ name, type: 'fundamental', report: evaluateWithVerdict(obs) });
        }
      }

      // 两融族（includeMargin 门控）：PIT + T+1 披露延迟口径；无两融数据的股票
      // 不参与，样本不足的因子如实缺席。单股取数失败已在 fetchPanelInputs 内
      // 降级为空数组——缺一类只是少一个因子，不拖垮其余。
      if (includeMargin) {
        for (const [name, obs] of Object.entries(panel.margin) as [
          MarginFactorName,
          FactorObservation[],
        ][]) {
          if (obs.length < 30) continue;
          factors.push({ name, type: 'margin', report: evaluateWithVerdict(obs) });
        }
      }

      // 事件族（includeEvents 门控）：PEAD 依赖季度财报（includeFundamental 关闭时
      // 自然缺席）；分红/回购/解禁走独立事件数据源。窗口外无观测，样本不足的
      // 因子如实缺席，不强行出报告。
      if (includeEvents) {
        // 业绩超预期（PEAD）：公告窗口内信号有效
        const peadObs: FactorObservation[] = [];
        for (const input of inputs) {
          if (!input.quarterly || input.quarterly.reports.length === 0) continue;
          if (!input.bars || input.bars.length === 0) continue;
          peadObs.push(
            ...buildEarningsSurpriseObservations({
              code: input.code,
              reports: input.quarterly.reports,
              bars: input.bars,
              horizons,
            }),
          );
        }
        if (peadObs.length >= 30) {
          factors.push({
            name: 'ev_earnings_surprise',
            type: 'event',
            report: evaluateWithVerdict(peadObs),
          });
          factorObs.set('ev_earnings_surprise', peadObs);
        }

        // 分红（股息率，公告日后窗口）/ 回购（占总股本比例上限）/ 解禁（负的
        // 占流通市值比，含事件前 20 日的抢跑窗口）。单类失败已在 fetchStockEvents
        // 内降级为空列表——缺一类只是少一个因子，不拖垮其余。
        const dividendObs: FactorObservation[] = [];
        const buybackObs: FactorObservation[] = [];
        const unlockObs: FactorObservation[] = [];
        const dragonObs: FactorObservation[] = [];
        for (const input of inputs) {
          if (!input.bars || input.bars.length === 0 || !input.events) continue;
          const { code, bars, events } = input;
          if (events.dragonTiger) {
            dragonObs.push(
              ...buildEventObservations({
                code,
                events: dragonTigerSignalEvents(events.dragonTiger),
                bars,
                horizons,
              }),
            );
          }
          dividendObs.push(
            ...buildEventObservations({
              code,
              events: dividendSignalEvents(events.dividend, bars),
              bars,
              horizons,
            }),
          );
          buybackObs.push(
            ...buildEventObservations({
              code,
              events: buybackSignalEvents(events.buyback),
              bars,
              horizons,
            }),
          );
          unlockObs.push(
            ...buildEventObservations({
              code,
              events: unlockSignalEvents(events.unlock),
              bars,
              horizons,
              startOffsetDays: UNLOCK_START_OFFSET_DAYS,
              windowDays: UNLOCK_WINDOW_DAYS,
            }),
          );
        }
        const eventFactors: { name: string; obs: FactorObservation[] }[] = [
          { name: 'ev_dividend_yield', obs: dividendObs },
          { name: 'ev_buyback_ratio', obs: buybackObs },
          { name: 'ev_unlock_overhang', obs: unlockObs },
          { name: 'ev_dragon_tiger', obs: dragonObs },
        ];
        for (const { name, obs } of eventFactors) {
          if (obs.length >= 30) {
            factors.push({ name, type: 'event', report: evaluateWithVerdict(obs) });
            factorObs.set(name, obs);
          }
        }

        // 技术形态事件族（借鉴 Sequoia-X）：形态触发日=事件，零额外网络调用。
        // 民间「胜率约 50%」的说法在此变成可测量的 IC / 分层 / OOS。
        for (const pattern of PATTERN_NAMES) {
          const obs: FactorObservation[] = [];
          for (const input of inputs) {
            if (!input.bars || input.bars.length === 0) continue;
            obs.push(
              ...buildEventObservations({
                code: input.code,
                events: detectPatternEvents(pattern, input.bars),
                bars: input.bars,
                horizons,
              }),
            );
          }
          if (obs.length >= 30) {
            factors.push({ name: pattern, type: 'pattern', report: evaluateWithVerdict(obs) });
            factorObs.set(pattern, obs);
          }
        }
      }

      // 因子组合回测（可选）：每个因子「按它交易」的 PnL 视角（宇宙等权基准，
      // top-N 等权周期调仓、A 股成本）。观测面板已就位，这里是纯 CPU。
      if (portfolioOpts) {
        const barsBySymbol = new Map(inputs.map((i) => [i.code, i.bars ?? []]));
        for (const f of factors) {
          const obs = factorObs.get(f.name);
          if (!obs) continue;
          const pf = runPortfolioBacktest(obs, barsBySymbol, portfolioOpts);
          if (pf) (f as { portfolio?: unknown }).portfolio = pf;
        }
      }

      // 实验台账留痕（因子 × 持有期）：写盘失败静默，台账是研究资产不是数据源
      const ledgerInputs = ledgerEntriesFromReport(factors as LedgerFactorInput[], {
        source: 'cross-section',
        universe: {
          requested: typeof universe.requested === 'number' ? universe.requested : codes.length,
          included: panel.stocksIncluded.length,
          ...(typeof universe.board === 'string' ? { board: universe.board } : {}),
          ...(universe.source === 'codes' ? { codes } : {}),
        },
      });
      const ledgerRecorded = recordFactorExperiments(ledgerInputs).length;

      res.json({
        universe,
        stocksIncluded: panel.stocksIncluded,
        stocksSkipped: panel.stocksSkipped,
        horizons,
        factors,
        // 可复现快照：这次是用什么参数/数据区间/版本跑出来的
        run: runSnapshot({
          kind: 'cross-section',
          start,
          end,
          horizons,
          includeFundamental,
          includeEvents,
          concurrency: crossSectionConcurrency(),
          maxCodes: crossSectionMaxCodes(),
        }),
        preflight,
        ledger: { recorded: ledgerRecorded, total: summarizeFactorExperiments().total },
      });
    } catch (error) {
      // 客户端断开引发的 AbortError：socket 已关，写响应无意义，静默终止
      if (abort?.signal.aborted) return;
      logger.error('Cross-section factor error', {
        route: '/api/quant/factor/cross-section',
        err: error,
      });
      res.status(500).json({ error: '截面因子评估失败' });
    }
  },
);

// === 多模型集成投票与置信度校准 ===
// 默认 candidateModels 只取 1 个模型（等价关闭），须显式传 models 或设
// LLM_ENSEMBLE_SIZE>1 才走投票——既有单模型链路零变更。
// 入参口径（P1 修复）：

export default router;

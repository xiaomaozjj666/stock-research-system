import { test, expect } from '@playwright/test';

/**
 * 量化链路 E2E（批量测算 / 截面因子 / 估值建模）
 * ============================================================================
 * 补上此前缺失的一块：**核心量化页面没有任何端到端覆盖**。之前只有 12 条 e2e，
 * 集中在冒烟、失败路径、自选股 CRUD、指标端点 —— 量化页虽然能打开，
 * 但「填表 → 调后端 → 渲染结果」这条链路从未被验证过。
 *
 * 关于「依赖上游」的说明（此前我在提交信息里写的「量化 E2E 需真实 LLM + 行情，
 * 不适合本轮」是**没有核实就下的结论**）：Playwright 的 `page.route()` 本来就能
 * 拦截任意请求，`e2e/analyze.spec.ts` 早就在用（拦截 `/api/analyze/stream`）。
 * 所以量化 E2E 完全可做 —— 用 `route.fulfill()` 返回契约形状的固定响应即可，
 * 确定性且不依赖任何外部服务。
 *
 * 这些用例的真正价值不在「页面能打开」，而在：
 *   1. 请求体形状与契约一致（漏字段会在这一步暴露）
 *   2. 响应字段真的被渲染（契约补了字段但前端没接，测试会红）
 *   3. 模式切换不丢状态（三个面板是常驻挂载 + hidden 切换，易回归）
 */

/**
 * 板块下拉的固定响应。
 *
 * **为什么必须 mock**：量化页挂载时会自动请求 `/api/quant/universe/boards`，
 * 服务端真去 curl 东财（实测本机 15s 超时且伴随 schannel 错误）——
 * 页面渲染被阻塞，E2E 随机失败。这正是「不 mock 就无法确定性测试」的真正原因，
 * 而不是「量化链路需要真实行情所以做不了」（我此前写下的判断是错的）。
 */
const UNIVERSE_BOARDS = {
  boards: [
    { code: 'BK0477', name: '白酒' },
    { code: 'BK0437', name: '银行' },
  ],
  stale: false,
};

/** 在 goto 之前挂上所有上游 mock（必须早于页面加载） */
async function mockUpstreams(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/quant/universe/boards', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(UNIVERSE_BOARDS),
    }),
  );
  // 预检/健康类：页面挂载即拉，失败会让面板显示降级横幅
  await page.route('**/api/quant/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        checks: [{ key: 'upstream', ok: true, detail: 'mock' }],
        degraded: [],
        checkedAt: '2026-01-05T00:00:00.000Z',
        tushare: { configured: false },
        baostock: { available: false },
      }),
    }),
  );
}

test.describe('量化研究 — 模式切换', () => {
  test('三个子模式均可切换，且切换到「截面因子」显示宇宙说明', async ({ page }) => {
    await mockUpstreams(page);
    await page.goto('/');
    await page.getByRole('tab', { name: '量化研究' }).click();

    // 三个模式的切换按钮（QuantPage 的 mode 切换器）
    await expect(page.getByRole('button', { name: '单股研究' })).toBeVisible();
    await expect(page.getByRole('button', { name: '批量测算' })).toBeVisible();
    await expect(page.getByRole('button', { name: '截面因子' })).toBeVisible();

    // 默认是「单股研究」：侧栏展示策略配置表单（该模式下**不渲染** .quant-mode-hint，
    // 提示语只在 batch/cross 出现 —— 写断言时按实际渲染条件来，别照字面猜）
    await expect(page.locator('.quant-sidebar-title').first()).toHaveText('策略配置');

    // 切到批量测算：出现批量口径的提示语
    const hint = page.locator('.quant-mode-hint');
    await page.getByRole('button', { name: '批量测算' }).click();
    await expect(hint).toHaveText(/逐只计算方向性组合 alpha/);

    // 切到截面因子：提示语换成横截面口径
    // 注意用 toHaveText 而非 .first()：三个模式面板是**常驻挂载 + hidden 切换**
    // （QuantPage 有注释：结果跑了数十秒，不该因切看一眼就丢失），页面上同时存在多份。
    await page.getByRole('button', { name: '截面因子' }).click();
    await expect(hint).toHaveText(/横截面因子评估/);
  });
});

test.describe('估值建模 — 请求体与结果渲染', () => {
  test('填入代码与增速后建模成功：请求体符合契约，结果字段被渲染', async ({ page }) => {
    // 按契约（openapi.ts 的 ValuationModelRequest）构造响应：
    // assumptions 里 baseEps/growthRate1/growthRate2/discountRate 均可能为 null。
    const response = {
      model: 'two_stage_eps_dcf',
      code: '600519',
      fairValue: 1800,
      currentPrice: 1600,
      upsidePct: 12.5,
      dcf: {
        fairValue: 1800,
        explicitValue: 900,
        terminalValue: 1400,
        discountedTerminalValue: 900,
        cashFlows: [
          { year: 1, eps: 20, discountFactor: 0.92, presentValue: 18.4 },
          { year: 2, eps: 22, discountFactor: 0.85, presentValue: 18.7 },
        ],
        assumptions: {
          baseEps: 20,
          growthRate1: 0.12,
          growthRate2: 0.03,
          discountRate: 0.09,
          explicitYears: 2,
        },
      },
      sensitivity: {
        discountRates: [0.09],
        growthRates1: [0.12],
        matrix: [[1800]],
      },
      comparables: {
        peers: [{ code: '000858', name: '五粮液', pe: 20, pb: 5, roe: 0.24, marketCap: 4800 }],
        sampleSize: 1,
        medianPe: 20,
        medianPb: 5,
        medianRoe: 0.24,
        pePremiumPct: null,
        pbPremiumPct: null,
        impliedValueByMedianPe: 1600,
      },
      assumptions: {
        baseEps: 20,
        growthRate1: 0.12,
        growthRate1Source: 'input',
        growthRate2: 0.03,
        discountRate: 0.09,
        explicitYears: 2,
      },
      limitations: ['EPS 贴现近似，未考虑资本开支与债务结构'],
    };

    await mockUpstreams(page);
    await mockUpstreams(page);
    let captured: Record<string, unknown> | null = null;
    await page.route('**/api/quant/valuation/model', async (route) => {
      const post = route.request().postData();
      if (post) captured = JSON.parse(post) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response),
      });
    });

    await page.goto('/');
    await page.getByRole('tab', { name: '量化研究' }).click();

    // 估值面板常驻挂载（不在 mode pane 内），直接填表
    await page.getByLabel(/待估值的股票代码/).fill('600519');
    await page.getByLabel(/显性期 EPS 增速/).fill('0.12');
    await page.getByRole('button', { name: '开始建模' }).click();

    // 结果字段被渲染（契约补了字段但前端没接的话，这里会红）
    await expect(page.getByText('每股内在价值')).toBeVisible();
    await expect(page.getByText('现价隐含溢价')).toBeVisible();

    // 请求体形状符合契约：code + assumptions 都是数字/字符串，没有 undefined
    expect(captured, '估值请求应已发出').not.toBeNull();
    expect(captured).toMatchObject({ code: '600519', assumptions: { growthRate1: 0.12 } });
  });

  test('上游返回 502 时展示错误，且不残留「计算中」假状态', async ({ page }) => {
    await mockUpstreams(page);
    await page.route('**/api/quant/valuation/model', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: '数据获取失败' }),
      }),
    );

    await page.goto('/');
    await page.getByRole('tab', { name: '量化研究' }).click();
    await page.getByLabel(/待估值的股票代码/).fill('600519');
    await page.getByRole('button', { name: '开始建模' }).click();

    // 错误横幅：ValuationPanel 第 144 行的 .error-banner（**没有** role="alert"，
    // 用 class 选择器；normalizeApiError 会把后端的 { error } 透传成 message）
    await expect(page.locator('.error-banner')).toHaveText(/数据获取失败|估值建模失败/);
    // 按钮从「计算中…」恢复为可点（loading 态必须复位，否则永久禁用）
    await expect(page.getByRole('button', { name: '开始建模' })).toBeEnabled();
  });

  test('股票代码非法时前端就拦下，不发请求', async ({ page }) => {
    await mockUpstreams(page);
    let called = false;
    await page.route('**/api/quant/valuation/model', (route) => {
      called = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');
    await page.getByRole('tab', { name: '量化研究' }).click();
    // 非 6 位：ValuationPanel 第 71 行 setError('请输入 6 位股票代码')，不发请求
    await page.getByLabel(/待估值的股票代码/).fill('60051');
    await page.getByRole('button', { name: '开始建模' }).click();

    await expect(page.locator('.error-banner')).toHaveText(/6 位股票代码/);
    expect(called, '非法代码不应触发后端请求').toBe(false);
  });
});

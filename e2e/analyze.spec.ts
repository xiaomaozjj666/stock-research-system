import { test, expect } from '@playwright/test';

/**
 * 分析流程的失败路径 E2E（此前完全未覆盖）
 * ----------------------------------------------------------------------------
 * 为什么用 page.route 拦截、而不是打真实上游：
 *  - 真实 `/api/analyze/stream` 依赖东方财富等外部数据源与 LLM key，CI 里常年
 *    不可达/无凭证，断言会退化成「等超时」，既慢又不稳定；
 *  - 失败路径恰恰是**最需要被测**、却最容易被跳过的那条：请求失败后 UI 到底弹不弹
 *    错误、能不能重试、失败后有没有留下「分析中」的假状态，只有真的驱动浏览器才知道；
 *  - 把「后端挂掉」变成确定事件后，这条用例稳定且快，覆盖的仍是**真实前端代码路径**
 *    （EventSource → 客户端退避重连 → 错误归一化 → 错误横幅 → 重试）。
 *
 * 客户端的失败时序（client.ts analyzeStockStream，读代码得出，不要想当然）：
 *  收到 5xx 后 onerror 里**先 es.close() 再由应用自己重连**（指数退避 1s/2s/4s，
 *  maxRetries=3），因此单次「点分析」总共会打 4 次请求才判定失败，约 7 秒。
 * 下面的断言据此只校验「至少打过一次」与「重试后次数增加」，不写死具体次数——
 * 写死会把重试次数这种可调参数变成测试的耦合点。
 */

test.describe('分析流程失败路径', () => {
  test('后端持续失败时展示错误横幅，并可对同一股票重试', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/analyze/stream**', async (route) => {
      attempts += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: '上游数据源不可用' }),
      });
    });

    await page.goto('/');
    const search = page.getByPlaceholder(/输入股票代码或名称/);
    await search.fill('600519');
    const analyzeBtn = page.getByRole('button', { name: /^开始分析|^分析中/ });
    await expect(analyzeBtn).toBeEnabled({ timeout: 10_000 });
    await analyzeBtn.click();

    // ① 失败必须被看见：role="alert" 的错误横幅（应用级与对话级 alert 在本场景不渲染）
    const banner = page.getByRole('alert');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).not.toHaveText('');

    // ② 确认真发过请求（避免「什么都没发就报错」的假通过）
    expect(attempts).toBeGreaterThanOrEqual(1);

    // ③ 失败后不把人困死：给出针对该股票的重试入口
    const retry = page.getByRole('button', { name: /重试\s*600519/ });
    await expect(retry).toBeVisible();

    // ④ 重试确实会重新发起请求，而不是清掉错误就结束
    const before = attempts;
    await retry.click();
    await expect.poll(() => attempts, { timeout: 20_000 }).toBeGreaterThan(before);
  });

  test('失败后 loading 状态必须复位，不残留「分析中」假状态', async ({ page }) => {
    await page.route('**/api/analyze/stream**', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '服务繁忙' }),
      });
    });

    await page.goto('/');
    const search = page.getByPlaceholder(/输入股票代码或名称/);
    await search.fill('000001');
    const analyzeBtn = page.getByRole('button', { name: /^开始分析|^分析中/ });
    await expect(analyzeBtn).toBeEnabled({ timeout: 10_000 });
    await analyzeBtn.click();

    await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });

    // 关键回归点：按钮必须回到「开始分析」可点击态。
    // 流式分析最容易出的状态泄漏就在这里——loading 没复位会永远卡在「分析中」，
    // 用户既看不到错误也发起不了下一次，而这一层单测完全测不到。
    await expect(analyzeBtn).toBeEnabled({ timeout: 20_000 });
    await expect(analyzeBtn).toHaveText(/开始分析/);

    // 复位后确实能再次发起（不是只把文案改了回去）
    let attempts = 0;
    await page.unroute('**/api/analyze/stream**');
    await page.route('**/api/analyze/stream**', async (route) => {
      attempts += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: '仍然失败' }),
      });
    });
    await analyzeBtn.click();
    await expect.poll(() => attempts, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  });

  test('非 6 位代码不发起请求（前置校验拦在网络层之前）', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/analyze/stream**', async (route) => {
      attempts += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');
    const search = page.getByPlaceholder(/输入股票代码或名称/);
    await search.fill('abcdef');

    // 非法输入时按钮保持禁用（StockSelector：disabled={loading || !effectiveCode}）
    const analyzeBtn = page.getByRole('button', { name: /^开始分析|^分析中/ });
    await expect(analyzeBtn).toBeDisabled({ timeout: 10_000 });
    expect(attempts).toBe(0);
  });
});

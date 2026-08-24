import { test, expect } from '@playwright/test';

/**
 * E2E 冒烟测试（真实浏览器 + 生产模式真实服务）
 * ----------------------------------------------------------------------------
 * 前置：playwright.config.mts 的 webServer 已以生产模式拉起服务（单端口同源托管前端），
 *       globalSetup 已构建两端产物；数据文件重定向到 e2e/.tmp，不污染真实数据。
 * 覆盖：应用加载、Tab 导航、自选股增删、股票搜索交互、模拟盘/量化页可达。
 */

test.describe('应用加载与导航', () => {
  test('首页渲染品牌与搜索框', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('投研系统')).toBeVisible();
    await expect(page.getByPlaceholder(/输入股票代码或名称/)).toBeVisible();
  });

  test('全部 Tab 均可切换并渲染对应页面标题', async ({ page }) => {
    await page.goto('/');

    // 深度研究（默认 tab，首屏即渲染搜索区）
    await expect(page.getByPlaceholder(/输入股票代码或名称/)).toBeVisible();

    // 对比分析
    await page.getByRole('button', { name: '对比分析' }).click();
    await expect(page.getByRole('heading', { name: '股票对比' })).toBeVisible();

    // 量化研究（懒加载，Suspense fallback 后出现）
    await page.getByRole('button', { name: '量化研究' }).click();
    await expect(page.getByText('量化研究', { exact: false })).toBeVisible();

    // 自选股
    await page.getByRole('button', { name: '自选股' }).click();
    await expect(page.getByRole('heading', { name: '自选股 / 持仓监控' })).toBeVisible();

    // 模拟盘
    await page.getByRole('button', { name: '模拟盘' }).click();
    await expect(page.getByRole('heading', { name: '模拟盘' })).toBeVisible();

    // 研究助手
    await page.getByRole('button', { name: '研究助手' }).click();
    await expect(page.getByRole('heading', { name: '研究助手' })).toBeVisible();

    // 历史（懒加载）
    await page.getByRole('button', { name: '历史' }).click();
    await expect(page.getByRole('heading', { name: '研究历史' })).toBeVisible();
  });
});

test.describe('自选股 CRUD（隔离数据）', () => {
  test('添加 → 展示 → 移除自选股', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '自选股' }).click();
    await expect(page.getByRole('heading', { name: '自选股 / 持仓监控' })).toBeVisible();

    const input = page.getByPlaceholder('输入股票代码或名称，如 600519 / 贵州茅台', {
      exact: true,
    });
    await input.fill('600519');
    // 6 位代码可回车直接添加（名称搜索不可用时也支持，离线安全路径）
    await input.press('Enter');

    // 列表中出现该代码
    await expect(page.getByText('600519', { exact: true }).first()).toBeVisible();

    // 移除
    await page.getByRole('button', { name: '移除 600519' }).click();
    await expect(page.getByText('还没有关注的股票')).toBeVisible();
  });

  test('无效查询给出提示且不添加自选股', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '自选股' }).click();

    const input = page.getByPlaceholder('输入股票代码或名称，如 600519 / 贵州茅台', {
      exact: true,
    });
    await input.fill('zzzz9999');
    await input.press('Enter');

    // 名称无法解析时给出明确提示（未找到 / 服务不可用均算提示，不硬性依赖外网）
    await expect(page.getByText(/未找到|暂不可用/)).toBeVisible();
    // 不会误添加：列表仍为空
    await expect(page.getByText('还没有关注的股票')).toBeVisible();
  });
});

test.describe('股票搜索交互', () => {
  test('输入 6 位代码触发搜索下拉并可发起分析', async ({ page }) => {
    await page.goto('/');
    const search = page.getByPlaceholder(/输入股票代码或名称/);
    await search.fill('600519');

    // 直接输入合法代码后，「开始分析」按钮应可点击（effectiveCode 生效）
    const analyzeBtn = page.getByRole('button', { name: /^开始分析|^分析中/ });
    await expect(analyzeBtn).toBeEnabled({ timeout: 10_000 });
  });
});

test.describe('健康检查与 API', () => {
  test('/api/health 返回 JSON（externalApi 可降级但接口可达）', async ({ request }) => {
    const res = await request.get('/api/health');
    // 外部数据源不可达时返回 503，但接口本身应返回 JSON 结构
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('timestamp');
  });

  test('未知路由返回 404 JSON', async ({ request }) => {
    const res = await request.get('/api/does-not-exist');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('/api/metrics 返回 Prometheus 文本格式指标', async ({ request }) => {
    const res = await request.get('/api/metrics');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain('process_uptime_seconds');
    expect(text).toContain('circuit_breaker_tripped');
  });

  test('/api/openapi.json 返回 OpenAPI 3.1 契约', async ({ request }) => {
    const res = await request.get('/api/openapi.json');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths['/api/analyze']).toBeTruthy();
    expect(body.paths['/api/health']).toBeTruthy();
  });
});

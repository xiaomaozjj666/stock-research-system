import { test } from '@playwright/test';

test('screenshot chat panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '研究助手' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-screenshots/chat-empty.png' });

  // 模拟一条用户+助手对话（直接发一条真实消息，看回复/气泡样式）
  const ta = page.getByLabel('对话输入');
  await ta.fill('600519 怎么看');
  await ta.press('Enter');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'test-screenshots/chat-reply.png' });

  // 打开研究增强面板
  await page.getByRole('button', { name: '研究增强' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-screenshots/chat-enhance.png' });
});

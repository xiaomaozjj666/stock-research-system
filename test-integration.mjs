import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  // Go to the frontend
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'test-screenshots/01-initial.png', fullPage: false });
  console.log('✓ Initial page loaded');

  // Check if navbar is visible
  const navbar = await page.$('.navbar');
  console.log('✓ Navbar visible:', !!navbar);

  // Check if select exists
  const select = await page.$('.navbar select');
  console.log('✓ Stock selector visible:', !!select);

  // Check if button exists
  const btn = await page.$('.btn-primary');
  console.log('✓ Analyze button visible:', !!btn);

  // Click the analyze button
  await btn?.click();
  console.log('✓ Clicked analyze button, waiting for loading screen...');

  // Wait for loading screen
  await page.waitForTimeout(1000);
  const loading = await page.$('.loading-screen');
  console.log('✓ Loading screen visible:', !!loading);
  await page.screenshot({ path: 'test-screenshots/02-loading.png', fullPage: false });

  // Wait for results (up to 120 seconds)
  console.log('Waiting for analysis results (may take 1-2 minutes)...');
  try {
    await page.waitForSelector('.report-header', { timeout: 120000 });
    console.log('✓ Report header appeared!');
    await page.screenshot({ path: 'test-screenshots/03-report-header.png', fullPage: false });

    // Scroll down and capture sections
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-screenshots/04-summary.png', fullPage: false });

    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-screenshots/05-financial.png', fullPage: false });

    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-screenshots/06-charts.png', fullPage: false });

    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-screenshots/07-valuation.png', fullPage: false });

    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-screenshots/08-experts.png', fullPage: false });

    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-screenshots/09-scoring.png', fullPage: false });

    // Check for console errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    
    // Check if key sections exist
    const sections = await page.evaluate(() => {
      const checks = {
        reportHeader: !!document.querySelector('.report-header'),
        coreSummary: !!document.querySelector('.core-summary-grid'),
        financeTable: !!document.querySelector('.finance-table'),
        charts: !!document.querySelector('.charts-grid'),
        valuation: !!document.querySelector('.val-cards'),
        scoring: !!document.querySelector('.scoring-row'),
        controversy: !!document.querySelector('.controversy-card'),
        experts: !!document.querySelector('.expert-panel'),
        risks: !!document.querySelector('.risk-item'),
        reflection: !!document.querySelector('.reflection-item'),
        followup: !!document.querySelector('.followup-item'),
      };
      return checks;
    });
    
    console.log('\n=== Section Render Check ===');
    for (const [key, val] of Object.entries(sections)) {
      console.log(`  ${val ? '✓' : '✗'} ${key}: ${val}`);
    }

    if (errors.length > 0) {
      console.log('\n=== Console Errors ===');
      errors.forEach(e => console.log('  ERROR:', e));
    } else {
      console.log('\n✓ No console errors!');
    }

  } catch (e) {
    console.log('✗ Timeout waiting for results:', e.message);
    await page.screenshot({ path: 'test-screenshots/timeout.png', fullPage: false });
  }

  await browser.close();
  console.log('\nDone!');
})();

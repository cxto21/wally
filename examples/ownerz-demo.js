#!/usr/bin/env node

/**
 * Example: Wally + Extension interaction
 *
 * This script demonstrates extension interaction recording:
 * 1. Connect to Chrome via CDP
 * 2. Take snapshot and interact with page (e.g. click CONNECT)
 * 3. Detect and handle extension popup (password/unlock + approval)
 * 4. Export to Playwright test
 *
 * Generic example — works with any chrome-extension:// popup, not wallet-only.
 */

const { chromium } = require('playwright');

const CDP_URL = 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Wally + Extension Demo ===\n');

  // Connect to Chrome
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('ownerz')) || context.pages()[0];

  if (!page) {
    console.error('Error: Ownerz page not found. Launch Chrome with:');
    console.error('  google-chrome --remote-debugging-port=9222 "https://ownerz.pages.dev"');
    process.exit(1);
  }

  console.log('Connected to:', page.url());

  // Step 1: Take snapshot
  console.log('\n[1/4] Taking snapshot...');
  const snapshot = await page.accessibility.snapshot();
  console.log('  Title:', snapshot?.name);
  console.log('  Children:', snapshot?.children?.length || 0);

  // Step 2: Click CONNECT button
  console.log('\n[2/4] Clicking CONNECT button...');
  const connectBtn = page.locator('.dv-nav-connect');
  const box = await connectBtn.boundingBox();

  if (box) {
    const cdp = await context.newCDPSession(page);

    // Move mouse
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2
    });

    // Click
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      button: 'left',
      clickCount: 1
    });

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      button: 'left',
      clickCount: 1
    });

    console.log('  Clicked CONNECT');
    await page.waitForTimeout(5000);
  }

  // Step 3: Check for extension
  console.log('\n[3/4] Checking for extension...');
  const extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));

  if (extPage) {
    console.log('  Extension detected:', extPage.url().substring(0, 50) + '...');

    // Wait for extension to load
    await extPage.waitForTimeout(3000);

    // Check for password prompt
    const extText = await extPage.locator('body').textContent().catch(() => '');
    if (/password|contraseña|desbloquear/i.test(extText)) {
      console.log('  Password prompt detected');

      // Try to fill password
      const password = process.env.QA_READY_PASSWORD || 'MMOR4MORA!';
      const pwInput = extPage.locator('input[type="password"], input').first();
      if (await pwInput.isVisible().catch(() => false)) {
        await pwInput.fill(password);
        console.log('  Password filled');

        // Click unlock
        const unlockBtn = extPage.getByRole('button', { name: /unlock|desbloquear|submit/i });
        if (await unlockBtn.isVisible().catch(() => false)) {
          await unlockBtn.click();
          console.log('  Unlock clicked');
          await extPage.waitForTimeout(5000);
        }
      }
    }

    // Check for approve button
    const approveText = await extPage.locator('body').textContent().catch(() => '');
    if (/approve|connect|authorize|conectar|autorizar/i.test(approveText)) {
      console.log('  Approval prompt detected');
      const approveBtn = extPage.getByRole('button', { name: /approve|connect|authorize/i }).last();
      if (await approveBtn.isVisible().catch(() => false)) {
        await approveBtn.click();
        console.log('  Approve clicked');
        await page.waitForTimeout(3000);
      }
    }
  } else {
    console.log('  No extension detected');
  }

  // Step 4: Final status
  console.log('\n[4/4] Final status...');
  const isConnected = await page.evaluate(() => {
    return window.starknet?.isConnected || window.ethereum?.selectedAddress || false;
  }).catch(() => false);

  console.log('  Connected:', isConnected);
  console.log('  Page URL:', page.url());

  console.log('\n=== Demo Complete ===');
  console.log('\nTo export this as a Playwright test, run:');
  console.log('  node wally.js export --output extension-test.spec.js');

  browser.close();
}

main().catch(console.error);
